import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { notFoundError, globalError, requestLogger } from './middlewares/middleware.js';
import authRoutes from './routes/auth.js';
import webhookRoutes from './routes/webhook.js';
import paymentRoutes from './routes/payment.js';
import deviceRoutes from './routes/devices.js';
import ownerDeviceRoutes from './routes/ownerDevices.js';
import meterRegistryRoutes from './routes/meterRegistry.js';
import transactionRoutes from './routes/transactions.js';
import marketplaceRoutes from './routes/marketplace.js';
import connectionRoutes from './routes/connections.js';

dotenv.config();
const app: Express = express();
app.use(cors());
app.use(express.json({
  verify: (req: any, _res, buf) => {
    if (buf && buf.length) req.rawBody = buf;
  },
}));
app.use(express.static('dist'));
app.use(requestLogger);

// Maintenance mode is opt-in. Normal API access remains enabled unless
// PAYGO_MAINTENANCE_MODE=true is explicitly configured.
const maintenanceMode = process.env.PAYGO_MAINTENANCE_MODE === 'true';
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

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString(), uptime: process.uptime() });
});
app.use(notFoundError);
app.use(globalError);
export default app;
