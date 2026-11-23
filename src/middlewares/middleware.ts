import { Request, Response, NextFunction } from 'express';

const notFoundError = (req: Request, res: Response) => {
    res.status(404).json({ error: "Unknown endpoint" });
};

const globalError = (err: any, req: Request, res: Response, next: NextFunction) => {
    console.log("unhandled error: ", err);
    res.status(500).json({ error: 'Internal Server Error' });
};

const requestLogger = (req: Request, _res: Response, next: NextFunction) => {
    // Never log query strings: they may contain identifiers or one-time values.
    console.log(JSON.stringify({
        method: req.method,
        path: req.path,
    }));
    next();
};

// Lightweight per-process API throttling. Use a shared store (for example,
// Redis) if the service is scaled to multiple instances.
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const API_RATE_WINDOW_MS = 60_000;
const API_RATE_MAX = 300;

const apiRateLimit = (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + API_RATE_WINDOW_MS };
        rateLimitBuckets.set(key, bucket);
    }
    bucket.count += 1;

    if (rateLimitBuckets.size > 10_000) {
        for (const [entryKey, entry] of rateLimitBuckets) {
            if (entry.resetAt <= now) rateLimitBuckets.delete(entryKey);
        }
    }

    res.setHeader('RateLimit-Limit', API_RATE_MAX);
    res.setHeader('RateLimit-Remaining', Math.max(0, API_RATE_MAX - bucket.count));
    res.setHeader('RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));

    if (bucket.count > API_RATE_MAX) {
        return res.status(429).json({
            success: false,
            code: 'RATE_LIMITED',
            error: 'Too many requests. Please try again shortly.',
        });
    }
    return next();
};

export { notFoundError, globalError, requestLogger, apiRateLimit };