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

  after(async () => {
    try {
      const mqttService = (await import('../mqtt-client.js')).default;
      mqttService.disconnect();
    } catch (err) {}
    try {
      await pool.end();
    } catch (err) {}
    server.close();
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
  // ==========================================
  // AUTH ENDPOINTS (REGISTER, LOGIN, ME)
  // ==========================================
  describe('AUTH ENDPOINTS', () => {
    it('POST /api/auth/register - should validate missing fields', async () => {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'newbuyer@example.com' }), // missing password
      });

      assert.equal(res.status, 400);
      const body = await res.json() as any;
      assert.equal(body.success, false);
      assert.equal(body.error, 'Email and password are required');
    });

    it('POST /api/auth/register - should create user and return JWT token', async () => {
      const originalQuery = pool.query;
      const mockUser = {
        id: 10,
        email: 'newbuyer@example.com',
        phone: '08012345678',
        role: 'BUYER',
        created_at: new Date().toISOString(),
      };

      (pool as any).query = async (queryText: string) => {
        if (queryText.includes('SELECT id FROM users')) {
          return { rows: [] }; // No existing user
        }
        if (queryText.includes('INSERT INTO users')) {
          return { rows: [mockUser] };
        }
        return { rows: [] };
      };

      try {
        const res = await fetch(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'newbuyer@example.com',
            password: 'securepassword123',
            phone: '08012345678',
            role: 'BUYER',
          }),
        });

        assert.equal(res.status, 201);
        const body = await res.json() as any;
        assert.equal(body.success, true);
        assert.ok(body.token);
        assert.equal(body.user.email, 'newbuyer@example.com');
        assert.equal(body.user.role, 'BUYER');
      } finally {
        pool.query = originalQuery;
      }
    });

    it('POST /api/auth/login - should authenticate valid user credentials', async () => {
      const originalQuery = pool.query;
      const bcrypt = await import('bcrypt');
      const passwordHash = await bcrypt.hash('securepassword123', 10);

      const mockUser = {
        id: 10,
        email: 'newbuyer@example.com',
        phone: '08012345678',
        password_hash: passwordHash,
        role: 'BUYER',
      };

      (pool as any).query = async () => ({ rows: [mockUser] });

      try {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'newbuyer@example.com',
            password: 'securepassword123',
          }),
        });

        assert.equal(res.status, 200);
        const body = await res.json() as any;
        assert.equal(body.success, true);
        assert.ok(body.token);
        assert.equal(body.user.email, 'newbuyer@example.com');
      } finally {
        pool.query = originalQuery;
      }
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
              rows: [{ current_balance: mockBalance, status: 'ONLINE', last_seen_at: mockLastUpdated, last_updated: mockLastUpdated }],
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
        assert.equal(body.status, 'ONLINE');
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

  // ==========================================
  // 7. REMOTE RECHARGE & MQTT HARDWARE INTEGRATION TESTS
  // ==========================================
  describe('REMOTE RECHARGE & MQTT HARDWARE LIFECYCLE', () => {

    it('Test 1 — Webhook payment succeeds with PENDING hardware status when MQTT is disconnected', async () => {
      const secret = process.env.PAYSTACK_SECRET_KEY || 'sk_test_89821baac945f63f2e385317afa688602a5f3683';
      const payload = {
        event: 'charge.success',
        data: {
          amount: 500000, // ₦5,000 paid
          customer: { email: 'buyer_test@example.com' },
          metadata: { deviceId: 'device_test_001' },
          reference: 'ref_offline_test_101',
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

      const executedQueries: string[] = [];
      const originalConnect = pool.connect;

      (pool as any).connect = async () => ({
        query: async (queryText: string, params?: any[]) => {
          executedQueries.push(queryText);
          if (queryText.includes('FOR UPDATE')) {
            return { rows: [] }; // No duplicate reference
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

        // Verify DB balance upsert and PENDING transaction insertion occurred
        const hasBalanceUpsert = executedQueries.some((q) => q.includes('INSERT INTO devices'));
        const hasPendingTxInsert = executedQueries.some((q) => q.includes('INSERT INTO transactions') && q.includes('PENDING'));
        const hasTokenAutoCreditedInsert = executedQueries.some((q) => q.includes('INSERT INTO paygo_tokens') && q.includes('auto_credited'));

        assert.ok(hasBalanceUpsert, 'DB device balance upsert must execute');
        assert.ok(hasPendingTxInsert, 'Transaction record with PENDING hardware status must be inserted');
        assert.ok(hasTokenAutoCreditedInsert, 'Fallback token with auto_credited=true must be inserted');
      } finally {
        pool.connect = originalConnect;
      }
    });

    it('Test 2 — Device ACK updates hardware status from PENDING to CONFIRMED', async () => {
      const originalQuery = pool.query;
      let updatedStatus: string | null = null;
      let targetTxId: string | null = null;

      (pool as any).query = async (queryText: string, params?: any[]) => {
        if (queryText.includes('UPDATE transactions SET hardware_status')) {
          updatedStatus = params?.[0] || null; // Could be params from hardware_status = $1 WHERE transaction_id = $2
          if (queryText.includes("'CONFIRMED'")) updatedStatus = 'CONFIRMED';
        }
        return { rows: [] };
      };

      try {
        // Import mqttService to simulate ACK reception
        const mqttService = (await import('../mqtt-client.js')).default;
        
        // Simulate hardware ACK message handler directly
        const ackPayload = {
          action: 'CREDIT_ACK',
          transactionId: 'TXN_TEST_CONFIRM_999',
          deviceId: 'device_test_001',
          status: 'ACCEPTED',
          balance: 25.0,
          timestamp: new Date().toISOString(),
        };

        // Trigger ACK processing
        await (mqttService as any).handleCreditAck('device_test_001', ackPayload);

        assert.equal(updatedStatus, 'CONFIRMED', 'ACK ACCEPTED must update hardware_status to CONFIRMED');
      } finally {
        pool.query = originalQuery;
      }
    });

    it('Test 3 — ESP32 Idempotency Simulation ignores duplicate transactionId', () => {
      // Simulate ESP32 NVS/flash persistent transaction tracker
      const esp32ProcessedTxIds = new Set<string>();
      let esp32MeterBalance = 10.0; // initial balance 10 kWh

      const processIncomingCreditCommandOnEsp32 = (command: { transactionId: string; kwh: number }) => {
        if (esp32ProcessedTxIds.has(command.transactionId)) {
          // Duplicate transaction detected! Do not add balance again.
          return { status: 'ACCEPTED', balance: esp32MeterBalance, duplicateIgnored: true };
        }

        // New transaction! Add balance and track ID in persistent storage
        esp32MeterBalance += command.kwh;
        esp32ProcessedTxIds.add(command.transactionId);
        return { status: 'ACCEPTED', balance: esp32MeterBalance, duplicateIgnored: false };
      };

      const commandPayload = { transactionId: 'TXN_UNIQUE_555', kwh: 15.0 };

      // First execution
      const firstRun = processIncomingCreditCommandOnEsp32(commandPayload);
      assert.equal(firstRun.duplicateIgnored, false);
      assert.equal(esp32MeterBalance, 25.0);

      // Duplicate execution (e.g. MQTT retry or re-publish)
      const duplicateRun = processIncomingCreditCommandOnEsp32(commandPayload);
      assert.equal(duplicateRun.duplicateIgnored, true);
      assert.equal(esp32MeterBalance, 25.0, 'Meter balance must NOT increase a second time');
    });

    it('Test 4 — Fallback token redemption skips DB balance addition when auto_credited is true', async () => {
      const originalConnect = pool.connect;
      const bcrypt = await import('bcrypt');
      const mockTokenCode = '1234567887654321';
      const mockTokenHash = await bcrypt.hash(mockTokenCode, 10);

      let balanceAddedToDb = false;

      (pool as any).connect = async () => ({
        query: async (queryText: string, params?: any[]) => {
          if (queryText.includes('SELECT id, token_hash')) {
            return {
              rows: [{
                id: 42,
                token_hash: mockTokenHash,
                kwh_amount: '10.00',
                auto_credited: true,
                transaction_id: 'TXN_FALLBACK_123',
              }],
            };
          }
          if (queryText.includes('SELECT current_balance FROM devices')) {
            return { rows: [{ current_balance: '50.00' }] };
          }
          if (queryText.includes('UPDATE devices SET current_balance')) {
            balanceAddedToDb = true; // Should NOT be called for auto_credited tokens
          }
          return { rows: [] };
        },
        release: () => {},
      });

      try {
        const mqttService = (await import('../mqtt-client.js')).default;
        await (mqttService as any).handleRedemption('device_test_001', mockTokenCode);

        assert.equal(balanceAddedToDb, false, 'Fallback token redemption must NOT add balance to DB if auto_credited=true');
      } finally {
        pool.connect = originalConnect;
      }
    });

    it('Test 5 — Paystack duplicate webhook returns 200 and prevents duplicate DB credit', async () => {
      const secret = process.env.PAYSTACK_SECRET_KEY || 'sk_test_89821baac945f63f2e385317afa688602a5f3683';
      const payload = {
        event: 'charge.success',
        data: {
          amount: 200000,
          customer: { email: 'buyer_dup@example.com' },
          metadata: { deviceId: 'device_test_001' },
          reference: 'ref_duplicate_check_777',
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

      const originalConnect = pool.connect;
      let balanceAdded = false;

      (pool as any).connect = async () => ({
        query: async (queryText: string) => {
          if (queryText.includes('SELECT id FROM transactions')) {
            return { rows: [{ id: 99 }] }; // Reference ALREADY exists in transactions table
          }
          if (queryText.includes('INSERT INTO devices')) {
            balanceAdded = true;
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
        assert.equal(balanceAdded, false, 'Duplicate webhook must NOT add balance to DB');
      } finally {
        pool.connect = originalConnect;
      }
    });
  });
});
});
