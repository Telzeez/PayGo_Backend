import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { notFoundError, globalError, requestLogger } from './middlewares/middleware.js';
import authRoutes from './routes/auth.js';
import webhookRoutes from './routes/webhook.js';
import paymentRoutes from './routes/payment.js';
import deviceRoutes from './routes/devices.js';
import transactionRoutes from './routes/transactions.js';
import marketplaceRoutes from './routes/marketplace.js';


dotenv.config();

const app: Express = express();

app.use(cors());

// Intercept raw buffer during global JSON parsing
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      if (buf && buf.length) {
        req.rawBody = buf; // This makes req.rawBody globally available
      }
    },
  })
);
app.use(express.static('dist'));

// Request logger
app.use(requestLogger);

// Register routes
app.use('/api/auth', authRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/marketplace', marketplaceRoutes);

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.use(notFoundError);
app.use(globalError);

export default app;
