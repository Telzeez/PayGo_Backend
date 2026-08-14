import express, { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { RegisterRequest, LoginRequest, JwtPayload } from '../types/index.js';
import { authenticateToken, AuthenticatedRequest } from '../middlewares/authMiddleware.js';

const router = express.Router();

const BCRYPT_SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'paygo_default_jwt_secret_key_2026';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '72h';

// ==========================================
// 1. REGISTER NEW USER (BUYER OR OWNER)
// ==========================================
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, phone } = req.body as RegisterRequest;

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

    const assignedRole = 'USER';
    const isBuyer = true;
    const isSeller = false;
    const normalizedEmail = email.trim().toLowerCase();

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'User with this email address already exists',
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
      'SELECT id, email, phone, password_hash, role, is_buyer, is_seller FROM users WHERE email = $1',
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
    }

    const user = result.rows[0];

    // Verify password
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
