import express, { Response } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';
import {
  ApplianceSelection,
  calculateLoadAssessment,
  loadCatalogueSelections,
} from '../services/loadAssessment.js';

const router = express.Router();
router.use(authenticateToken);

function parseSelections(value: unknown): ApplianceSelection[] {
  if (!Array.isArray(value)) throw new Error('Appliance selections must be an array.');
  return value.map((item: any) => ({
    applianceId: Number(item?.applianceId),
    quantity: Number(item?.quantity),
    simultaneousQuantity: Number(item?.simultaneousQuantity),
    ...(item?.ratedPowerOverrideW !== undefined
      ? { ratedPowerOverrideW: Number(item.ratedPowerOverrideW) }
      : {}),
  }));
}

router.get('/appliances', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, name, category, rated_power_w AS "ratedPowerW",
              power_factor AS "powerFactor",
              starting_surge_multiplier AS "startingSurgeMultiplier",
              is_estimate AS "isEstimate"
       FROM appliance_catalogue WHERE is_active = TRUE ORDER BY category, name`
    );
    return res.json({ success: true, appliances: result.rows });
  } catch (error) {
    console.error('Appliance catalogue error:', error);
    return res.status(500).json({ success: false, error: 'Unable to load appliance catalogue.' });
  }
});

// Source owner configures the actual continuous, apparent and surge capacities.
// A source cannot reduce its limits below already-approved customer allocations.
router.put('/sources/:sourceId/capacity', async (req: AuthenticatedRequest, res: Response) => {
  const sourceId = Number(req.params.sourceId);
  const { maxCapacityW, maxCapacityVa, maxSurgeVa, safetyMarginPct } = req.body || {};
  const values = [maxCapacityW, maxCapacityVa, maxSurgeVa, safetyMarginPct].map(Number);
  if (!Number.isInteger(sourceId) || sourceId <= 0 ||
      values.some(v => !Number.isFinite(v)) ||
      values[0] <= 0 || values[1] <= 0 || values[2] <= 0 || values[3] < 0 || values[3] > 100) {
    return res.status(400).json({ success: false, error: 'Provide positive W, VA and surge capacities, and a safety margin from 0% to 100%.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const source = await client.query(
      `SELECT id FROM energy_sources WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
      [sourceId, req.user!.userId]
    );
    if (!source.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Energy source not found in your account.' });
    }
    const allocated = await client.query(
      `SELECT COALESCE(SUM(approved_power_w), 0) AS watts,
              COALESCE(SUM(approved_apparent_va), 0) AS va,
              COALESCE(SUM(approved_starting_surge_va), 0) AS surge
       FROM customer_connections
       WHERE source_id = $1 AND status IN ('APPROVED', 'PENDING_REVISION')
         AND approved_power_w IS NOT NULL`,
      [sourceId]
    );
    const used = allocated.rows[0];
    if (Number(used.watts) > values[0] || Number(used.va) > values[1] || Number(used.surge) > values[2]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'New capacity is below the load already approved for connected customers.' });
    }
    const updated = await client.query(
      `UPDATE energy_sources
       SET max_capacity_w = $2, max_capacity_va = $3, max_surge_va = $4,
           safety_margin_pct = $5, updated_at = NOW()
       WHERE id = $1
       RETURNING max_capacity_w AS "maxCapacityW", max_capacity_va AS "maxCapacityVa",
                 max_surge_va AS "maxSurgeVa", safety_margin_pct AS "safetyMarginPct"`,
      [sourceId, ...values]
    );
    await client.query('COMMIT');
    return res.json({ success: true, capacity: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Update source capacity error:', error);
    return res.status(500).json({ success: false, error: 'Unable to update energy source capacity.' });
  } finally {
    client.release();
  }
});

