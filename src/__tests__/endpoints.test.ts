import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import app from '../app.js';
import pool from '../db.js';
import axios from 'axios';

let server: http.Server;
let baseUrl: string;

describe('PAYGO API Endpoint Test Suite', () => {
  before((_context, done) => {
    server = app.listen(0, () => {
      const address = server.address() as { port: number };
      baseUrl = `http://localhost:${address.port}`;
      done();
    });
  });

  after((_context, done) => {
    server.close(done);
  });

  // ==========================================
  // 1. HEALTH CHECK ENDPOINT
  // ==========================================
  describe('GET /health', () => {
    it('should return 200 OK with server status metadata', async () => {
      const res = await fetch(`${baseUrl}/health`);
      assert.equal(res.status, 200);

      const body = await res.json() as any;
      assert.equal(body.status, 'OK');
      assert.ok(body.timestamp);
      assert.ok(typeof body.uptime === 'number');
    });
  });

  // ==========================================
  // 2. UNKNOWN ROUTE 404 HANDLER
  // ==========================================
  describe('GET /api/nonexistent-endpoint', () => {
    it('should return 404 for unknown endpoints', async () => {
      const res = await fetch(`${baseUrl}/api/nonexistent-endpoint`);
      assert.equal(res.status, 404);

      const body = await res.json() as any;
      assert.deepEqual(body, { error: 'Unknown endpoint' });
    });
  });

  // ==========================================
  // 3. PAYMENT INITIATION ENDPOINT
  // ==========================================
  describe('POST /api/payment/initiate', () => {
    it('should return 400 Bad Request when mandatory fields are missing', async () => {
      const res = await fetch(`${baseUrl}/api/payment/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 500, email: 'buyer@example.com' }), // missing deviceId
      });

      assert.equal(res.status, 400);
      const body = await res.json() as any;
      assert.equal(body.success, false);
      assert.ok(body.error.includes('Missing required field'));
    });

    it('should return 400 Bad Request when payment amount is less than 100', async () => {
      const res = await fetch(`${baseUrl}/api/payment/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 50, email: 'buyer@example.com', deviceId: 'device_001' }),
      });

      assert.equal(res.status, 400);
      const body = await res.json() as any;
      assert.equal(body.success, false);
      assert.equal(body.error, 'Minimum payment is #100');
    });

    it('should successfully initialize payment via Paystack and return paymentUrl', async () => {
      const originalPost = axios.post;
      (axios as any).post = async () => ({
        data: {
          status: true,
          data: {
            authorization_url: 'https://checkout.paystack.com/test_token_123',
            reference: 'paystack_ref_9999',
          },
        },
      });

      try {
        const res = await fetch(`${baseUrl}/api/payment/initiate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: 1000, email: 'buyer@example.com', deviceId: 'device_001' }),
        });

        assert.equal(res.status, 200);
        const body = await res.json() as any;
        assert.deepEqual(body, {
          success: true,
          paymentUrl: 'https://checkout.paystack.com/test_token_123',
          reference: 'paystack_ref_9999',
        });
      } finally {
        axios.post = originalPost;
      }
    });
  });

  // ==========================================
  // 4. PAYSTACK WEBHOOK ENDPOINT
  // ==========================================
  describe('POST /api/webhook/paystack', () => {
    it('should return 401 Unauthorized for invalid HMAC signatures', async () => {
      const res = await fetch(`${baseUrl}/api/webhook/paystack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-paystack-signature': 'invalid_signature_hash',
        },
        body: JSON.stringify({ event: 'charge.success' }),
      });

      assert.equal(res.status, 401);
      const text = await res.text();
      assert.equal(text, 'Invalid signature');
    });

    it('should process charge.success webhook atomically and dispatch token', async () => {
      const secret = process.env.PAYSTACK_SECRET_KEY || 'sk_test_89821baac945f63f2e385317afa688602a5f3683';
      const payload = {
        event: 'charge.success',
        data: {
          amount: 100000,
          customer: { email: 'buyer@example.com' },
          metadata: { deviceId: 'device_001' },
          reference: 'ref_unique_101',
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

      const originalConnect = pool.connect;
      (pool as any).connect = async () => ({
        query: async (queryText: string) => {
          if (queryText.includes('FOR UPDATE')) {
            return { rows: [] }; // Idempotency check: no duplicate found
          }
          return { rows: [] };
        },
        release: () => {},
      });

      try {
        const res = await fetch(`${baseUrl}/api/webhook/paystack`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-paystack-signature': signature,
          },
          body: rawBody,
        });

        assert.equal(res.status, 200);
        const text = await res.text();
        assert.equal(text, 'Webhook processed');
      } finally {
        pool.connect = originalConnect;
      }
    });

    it('should return 200 for duplicate webhooks (Idempotency)', async () => {
      const secret = process.env.PAYSTACK_SECRET_KEY || 'sk_test_89821baac945f63f2e385317afa688602a5f3683';
      const payload = {
        event: 'charge.success',
        data: {
          amount: 100000,
          customer: { email: 'buyer@example.com' },
          metadata: { deviceId: 'device_001' },
          reference: 'ref_already_processed',
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

      const originalConnect = pool.connect;
      (pool as any).connect = async () => ({
        query: async (queryText: string) => {
          if (queryText.includes('FOR UPDATE')) {
            return { rows: [{ id: 1 }] }; // Idempotency check: duplicate row exists!
          }
          return { rows: [] };
        },
        release: () => {},
      });

      try {
        const res = await fetch(`${baseUrl}/api/webhook/paystack`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-paystack-signature': signature,
          },
          body: rawBody,
        });

        assert.equal(res.status, 200);
        const text = await res.text();
        assert.equal(text, 'Webhook already processed');
      } finally {
        pool.connect = originalConnect;
      }
    });
  });

  // ==========================================
  // 5. DEVICE PROFILE ENDPOINT
  // ==========================================
  describe('GET /api/devices/:deviceId', () => {
    it('should return 400 Bad Request if deviceId is invalid or too short', async () => {
      const res = await fetch(`${baseUrl}/api/devices/ab`); // length < 3
      assert.equal(res.status, 400);

      const body = await res.json() as any;
      assert.equal(body.success, false);
      assert.equal(body.error, 'Invalid device ID specification');
    });

    it('should return device balance and recent transactions for valid deviceId', async () => {
      const originalConnect = pool.connect;
      const mockBalance = '25.50';
      const mockLastUpdated = new Date().toISOString();
      const mockTxRows = [
        { id: 1, type: 'topup', amount: 25.5, timestamp: new Date().toISOString() },
      ];

      (pool as any).connect = async () => ({
        query: async (queryText: string) => {
          if (queryText.includes('INSERT INTO devices')) {
            return {
              rows: [{ current_balance: mockBalance, last_updated: mockLastUpdated }],
            };
          }
          if (queryText.includes('SELECT id, type, amount')) {
            return { rows: mockTxRows };
          }
          return { rows: [] };
        },
        release: () => {},
      });

      try {
        const res = await fetch(`${baseUrl}/api/devices/device_001`);
        assert.equal(res.status, 200);

        const body = await res.json() as any;
        assert.equal(body.success, true);
        assert.equal(body.deviceId, 'device_001');
        assert.equal(body.balance, 25.5);
        assert.ok(Array.isArray(body.transactions));
      } finally {
        pool.connect = originalConnect;
      }
    });
  });

  // ==========================================
  // 6. TRANSACTION VERIFICATION ENDPOINT
  // ==========================================
  describe('GET /api/transactions/verify/:reference', () => {
    it('should return status pending if transaction reference is not yet processed', async () => {
      const originalQuery = pool.query;
      (pool as any).query = async () => ({ rows: [] });

      try {
        const res = await fetch(`${baseUrl}/api/transactions/verify/unprocessed_ref`);
        assert.equal(res.status, 200);

        const body = await res.json() as any;
        assert.deepEqual(body, {
          status: 'pending',
          message: 'Payment confirmation processing by background workers.',
        });
      } finally {
        pool.query = originalQuery;
      }
    });

    it('should return token details if transaction reference exists', async () => {
      const originalQuery = pool.query;
      const mockToken = {
        kwh_amount: '10.00',
        expires_at: '2026-08-13T18:00:00.000Z',
        used: false,
      };

      (pool as any).query = async () => ({ rows: [mockToken] });

      try {
        const res = await fetch(`${baseUrl}/api/transactions/verify/ref_processed_123`);
        assert.equal(res.status, 200);

        const body = await res.json() as any;
        assert.deepEqual(body, {
          status: 'success',
          data: {
            kwhAmount: '10.00',
            expiresAt: '2026-08-13T18:00:00.000Z',
            used: false,
          },
        });
      } finally {
        pool.query = originalQuery;
      }
    });
  });
});
