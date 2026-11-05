import express, { Request, Response } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/:deviceId/assign', authenticateToken, requireRole(['OWNER']), async (req: AuthenticatedRequest, res: Response) => {
  const deviceId = String(req.params.deviceId ?? '').trim();
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';

  if (!deviceId || deviceId.length < 3 || !email) {
    return res.status(400).json({ success: false, error: 'A valid device ID and account email are required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: number }>(
      'SELECT id FROM users WHERE LOWER(email) = $1 FOR UPDATE',
      [email]
    );
    if (user.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Account not found.' });
    }

    const device = await client.query(
      'SELECT 1 FROM devices WHERE device_id = $1',
      [deviceId]
    );
    if (device.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Registered meter not found.' });
    }

    const inserted = await client.query(
      `INSERT INTO user_devices (user_id, device_id, is_selected)
       VALUES ($1, $2, NOT EXISTS (
         SELECT 1 FROM user_devices WHERE user_id = $1 AND is_selected = true
       ))
       ON CONFLICT (user_id, device_id) DO NOTHING
       RETURNING device_id`,
      [user.rows[0].id, deviceId]
    );

    if (inserted.rows.length === 0) {
      const currentOwner = await client.query<{ email: string }>(
        `SELECT u.email FROM user_devices ud JOIN users u ON u.id = ud.user_id
         WHERE ud.device_id = $1`,
        [deviceId]
      );
      await client.query('ROLLBACK');
      if (currentOwner.rows[0]?.email.toLowerCase() === email) {
        return res.status(409).json({ success: false, error: 'This meter is already linked to that account.' });
      }
      return res.status(409).json({ success: false, error: 'This meter is already linked to another account.' });
    }

    await client.query('COMMIT');
    return res.status(201).json({ success: true, deviceId, email });
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError) => {
      console.error('Failed to rollback meter assignment:', rollbackError);
    });
    console.error(`Admin meter assignment failed for ${deviceId}:`, error);
    return res.status(500).json({ success: false, error: 'Failed to link meter to account.' });
  } finally {
    client.release();
  }
});

router.put('/:deviceId/balance/reset', authenticateToken, requireRole(['OWNER']), async (req: Request, res: Response) => {
  const deviceId = String(req.params.deviceId ?? '').trim();
  if (!deviceId || deviceId.length < 3) {
    return res.status(400).json({ success: false, error: 'Invalid device ID.' });
  }

  try {
    const result = await pool.query<{ device_id: string; current_balance: string }>(
      `UPDATE devices
       SET current_balance = 0, status = 'OFFLINE', last_seen_at = NULL, last_updated = NOW()
       WHERE device_id = $1
       RETURNING device_id, current_balance`,
      [deviceId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Device not found.' });
    }

    return res.json({
      success: true,
      deviceId: result.rows[0].device_id,
      balance: Number(result.rows[0].current_balance),
      message: `Server balance for ${deviceId} was reset to 0 kWh. Transaction history was not changed.`,
    });
  } catch (error) {
    console.error(`Admin balance reset failed for ${deviceId}:`, error);
    return res.status(500).json({ success: false, error: 'Failed to reset device balance.' });
  }
});

export default router;