// Customer declares appliances and requests a connection to a listed source.
router.post('/requests', async (req: AuthenticatedRequest, res: Response) => {
  const customerId = req.user!.userId;
  const sourceId = Number(req.body?.sourceId);
  let selections: ApplianceSelection[];
  try {
    selections = parseSelections(req.body?.appliances);
  } catch (error: any) {
    return res.status(400).json({ success: false, error: error.message });
  }
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    return res.status(400).json({ success: false, error: 'A valid sourceId is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sourceRes = await client.query(
      `SELECT id, owner_id, status, max_capacity_w, max_capacity_va, max_surge_va, safety_margin_pct
       FROM energy_sources WHERE id = $1 FOR UPDATE`,
      [sourceId]
    );
    if (!sourceRes.rows.length || sourceRes.rows[0].status !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Active energy source not found.' });
    }
    const source = sourceRes.rows[0];
    if (Number(source.owner_id) === customerId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'You cannot request a connection to your own energy source.' });
    }
    if ([source.max_capacity_w, source.max_capacity_va, source.max_surge_va, source.safety_margin_pct].some(v => v === null)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'SOURCE_CAPACITY_NOT_CONFIGURED', error: 'The energy source owner must configure its electrical capacity before connection requests can be assessed.' });
    }
    const catalogue = await loadCatalogueSelections(selections);
    const assessment = calculateLoadAssessment(selections, catalogue, Number(source.safety_margin_pct));
    const request = await client.query(
      `INSERT INTO customer_connections
       (source_id, customer_id, requested_power_w,
        requested_apparent_va, requested_starting_surge_va, safety_margin_pct)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, status, requested_power_w AS "requestedPowerW",
         requested_apparent_va AS "requestedApparentVa",
         requested_starting_surge_va AS "requestedStartingSurgeVa",
         safety_margin_pct AS "safetyMarginPct", requested_at AS "requestedAt"`,
      [sourceId, customerId, assessment.requestedPowerW,
       assessment.requestedApparentVa, assessment.requestedStartingSurgeVa, Number(source.safety_margin_pct)]
    );
    const connectionId = request.rows[0].id;
    for (const item of selections) {
      await client.query(
        `INSERT INTO customer_connection_appliances
         (connection_id, appliance_id, quantity, simultaneous_quantity, rated_power_override_w)
         VALUES ($1, $2, $3, $4, $5)`,
        [connectionId, item.applianceId, item.quantity, item.simultaneousQuantity, item.ratedPowerOverrideW ?? null]
      );
    }
    await client.query('COMMIT');
    return res.status(201).json({ success: true, connection: request.rows[0], assessment });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    const message = error?.message || 'Unable to create connection request.';
    return res.status(400).json({ success: false, error: message });
  } finally {
    client.release();
  }
});

