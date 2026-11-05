import express, { Request, Response } from 'express';
import pool from '../db.js';
import { authenticateToken, requireRole } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/:deviceId/assign', authenticateToken, requireRole(['OWNER']), (_req: Request, res: Response) => {
  return res.status(503).json({
    success: false,
    error: 'Meter assignment is temporarily disabled for the prototype.',
  });
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
