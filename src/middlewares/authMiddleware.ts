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

export const requireRole = (allowedRoles: Array<'BUYER' | 'OWNER' | 'SELLER'>) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'User authentication required',
      });
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