// Customer sees their requests; prosumer sees requests for a source they own.
router.get('/me', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.source_id AS "sourceId", s.name AS "sourceName",
              s.owner_id AS "sourceOwnerId",
              c.customer_id AS "customerId", c.receiving_device_id AS "receivingDeviceId",
              c.status, c.requested_power_w AS "requestedPowerW",
              c.requested_apparent_va AS "requestedApparentVa",
              c.requested_starting_surge_va AS "requestedStartingSurgeVa",
              c.approved_power_w AS "approvedPowerW",
              c.approved_apparent_va AS "approvedApparentVa",
              c.approved_starting_surge_va AS "approvedStartingSurgeVa",
              c.safety_margin_pct AS "safetyMarginPct", c.decision_note AS "decisionNote",
              c.requested_at AS "requestedAt", c.decided_at AS "decidedAt",
              s.max_capacity_w AS "sourceCapacityW",
              s.max_capacity_va AS "sourceCapacityVa",
              s.max_surge_va AS "sourceSurgeCapacityVa",
              COALESCE((
                SELECT json_agg(json_build_object(
                  'applianceId', ca.appliance_id,
                  'name', ac.name,
                  'category', ac.category,
                  'quantity', ca.quantity,
                  'simultaneousQuantity', ca.simultaneous_quantity,
                  'ratedPowerW', COALESCE(ca.rated_power_override_w, ac.rated_power_w),
                  'isEstimate', ac.is_estimate
                ) ORDER BY ac.category, ac.name)
                FROM customer_connection_appliances ca
                JOIN appliance_catalogue ac ON ac.id = ca.appliance_id
                WHERE ca.connection_id = c.id
              ), '[]'::json) AS appliances
       FROM customer_connections c JOIN energy_sources s ON s.id = c.source_id
       WHERE c.customer_id = $1 OR s.owner_id = $1
       ORDER BY c.requested_at DESC`,
      [req.user!.userId]
    );
    return res.json({ success: true, connections: result.rows });
  } catch (error) {
    console.error('List customer connections error:', error);
    return res.status(500).json({ success: false, error: 'Unable to load connection requests.' });
  }
});

router.post('/:id/decision', async (req: AuthenticatedRequest, res: Response) => {
  const connectionId = Number(req.params.id);
  const decision = String(req.body?.decision || '').toUpperCase();
  const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
  if (!Number.isInteger(connectionId) || connectionId <= 0 || !['APPROVE', 'REJECT'].includes(decision)) {
    return res.status(400).json({ success: false, error: 'A valid connection ID and APPROVE or REJECT decision are required.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const initial = await client.query(
      'SELECT source_id FROM customer_connections WHERE id = $1',
      [connectionId]
    );
    if (!initial.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Connection request not found.' });
    }
    const sourceId = Number(initial.rows[0].source_id);
    const sourceRes = await client.query(
      `SELECT id, owner_id, max_capacity_w, max_capacity_va, max_surge_va
       FROM energy_sources WHERE id = $1 FOR UPDATE`,
      [sourceId]
    );
    if (!sourceRes.rows.length || Number(sourceRes.rows[0].owner_id) !== req.user!.userId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Connection request not found in your energy sources.' });
    }
    const connectionRes = await client.query(
      'SELECT * FROM customer_connections WHERE id = $1 AND source_id = $2 FOR UPDATE',
      [connectionId, sourceId]
    );
    const connection = connectionRes.rows[0];
    if (!['PENDING', 'PENDING_REVISION'].includes(connection.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'This connection request is not awaiting a decision.' });
    }

    if (decision === 'REJECT') {
      const nextStatus = connection.status === 'PENDING_REVISION' ? 'APPROVED' : 'REJECTED';
      await client.query(
        `UPDATE customer_connections SET status = $2, decision_note = $3,
           decided_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [connectionId, nextStatus, note || 'Request rejected by energy source owner.']
      );
      await client.query('COMMIT');
      return res.json({ success: true, status: nextStatus, message: nextStatus === 'APPROVED' ? 'The increased load was rejected. The previously approved limit remains active.' : 'Connection request rejected.' });
    }

    const allocated = await client.query(
      `SELECT COALESCE(SUM(approved_power_w), 0) AS watts,
              COALESCE(SUM(approved_apparent_va), 0) AS va,
              COALESCE(SUM(approved_starting_surge_va), 0) AS surge
       FROM customer_connections
       WHERE source_id = $1 AND id <> $2
         AND status IN ('APPROVED', 'PENDING_REVISION')
         AND approved_power_w IS NOT NULL`,
      [sourceId, connectionId]
    );
    const used = allocated.rows[0];
    const nextW = Number(connection.requested_power_w);
    const nextVa = Number(connection.requested_apparent_va);
    const nextSurge = Number(connection.requested_starting_surge_va);
    const source = sourceRes.rows[0];
    if (Number(used.watts) + nextW > Number(source.max_capacity_w) ||
        Number(used.va) + nextVa > Number(source.max_capacity_va) ||
        Number(used.surge) + nextSurge > Number(source.max_surge_va)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'SOURCE_CAPACITY_EXCEEDED', error: 'This request exceeds the source capacity remaining after existing approved customer allocations.' });
    }
    await client.query(
      `UPDATE customer_connections
       SET status = 'APPROVED', approved_power_w = requested_power_w,
           approved_apparent_va = requested_apparent_va,
           approved_starting_surge_va = requested_starting_surge_va,
           decision_note = $2, decided_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [connectionId, note]
    );
    await client.query('COMMIT');
    return res.json({ success: true, status: 'APPROVED', approvedPowerW: nextW, approvedApparentVa: nextVa, approvedStartingSurgeVa: nextSurge });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Connection decision error:', error);
    return res.status(500).json({ success: false, error: 'Unable to process connection decision.' });
  } finally {
    client.release();
  }
});

// Customers may revise appliance declarations. An increase is held for owner approval;
// the existing approved allocation remains active until the revision is approved.
router.put('/:id/appliances', async (req: AuthenticatedRequest, res: Response) => {
  const connectionId = Number(req.params.id);
  let selections: ApplianceSelection[];
  try { selections = parseSelections(req.body?.appliances); }
  catch (error: any) { return res.status(400).json({ success: false, error: error.message }); }
  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid connection ID.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const connectionRes = await client.query(
      `SELECT c.*, s.safety_margin_pct FROM customer_connections c
       JOIN energy_sources s ON s.id = c.source_id
       WHERE c.id = $1 AND c.customer_id = $2 FOR UPDATE OF c`,
      [connectionId, req.user!.userId]
    );
    if (!connectionRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Connection not found in your account.' });
    }
    const connection = connectionRes.rows[0];
    if (!['PENDING', 'APPROVED', 'PENDING_REVISION'].includes(connection.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'This connection can no longer be edited.' });
    }
    const catalogue = await loadCatalogueSelections(selections);
    const assessment = calculateLoadAssessment(selections, catalogue, Number(connection.safety_margin_pct));
    const exceedsApproved = connection.approved_power_w !== null &&
      (assessment.requestedPowerW > Number(connection.approved_power_w) ||
       assessment.requestedApparentVa > Number(connection.approved_apparent_va) ||
       assessment.requestedStartingSurgeVa > Number(connection.approved_starting_surge_va));

    await client.query('DELETE FROM customer_connection_appliances WHERE connection_id = $1', [connectionId]);
    for (const item of selections) {
      await client.query(
        `INSERT INTO customer_connection_appliances
         (connection_id, appliance_id, quantity, simultaneous_quantity, rated_power_override_w)
         VALUES ($1, $2, $3, $4, $5)`,
        [connectionId, item.applianceId, item.quantity, item.simultaneousQuantity, item.ratedPowerOverrideW ?? null]
      );
    }

    const status = connection.approved_power_w === null
      ? 'PENDING'
      : exceedsApproved ? 'PENDING_REVISION' : 'APPROVED';
    await client.query(
      `UPDATE customer_connections
       SET requested_power_w = $2, requested_apparent_va = $3,
           requested_starting_surge_va = $4, status = $5,
           decided_at = CASE WHEN $5 = 'PENDING_REVISION' THEN NULL ELSE decided_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [connectionId, assessment.requestedPowerW, assessment.requestedApparentVa, assessment.requestedStartingSurgeVa, status]
    );
    if (status === 'APPROVED') {
      await client.query(
        `UPDATE customer_connections
         SET approved_power_w = $2, approved_apparent_va = $3,
             approved_starting_surge_va = $4
         WHERE id = $1`,
        [connectionId, assessment.requestedPowerW, assessment.requestedApparentVa, assessment.requestedStartingSurgeVa]
      );
    }
    await client.query('COMMIT');
    return res.json({
      success: true,
      status,
      assessment,
      message: status === 'PENDING_REVISION'
        ? 'Your increased load is awaiting prosumer approval. Your previous approved limit remains active.'
        : 'Appliance declaration updated.',
    });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Update connection appliances error:', error);
    return res.status(400).json({ success: false, error: error?.message || 'Unable to update appliance declaration.' });
  } finally {
    client.release();
  }
});

export default router;
