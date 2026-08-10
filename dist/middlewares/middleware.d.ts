import { Request, Response, NextFunction } from 'express';
declare const notFoundError: (req: Request, res: Response) => void;
declare const globalError: (err: any, req: Request, res: Response, next: NextFunction) => void;
declare const requestLogger: (req: Request, res: Response, next: NextFunction) => void;
export { notFoundError, globalError, requestLogger };
