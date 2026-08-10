import { Request, Response, NextFunction } from 'express';

const notFoundError = (req: Request, res: Response) => {
    res.status(404).json({ error: "Unknown endpoint" });
};

const globalError = (err: any, req: Request, res: Response, next: NextFunction) => {
    console.log("unhandled error: ", err);
    res.status(500).json({ error: 'Internal Server Error' });
};

const requestLogger = (req: Request, res: Response, next: NextFunction) => {
    console.clear();
    console.log(JSON.stringify({
        method: req.method,
        path: req.path,
        url: req.url
    }, null, 2));
    
    next();
};

export { notFoundError, globalError, requestLogger };