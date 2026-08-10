import { Request, Response, NextFunction } from 'express';
import { JwtPayload } from '../types/index.js';
export interface AuthenticatedRequest extends Request {
    user?: JwtPayload;
}
export declare const authenticateToken: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare const requireRole: (allowedRoles: Array<'BUYER' | 'OWNER'>) => (req: AuthenticatedRequest, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
