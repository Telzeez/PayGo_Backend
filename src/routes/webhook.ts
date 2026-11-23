import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { PaystackWebhookEvent } from '../types/index.js';
import { processSuccessfulPayment } from '../services/paymentProcessor.js';
const router = express.Router();

router.post('/paystack', async (req: Request, res: Response) => {
  const secret = process.env.PAYSTACK_SECRET_KEY || '';
  const signature = String(req.headers['x-paystack-signature'] || '');
  const rawBodyString = (req as any).rawBody
    ? (req as any).rawBody.toString('utf8')
    : JSON.stringify(req.body || {});
  const expectedSignature = crypto.createHmac('sha512', secret).update(rawBodyString).digest();
  const receivedSignature = /^[a-f0-9]{128}$/i.test(signature)
    ? Buffer.from(signature, 'hex')
    : Buffer.alloc(0);

  // Validate before doing any database work; compare fixed-length buffers in constant time.
  if (!secret || receivedSignature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(expectedSignature, receivedSignature)) {
    console.warn('Rejected Paystack webhook with an invalid signature.');
    return res.status(401).send('Invalid signature');
  }

  try {
    const event = req.body as PaystackWebhookEvent;
    if (event.event === 'charge.success') {
      const transaction = event.data;
      const reference = transaction.reference;
      const buyerEmail = transaction.customer?.email;
      const amountPaid = transaction.amount / 100;
      const deviceId = transaction.metadata?.deviceId || transaction.metadata?.deviceid;

      if (!reference || !buyerEmail || !deviceId ||
          !Number.isFinite(amountPaid) || amountPaid <= 0) {
        return res.status(400).send('Invalid payment event');
      }

      await processSuccessfulPayment(reference, buyerEmail, amountPaid, deviceId);
      return res.status(200).send('Webhook processed');
    }

    return res.status(200).send('Event ignored');
  } catch (error) {
    console.error('Paystack webhook processing failed:', error);
    return res.status(500).send('Webhook processing failed');
  }
});

export default router;
