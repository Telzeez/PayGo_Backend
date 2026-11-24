import express, { Response } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';
import { isValidCoordinate } from '../services/location.js';

const router = express.Router();
router.use(authenticateToken);

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, type, title, message, target_url AS "targetUrl",
              entity_id AS "entityId", read_at AS "readAt", created_at AS "createdAt"
       FROM notifications WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [req.user!.userId]
    );
    const unread = await pool.query(
      'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [req.user!.userId]
    );
    return res.json({ success: true, notifications: result.rows, unreadCount: unread.rows[0].count });
  } catch (error) {
    console.error('Notifications list error:', error);
    return res.status(500).json({ success: false, error: 'Unable to load notifications.' });
  }
});

router.patch('/:id/read', async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, error: 'A valid notification ID is required.' });
  }
  try {
    await pool.query(
      'UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2',
      [id, req.user!.userId]
    );
    return res.json({ success: true });
  } catch (error) {
    console.error('Mark notification read error:', error);
    return res.status(500).json({ success: false, error: 'Unable to update notification.' });
  }
});

router.get('/nearby-alerts/me', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT latitude::float8 AS latitude, longitude::float8 AS longitude, enabled
       FROM buyer_alert_locations WHERE user_id = $1`,
      [req.user!.userId]
    );
    return res.json({ success: true, preference: result.rows[0] || { enabled: false, latitude: null, longitude: null } });
  } catch (error) {
    console.error('Nearby alert preference error:', error);
    return res.status(500).json({ success: false, error: 'Unable to load nearby alert preference.' });
  }
});

router.put('/nearby-alerts', async (req: AuthenticatedRequest, res: Response) => {
  const enabled = req.body?.enabled === true;
  if (!enabled) {
    try {
      await pool.query('DELETE FROM buyer_alert_locations WHERE user_id = $1', [req.user!.userId]);
      return res.json({ success: true, enabled: false });
    } catch (error) {
      console.error('Disable nearby alerts error:', error);
      return res.status(500).json({ success: false, error: 'Unable to disable nearby alerts.' });
    }
  }

  const latitude = Number(req.body?.latitude);
  const longitude = Number(req.body?.longitude);
  if (!isValidCoordinate(latitude, longitude)) {
    return res.status(400).json({ success: false, error: 'A valid location is required to enable nearby energy alerts.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO buyer_alert_locations (user_id, latitude, longitude, enabled, updated_at)
       SELECT $1, $2, $3, TRUE, NOW()
       WHERE EXISTS (SELECT 1 FROM users WHERE id = $1 AND is_buyer = TRUE)
       ON CONFLICT (user_id) DO UPDATE
         SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
             enabled = TRUE, updated_at = NOW()
       RETURNING latitude::float8 AS latitude, longitude::float8 AS longitude, enabled`,
      [req.user!.userId, Number(latitude.toFixed(3)), Number(longitude.toFixed(3))]
    );
    if (!result.rows.length) return res.status(403).json({ success: false, error: 'Enable buyer capability before subscribing to nearby energy alerts.' });
    return res.json({ success: true, preference: result.rows[0] });
  } catch (error) {
    console.error('Save nearby alert preference error:', error);
    return res.status(500).json({ success: false, error: 'Unable to save nearby alert preference.' });
  }
});

export default router;
