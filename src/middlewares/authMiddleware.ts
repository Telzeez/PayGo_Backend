import { Request, Response, NextFunction } from 'express';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import pool from '../db.js';
import { JwtPayload } from '../types/index.js';

interface FirebaseJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

interface FirebaseClaims {
  sub: string;
  user_id?: string;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
  auth_time: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
  firebaseIdentity?: FirebaseClaims;
}

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'paygo-697b9';
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let cachedKeys: FirebaseJwk[] = [];
let keysExpireAt = 0;

async function getFirebaseKeys(): Promise<FirebaseJwk[]> {
  if (cachedKeys.length && Date.now() < keysExpireAt) return cachedKeys;

  const response = await fetch(JWKS_URL);
  if (!response.ok) throw new Error('Unable to retrieve Firebase signing keys');
  const payload = await response.json() as { keys?: FirebaseJwk[] };
  if (!Array.isArray(payload.keys) || payload.keys.length === 0) {
    throw new Error('Firebase signing keys response was empty');
  }

  const cacheControl = response.headers.get('cache-control') || '';
  const maxAge = Number(cacheControl.match(/max-age=(\\d+)/i)?.[1] || 3600);
  cachedKeys = payload.keys;
  keysExpireAt = Date.now() + Math.max(60, maxAge) * 1000;
  return cachedKeys;
}

async function verifyFirebaseIdToken(token: string): Promise<FirebaseClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed Firebase ID token');

  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unsupported Firebase token signing key');

  const keys = await getFirebaseKeys();
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    cachedKeys = [];
    throw new Error('Unknown Firebase token signing key');
  }

  const publicKey = createPublicKey({ key: jwk as any, format: 'jwk' });
  const validSignature = verifySignature(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    Buffer.from(parts[2], 'base64url')
  );
  if (!validSignature) throw new Error('Invalid Firebase token signature');

  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as FirebaseClaims;
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.aud !== PROJECT_ID ||
    claims.iss !== ISSUER ||
    !claims.sub ||
    claims.sub.length > 128 ||
    !claims.email ||
    typeof claims.auth_time !== 'number' ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number' ||
    claims.exp <= now ||
    claims.iat > now + 60 ||
    claims.auth_time > now + 60
  ) {
    throw new Error('Firebase token claims are invalid or expired');
  }
  return claims;
}

export const verifyFirebaseIdentity = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({ success: false, error: 'Firebase authentication token required' });
  }

  try {
    req.firebaseIdentity = await verifyFirebaseIdToken(token);
    return next();
  } catch (error) {
    console.error('Firebase token verification failed:', error);
    return res.status(401).json({ success: false, error: 'Invalid or expired Firebase authentication. Please sign in again.' });
  }
};

export const authenticateToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication token required' });
  }

  try {
    const identity = await verifyFirebaseIdToken(token);
    if (identity.email_verified !== true) {
      return res.status(403).json({ success: false, code: 'EMAIL_NOT_VERIFIED', error: 'Please verify your email address before using PAYGO.' });
    }

    const normalizedEmail = identity.email!.trim().toLowerCase();
    let result = await pool.query(
      `SELECT id, email, role, is_buyer, is_seller
       FROM users WHERE firebase_uid = $1`,
      [identity.sub]
    );

    // One-time safe linking for existing accounts: only a verified Firebase
    // email may be linked, and an already-linked identity is never replaced.
    if (result.rows.length === 0) {
      const legacy = await pool.query(
        'SELECT id, firebase_uid FROM users WHERE LOWER(email) = $1',
        [normalizedEmail]
      );
      if (legacy.rows.length === 1) {
        const row = legacy.rows[0];
        if (row.firebase_uid && row.firebase_uid !== identity.sub) {
          return res.status(409).json({ success: false, error: 'This PAYGO account is already linked to another sign-in identity. Contact support.' });
        }
        await pool.query(
          'UPDATE users SET firebase_uid = $1, email_verified = TRUE, updated_at = NOW() WHERE id = $2 AND (firebase_uid IS NULL OR firebase_uid = $1)',
          [identity.sub, row.id]
        );
        result = await pool.query(
          'SELECT id, email, role, is_buyer, is_seller FROM users WHERE firebase_uid = $1',
          [identity.sub]
        );
      }
    }

    if (result.rows.length !== 1) {
      return res.status(403).json({ success: false, code: 'PAYGO_PROFILE_NOT_LINKED', error: 'Your sign-in is verified, but your PAYGO profile is not linked yet. Complete account setup first.' });
    }

    const user = result.rows[0];
    req.user = {
      userId: user.id,
      email: user.email,
      role: user.role,
      isBuyer: user.is_buyer,
      isSeller: user.is_seller,
    };
    req.firebaseIdentity = identity;
    return next();
  } catch (error) {
    console.error('PAYGO authentication failed:', error);
    return res.status(401).json({ success: false, error: 'Invalid or expired authentication token' });
  }
};

export const requireRole = (allowedRoles: Array<'BUYER' | 'OWNER' | 'SELLER'>) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'User authentication required' });
    }

    const hasBuyer = allowedRoles.includes('BUYER') && req.user.isBuyer;
    const hasSeller = (allowedRoles.includes('SELLER') || allowedRoles.includes('OWNER')) && req.user.isSeller;

    if (hasBuyer || hasSeller || allowedRoles.includes(req.user.role as any)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      error: `Access denied. Requires one of capabilities: ${allowedRoles.join(', ')}`,
    });
  };
};

export type { AuthenticatedRequest, FirebaseClaims };
