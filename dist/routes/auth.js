"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_js_1 = __importDefault(require("../db.js"));
const authMiddleware_js_1 = require("../middlewares/authMiddleware.js");
const router = express_1.default.Router();
const BCRYPT_SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'paygo_default_jwt_secret_key_2026';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '72h';
// ==========================================
// 1. REGISTER NEW USER (BUYER OR OWNER)
// ==========================================
router.post('/register', async (req, res) => {
    try {
        const { email, password, phone, role } = req.body;
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
        const assignedRole = role === 'OWNER' ? 'OWNER' : 'BUYER';
        const normalizedEmail = email.trim().toLowerCase();
        // Check if user already exists
        const existingUser = await db_js_1.default.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
        if (existingUser.rows.length > 0) {
            return res.status(409).json({
                success: false,
                error: 'User with this email address already exists',
            });
        }
        // Hash password
        const passwordHash = await bcrypt_1.default.hash(password, BCRYPT_SALT_ROUNDS);
        // Insert user
        const insertResult = await db_js_1.default.query(`INSERT INTO users (email, phone, password_hash, role) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, email, phone, role, created_at`, [normalizedEmail, phone || null, passwordHash, assignedRole]);
        const newUser = insertResult.rows[0];
        // Generate JWT token
        const tokenPayload = {
            userId: newUser.id,
            email: newUser.email,
            role: newUser.role,
        };
        const token = jsonwebtoken_1.default.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        return res.status(201).json({
            success: true,
            token,
            user: {
                id: newUser.id,
                email: newUser.email,
                phone: newUser.phone,
                role: newUser.role,
            },
        });
    }
    catch (error) {
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
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Email and password are required',
            });
        }
        const normalizedEmail = email.trim().toLowerCase();
        // Query user by email
        const result = await db_js_1.default.query('SELECT id, email, phone, password_hash, role FROM users WHERE email = $1', [normalizedEmail]);
        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                error: 'Invalid email or password',
            });
        }
        const user = result.rows[0];
        // Verify password
        const isMatch = await bcrypt_1.default.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                error: 'Invalid email or password',
            });
        }
        // Generate JWT Token
        const tokenPayload = {
            userId: user.id,
            email: user.email,
            role: user.role,
        };
        const token = jsonwebtoken_1.default.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        return res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                phone: user.phone,
                role: user.role,
            },
        });
    }
    catch (error) {
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
router.get('/me', authMiddleware_js_1.authenticateToken, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        const result = await db_js_1.default.query('SELECT id, email, phone, role, created_at FROM users WHERE id = $1', [req.user.userId]);
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
                createdAt: user.created_at,
            },
        });
    }
    catch (error) {
        console.error('Fetch profile error:', error);
        return res.status(500).json({ success: false, error: 'Failed to retrieve user profile' });
    }
});
// ==========================================
// 4. LOGOUT
// ==========================================
router.post('/logout', (req, res) => {
    return res.json({
        success: true,
        message: 'Successfully logged out',
    });
});
exports.default = router;
//# sourceMappingURL=auth.js.map