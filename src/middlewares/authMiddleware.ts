import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types/index.js';

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

const JWT_SECRET = process.env.JWT_SECRET || 'paygo_default_jwt_secret_key_2026';

export const authenticateToken = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : (req.headers['x-access-token'] as string);

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Authentication token required',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({
      success: false,
      error: 'Invalid or expired authentication token',
    });
  }
};

export type AppRole = 'BUYER' | 'SELLER' | 'USER' | 'OWNER' | 'PLATFORM_ADMIN';

export const normalizeUserRole = (role?: string): string => (role || 'USER').trim().toUpperCase();

export const requireRole = (allowedRoles: AppRole[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'User authentication required',
      });
    }

    const normalizedUserRole = normalizeUserRole(req.user.role);
    const hasBuyer = allowedRoles.includes('BUYER') && Boolean(req.user.isBuyer);
    const hasSeller = allowedRoles.includes('SELLER') && Boolean(req.user.isSeller);
    const hasExplicitRole = allowedRoles.includes(normalizedUserRole as AppRole);
    const hasLegacyOwnerAccess = normalizedUserRole === 'OWNER' && allowedRoles.includes('OWNER');
    const hasPlatformAdminAccess = normalizedUserRole === 'PLATFORM_ADMIN' && allowedRoles.includes('PLATFORM_ADMIN');

    if (hasBuyer || hasSeller || hasExplicitRole || hasLegacyOwnerAccess || hasPlatformAdminAccess) {
      return next();
    }

    return res.status(403).json({
      success: false,
      error: `Access denied. Requires one of capabilities: ${allowedRoles.join(', ')}`,
    });
  };
};
