import express, { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { RegisterRequest, LoginRequest, JwtPayload } from '../types/index.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import { sendVerificationEmail } from '../services/email.js';
const router = express.Router();

const BCRYPT_SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'paygo_default_jwt_secret_key_2026';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '72h';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const createSession = (user: any) => {
  const tokenPayload: JwtPayload = { userId: user.id, email: user.email, role: user.role, isBuyer: user.is_buyer, isSeller: user.is_seller };
  return jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as any });
};

// ==========================================
// 1. REGISTER NEW USER (BUYER OR OWNER)
// ==========================================
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, phone, role = 'BUYER' } = req.body as RegisterRequest & { role?: string };

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required',
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters long',
      });
    }

    if (role !== 'BUYER' && role !== 'OWNER') {
      return res.status(400).json({ success: false, error: 'Account type must be BUYER or OWNER' });
    }

    // Every account can buy energy; OWNER additionally enables seller capabilities.
    const assignedRole = role === 'OWNER' ? 'OWNER' : 'USER';
    const isBuyer = true;
    const isSeller = role === 'OWNER';
    const normalizedEmail = email.trim().toLowerCase();

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'User with this email address already exists please login',
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    // Insert user
    const insertResult = await pool.query(
      `INSERT INTO users (email, phone, password_hash, role, is_buyer, is_seller) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, email, phone, role, is_buyer, is_seller, created_at`,
      [normalizedEmail, phone || null, passwordHash, assignedRole, isBuyer, isSeller]
    );

    const newUser = insertResult.rows[0];
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await pool.query(`INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`, [newUser.id, tokenHash]);
    try {
      await sendVerificationEmail(newUser.email, rawToken);
    } catch (emailError) {
      await pool.query('DELETE FROM email_verification_tokens WHERE token_hash = $1', [tokenHash]);
      console.error('Verification email delivery failed:', emailError);
      return res.status(503).json({ success: false, code: 'VERIFICATION_EMAIL_UNAVAILABLE', error: 'Your account is pending verification, but the verification email could not be sent. Configure email delivery and request a new link.' });
    }
    return res.status(201).json({ success: true, requiresEmailVerification: true, message: 'Account created. Check your email for a verification link before signing in.', email: newUser.email });

  } catch (error) {
    console.error('Registration failure:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error during registration',
    });
  }
});

