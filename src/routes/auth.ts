import express, { Request, Response } from 'express';
import pool from '../db.js';
import { authenticateToken, verifyFirebaseIdentity, type AuthenticatedRequest } from '../middlewares/authMiddleware.js';

const router = express.Router();

function publicUser(user: any) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone ?? null,
    role: user.role,
    isBuyer: Boolean(user.is_buyer),
    isSeller: Boolean(user.is_seller),
    createdAt: user.created_at,
  };
}

// Called after Firebase signup/email verification or Google sign-in.
// Existing profiles are linked by verified email without changing their role,
// buyer/seller capabilities, meter assignments, listings, or transaction history.
router.post('/sync', verifyFirebaseIdentity, async (req: AuthenticatedRequest, res: Response) => {
  const identity = req.firebaseIdentity;
  if (!identity?.email || identity.email_verified !== true) {
    return res.status(403).json({
      success: false,
      code: 'EMAIL_NOT_VERIFIED',
      error: 'Verify your email address with Firebase before continuing.',
    });
  }

  const email = identity.email.trim().toLowerCase();
  const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() || null : null;
  const requestedRole = typeof req.body?.role === 'string' ? req.body.role.toUpperCase() : 'BUYER';
  if (requestedRole !== 'BUYER' && requestedRole !== 'OWNER') {
    return res.status(400).json({ success: false, error: 'Account type must be BUYER or OWNER.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let result = await client.query(
      `SELECT id, email, phone, role, is_buyer, is_seller, firebase_uid, created_at
       FROM users WHERE firebase_uid = $1 FOR UPDATE`,
      [identity.sub]
    );

    if (result.rows.length === 0) {
      result = await client.query(
        `SELECT id, email, phone, role, is_buyer, is_seller, firebase_uid, created_at
         FROM users WHERE LOWER(email) = $1 FOR UPDATE`,
        [email]
      );

      if (result.rows.length > 1) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'More than one PAYGO profile matches this email. Contact support.' });
      }

      if (result.rows.length === 1) {
        const existing = result.rows[0];
        if (existing.firebase_uid && existing.firebase_uid !== identity.sub) {
          await client.query('ROLLBACK');
          return res.status(409).json({ success: false, error: 'This PAYGO account is already linked to another sign-in identity. Contact support.' });
        }

        result = await client.query(
          `UPDATE users
           SET firebase_uid = $1,
               email_verified = TRUE,
               phone = COALESCE(phone, $2),
               updated_at = NOW()
           WHERE id = $3 AND (firebase_uid IS NULL OR firebase_uid = $1)
           RETURNING id, email, phone, role, is_buyer, is_seller, created_at`,
          [identity.sub, phone, existing.id]
        );
      } else {
        const assignedRole = requestedRole === 'OWNER' ? 'OWNER' : 'USER';
        result = await client.query(
          `INSERT INTO users (email, phone, password_hash, role, is_buyer, is_seller, email_verified, firebase_uid)
           VALUES ($1, $2, NULL, $3, TRUE, $4, TRUE, $5)
           RETURNING id, email, phone, role, is_buyer, is_seller, created_at`,
          [email, phone, assignedRole, requestedRole === 'OWNER', identity.sub]
        );
      }
    }

    if (result.rows.length !== 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Unable to link this Firebase identity to a PAYGO profile.' });
    }

    await client.query('COMMIT');
    return res.json({ success: true, user: publicUser(result.rows[0]) });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error?.code === '23505') {
      return res.status(409).json({ success: false, error: 'This email or Firebase identity is already linked to another PAYGO account.' });
    }
    console.error('Firebase profile synchronization failed:', error);
    return res.status(500).json({ success: false, error: 'Unable to synchronize your PAYGO profile right now.' });
  } finally {
    client.release();
  }
});

router.get('/me', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const result = await pool.query(
      'SELECT id, email, phone, role, is_buyer, is_seller, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (result.rows.length !== 1) {
      return res.status(404).json({ success: false, error: 'PAYGO profile not found.' });
    }
    return res.json({ success: true, user: publicUser(result.rows[0]) });
  } catch (error) {
    console.error('Fetch profile error:', error);
    return res.status(500).json({ success: false, error: 'Failed to retrieve user profile.' });
  }
});

// Email and password changes must be performed through Firebase Authentication.
// PAYGO stores only application profile fields.
router.put('/profile', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (req.body?.email !== undefined || req.body?.newPassword !== undefined) {
      return res.status(400).json({
        success: false,
        code: 'USE_FIREBASE_PROFILE',
        error: 'Change your email address or password through Firebase Authentication. PAYGO only updates your profile details here.',
      });
    }
    if (req.body?.phone === undefined) {
      return res.status(400).json({ success: false, error: 'No supported profile fields were provided.' });
    }

    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() || null : null;
    const result = await pool.query(
      `UPDATE users SET phone = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, email, phone, role, is_buyer, is_seller, created_at`,
      [phone, req.user.userId]
    );
    if (result.rows.length !== 1) return res.status(404).json({ success: false, error: 'PAYGO profile not found.' });
    return res.json({ success: true, message: 'Profile updated successfully.', user: publicUser(result.rows[0]) });
  } catch (error) {
    console.error('Update profile error:', error);
    return res.status(500).json({ success: false, error: 'Failed to update profile.' });
  }
});

export default router;
