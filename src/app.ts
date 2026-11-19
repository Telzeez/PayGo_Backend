import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { notFoundError, globalError, requestLogger } from './middlewares/middleware.js';
import authRoutes from './routes/auth.js';
import webhookRoutes from './routes/webhook.js';
import paymentRoutes from './routes/payment.js';
import deviceRoutes from './routes/devices.js';
import ownerDeviceRoutes from './routes/ownerDevices.js';
import transactionRoutes from './routes/transactions.js';
import marketplaceRoutes from './routes/marketplace.js';

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

app.use('/api/auth', authRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/owner/devices', ownerDeviceRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/marketplace', marketplaceRoutes);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString(), uptime: process.uptime() });
});
app.use(notFoundError);
app.use(globalError);
export default app;
