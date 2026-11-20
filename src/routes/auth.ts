import express, { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { RegisterRequest, LoginRequest, JwtPayload } from '../types/index.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
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

const sendVerificationEmail = async (email: string, rawToken: string) => {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const appUrl = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\\/$/, '');
  if (!apiKey || !from) throw new Error('Email delivery is not configured. Set RESEND_API_KEY and EMAIL_FROM.');
  const verifyUrl = `${appUrl}/verify-email?token=${encodeURIComponent(rawToken)}`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: [email], subject: 'Verify your PAYGO email address',
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#18181b"><h2>Verify your PAYGO email</h2><p>Confirm this email address to activate your PAYGO account.</p><p><a href="${verifyUrl}" style="display:inline-block;padding:12px 20px;background:#f59e0b;color:#18181b;text-decoration:none;border-radius:8px;font-weight:bold">Verify email</a></p><p>This link expires in 30 minutes. If you did not create this account, ignore this message.</p></div>`
    })
  });
  if (!response.ok) throw new Error(`Email provider rejected the message: ${(await response.text()).slice(0, 300)}`);
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
    const { token, role = 'BUYER' } = req.body;
    if (!GOOGLE_CLIENT_ID) return res.status(503).json({ success: false, error: 'Google sign-in is not configured on the server.' });
    if (!token) return res.status(400).json({ success: false, error: 'Google credential is required.' });
    if (role !== 'BUYER' && role !== 'OWNER') return res.status(400).json({ success: false, error: 'Account type must be BUYER or OWNER.' });

    const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.email || payload.email_verified !== true) return res.status(401).json({ success: false, error: 'Google did not provide a verified email address.' });
    const normalizedEmail = payload.email.trim().toLowerCase();
    const result = await pool.query('SELECT id, email, phone, role, is_buyer, is_seller, email_verified FROM users WHERE email = $1', [normalizedEmail]);
    let user = result.rows[0];

    if (!user) {
      const assignedRole = role === 'OWNER' ? 'OWNER' : 'USER';
      const inserted = await pool.query(
        `INSERT INTO users (email, phone, password_hash, role, is_buyer, is_seller, email_verified)
         VALUES ($1, NULL, NULL, $2, TRUE, $3, TRUE)
         RETURNING id, email, phone, role, is_buyer, is_seller, email_verified`,
        [normalizedEmail, assignedRole, role === 'OWNER']
      );
      user = inserted.rows[0];
    } else if (!user.email_verified) {
      const verified = await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1 RETURNING id, email, phone, role, is_buyer, is_seller, email_verified', [user.id]);
      user = verified.rows[0];
    }

    return res.json({
      success: true, token: createSession(user),
      user: { id: user.id, email: user.email, phone: user.phone, role: user.role, isBuyer: user.is_buyer, isSeller: user.is_seller }
    });
  } catch (error) {
    console.error('Google Auth failure:', error);
    return res.status(401).json({ success: false, error: 'Google authentication failed. Check the OAuth client configuration and try again.' });
  }
});

router.post('/register-google', async (req: Request, res: Response) => {
  try {
    const { registrationToken, phone, role } = req.body;

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

    const isBuyer = true;
    const isSeller = role === 'OWNER';
    const assignedRole = role === 'OWNER' ? 'OWNER' : 'USER';

    const insertResult = await pool.query(
      `INSERT INTO users (email, phone, password_hash, role, is_buyer, is_seller) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, email, phone, role, is_buyer, is_seller, created_at`,
      [normalizedEmail, phone || null, null, assignedRole, isBuyer, isSeller]
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