// Verify an email address using the single-use token from the email.
router.post('/verify-email', async (req: Request, res: Response) => {
  const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!rawToken) return res.status(400).json({ success: false, error: 'Verification token is required.' });

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT t.id AS token_id, u.id, u.email, u.phone, u.role, u.is_buyer, u.is_seller
       FROM email_verification_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > NOW()
       FOR UPDATE OF t, u`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'This verification link is invalid, expired, or has already been used. Request a new link.' });
    }

    const user = result.rows[0];
    await client.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [user.id]);
    await client.query('UPDATE email_verification_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'Email verified successfully.',
      token: createSession(user),
      user: { id: user.id, email: user.email, phone: user.phone, role: user.role, isBuyer: user.is_buyer, isSeller: user.is_seller },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Email verification failure:', error);
    return res.status(500).json({ success: false, error: 'Unable to verify your email right now. Please try again.' });
  } finally {
    client.release();
  }
});

// Resend verification without revealing whether an email address has an account.
router.post('/resend-verification', async (req: Request, res: Response) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, email_verified FROM users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];
    if (user && !user.email_verified) {
      const recent = await pool.query(
        `SELECT 1 FROM email_verification_tokens
         WHERE user_id = $1 AND created_at > NOW() - INTERVAL '60 seconds'
         LIMIT 1`,
        [user.id]
      );

      if (recent.rows.length === 0) {
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        await pool.query(
          'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'30 minutes\')',
          [user.id, tokenHash]
        );
        try {
          await sendVerificationEmail(user.email, rawToken);
        } catch (emailError) {
          await pool.query('DELETE FROM email_verification_tokens WHERE token_hash = $1', [tokenHash]);
          console.error('Verification resend delivery failed:', emailError);
          return res.status(503).json({ success: false, error: 'Email delivery is temporarily unavailable. Please try again later.' });
        }
      }
    }

    return res.json({ success: true, message: 'If this address belongs to an unverified PAYGO account, a verification link has been sent. Check your inbox and spam folder.' });
  } catch (error) {
    console.error('Verification resend failure:', error);
    return res.status(500).json({ success: false, error: 'Unable to request a verification email right now.' });
  }
});

// ==========================================
// 2. LOGIN USER
// ==========================================
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as LoginRequest;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Query user by email
    const result = await pool.query(
      'SELECT id, email, phone, password_hash, role, is_buyer, is_seller, email_verified FROM users WHERE email = $1',
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
    }

    const user = result.rows[0];
    if (!user.email_verified) return res.status(403).json({ success: false, code: 'EMAIL_NOT_VERIFIED', error: 'Please verify your email address before signing in.' });
    if (!user.password_hash) return res.status(401).json({ success: false, error: 'This account uses Google sign-in. Continue with Google.' });
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
    }

    // Generate JWT Token
    const tokenPayload: JwtPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      isBuyer: user.is_buyer,
      isSeller: user.is_seller,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as any });

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isBuyer: user.is_buyer,
        isSeller: user.is_seller,
      },
    });

  } catch (error) {
    console.error('Login failure:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error during login',
    });
  }
});

// ==========================================
// 2.5 GOOGLE LOGIN/REGISTER
// ==========================================
router.post('/google', async (req: Request, res: Response) => {
  try {
    const { token } = req.body as { token?: string };
    if (!GOOGLE_CLIENT_ID) {
      console.error('Google sign-in unavailable: GOOGLE_CLIENT_ID is not configured.');
      return res.status(503).json({ success: false, error: 'Google sign-in is not configured on the server.' });
    }
    if (!token) return res.status(400).json({ success: false, error: 'Google credential is required.' });

    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || payload.email_verified !== true) {
      return res.status(401).json({ success: false, error: 'Google did not provide a verified email address.' });
    }

    const normalizedEmail = payload.email.trim().toLowerCase();
    const result = await pool.query(
      'SELECT id, email, phone, role, is_buyer, is_seller, email_verified FROM users WHERE email = $1',
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      const registrationToken = jwt.sign(
        { email: normalizedEmail, isRegistration: true },
        JWT_SECRET,
        { expiresIn: '15m' } as any
      );
      return res.json({ success: true, needsRegistration: true, registrationToken });
    }

    const user = result.rows[0];
    if (!user.email_verified) {
      await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [user.id]);
    }
    return res.json({
      success: true,
      token: createSession(user),
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isBuyer: user.is_buyer,
        isSeller: user.is_seller,
      },
    });
  } catch (error) {
    console.error('Google Auth failure:', error);
    return res.status(401).json({
      success: false,
      error: 'Google authentication failed. Check that the frontend and backend use the same Google OAuth client ID.',
    });
  }
});

router.post('/register-google', async (req: Request, res: Response) => {
  try {
    const { registrationToken, phone } = req.body;

    if (!registrationToken) {
      return res.status(400).json({ success: false, error: 'Registration token is required' });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(registrationToken, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ success: false, error: 'Invalid or expired registration token' });
    }

    if (!decoded.email || !decoded.isRegistration) {
      return res.status(400).json({ success: false, error: 'Invalid token payload' });
    }

    const normalizedEmail = decoded.email.trim().toLowerCase();

    // Ensure user doesn't already exist
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'User with this email already exists' });
    }

    // New Google accounts start as buyers. Seller capability is granted only
    // after a pre-provisioned GENERATION meter is activated.
    const isBuyer = true;
    const isSeller = false;
    const assignedRole = 'USER';

    const insertResult = await pool.query(
      `INSERT INTO users (email, phone, password_hash, role, is_buyer, is_seller, email_verified)
       VALUES ($1, $2, NULL, $3, $4, $5, TRUE)
       RETURNING id, email, phone, role, is_buyer, is_seller, created_at`,
      [normalizedEmail, phone || null, assignedRole, isBuyer, isSeller]
    );

    const newUser = insertResult.rows[0];

    const tokenPayload: JwtPayload = {
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
      isBuyer: newUser.is_buyer,
      isSeller: newUser.is_seller,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as any });

    return res.status(201).json({
      success: true,
      token,
      user: {
        id: newUser.id,
        email: newUser.email,
        phone: newUser.phone,
        role: newUser.role,
        isBuyer: newUser.is_buyer,
        isSeller: newUser.is_seller,
      },
    });
  } catch (error) {
    console.error('Google Registration failure:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error during Google registration',
    });
  }
});

// ==========================================
// 3. GET CURRENT LOGGED IN USER (/me)
// ==========================================
router.get('/me', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const result = await pool.query(
      'SELECT id, email, phone, role, is_buyer, is_seller, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User profile not found' });
    }

    const user = result.rows[0];
    return res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isBuyer: user.is_buyer,
        isSeller: user.is_seller,
        createdAt: user.created_at,
      },
    });

  } catch (error) {
    console.error('Fetch profile error:', error);
    return res.status(500).json({ success: false, error: 'Failed to retrieve user profile' });
  }
});

// ==========================================
// 5. UPDATE USER PROFILE
// ==========================================
router.put('/profile', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { email, phone, newPassword } = req.body;
    const userId = req.user.userId;

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (phone !== undefined) {
      updates.push(`phone = $${paramIndex++}`);
      values.push(phone ? phone.trim() : null);
    }

    if (email && email.trim()) {
      const normalizedEmail = email.trim().toLowerCase();
      const existing = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [normalizedEmail, userId]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ success: false, error: 'Email address is already in use' });
      }
      updates.push(`email = $${paramIndex++}`);
      values.push(normalizedEmail);
    }

    if (newPassword && newPassword.trim().length >= 6) {
      const passwordHash = await bcrypt.hash(newPassword.trim(), BCRYPT_SALT_ROUNDS);
      updates.push(`password_hash = $${paramIndex++}`);
      values.push(passwordHash);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid profile fields provided for update' });
    }

    values.push(userId);
    const queryStr = `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING id, email, phone, role, created_at`;

    const result = await pool.query(queryStr, values);
    const updatedUser = result.rows[0];

    return res.json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        phone: updatedUser.phone,
        role: updatedUser.role,
        createdAt: updatedUser.created_at,
      },
    });

  } catch (error) {
    console.error('Update profile error:', error);
    return res.status(500).json({ success: false, error: 'Failed to update user profile' });
  }
});

export default router;
