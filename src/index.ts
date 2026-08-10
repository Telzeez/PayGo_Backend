import express,{Express} from 'express'
import cors from 'cors';
import dotenv from 'dotenv'
import {notFoundError, globalError, requestLogger} from './middlewares/middleware'
import webhookRoutes from './routes/webhook.js';
import paymentRoutes from './routes/payment.js';
import deviceRoutes from './routes/devices.js';
import './mqtt-client.js';  // Auto-connects when imported
dotenv.config();

const app: Express = express();
const PORT: number = parseInt(process.env.PORT || '3001', 10)

app.use(cors());
app.use(express.json());


// request logger
app.use(requestLogger)
// Register routes
app.use('/api/webhook', webhookRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/devices', deviceRoutes);

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.use(notFoundError)
app.use(globalError)
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});