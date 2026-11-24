import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { notFoundError, globalError, requestLogger, apiRateLimit } from './middlewares/middleware.js';
import authRoutes from './routes/auth.js';
import webhookRoutes from './routes/webhook.js';
import paymentRoutes from './routes/payment.js';
import deviceRoutes from './routes/devices.js';
import ownerDeviceRoutes from './routes/ownerDevices.js';
import meterRegistryRoutes from './routes/meterRegistry.js';
import transactionRoutes from './routes/transactions.js';
import marketplaceRoutes from './routes/marketplace.js';
import connectionRoutes from './routes/connections.js';
import notificationRoutes from './routes/notifications.js';

dotenv.config();
const app: Express = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const allowedOrigins = new Set([
  'https://pay-go-frontend.vercel.app',
  'http://localhost:3000',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
  ...(process.env.APP_BASE_URL ? [process.env.APP_BASE_URL] : []),
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
].map((origin) => origin.replace(/\/+$/, '')));

app.use(cors({
  origin: (origin, callback) => {
    // Non-browser clients and provider webhooks do not send an Origin header.
    if (!origin || allowedOrigins.has(origin.replace(/\/+$/, ''))) return callback(null, true);
    return callback(new Error('Origin is not allowed by the PAYGO CORS policy'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-API-Key', 'X-Paystack-Signature'],
  maxAge: 600,
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '64kb',
  verify: (req: any, _res, buf) => {
    if (buf && buf.length) req.rawBody = buf;
  },
}));
app.use(express.static('dist'));
app.use(requestLogger);

// Maintenance mode is opt-in. Normal API access remains enabled unless
// PAYGO_MAINTENANCE_MODE=true is explicitly configured.
const maintenanceMode = process.env.PAYGO_MAINTENANCE_MODE === 'true';
app.use('/api', apiRateLimit);
app.use('/api', (req: Request, res: Response, next) => {
  if (!maintenanceMode || req.path === '/webhook/paystack') {
    return next();
  }

  return res.status(503).json({
    success: false,
    code: 'PAYGO_MAINTENANCE',
    error: 'PAYGO is temporarily unavailable while we complete a security and authentication update. Please try again later.',
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/owner/devices', ownerDeviceRoutes);
app.use('/api/meters', meterRegistryRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/connections', connectionRoutes);
app.use('/api/notifications', notificationRoutes);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString(), uptime: process.uptime() });
});
app.use(notFoundError);
app.use(globalError);
export default app;
