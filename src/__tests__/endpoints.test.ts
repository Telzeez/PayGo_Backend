import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import pool from '../db.js';
import axios from 'axios';

let server: http.Server;
let baseUrl: string;

const createAuthToken = (
  email = 'buyer@example.com',
  role = 'BUYER',
  isBuyer = role === 'BUYER',
  isSeller = role === 'SELLER',
) => jwt.sign(
  { userId: 10, email, role, isBuyer, isSeller },
  process.env.JWT_SECRET || 'paygo_default_jwt_secret_key_2026'
);

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
    it('POST /api/auth/become-seller enables seller capability without changing account identity', async () => {
      const originalQuery = pool.query;
      (pool as any).query = async (queryText: string, params?: unknown[]) => {
        assert.match(queryText, /UPDATE users/);
        assert.deepEqual(params, [10]);
        return {
          rows: [{
            id: 10,
            email: 'buyer@example.com',
            phone: null,
            role: 'USER',
            is_buyer: true,
            is_seller: true,
          }],
        };
      };

      try {
        const response = await fetch(`${baseUrl}/api/auth/become-seller`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${createAuthToken('buyer@example.com', 'USER', true)}` },
        });
        assert.equal(response.status, 200);
        const body = await response.json() as any;
        assert.equal(body.user.role, 'USER');
        assert.equal(body.user.isBuyer, true);
        assert.equal(body.user.isSeller, true);
        const token = jwt.verify(body.token, process.env.JWT_SECRET || 'paygo_default_jwt_secret_key_2026') as jwt.JwtPayload;
        assert.equal(token.role, 'USER');
        assert.equal(token.isBuyer, true);
        assert.equal(token.isSeller, true);
      } finally {
        pool.query = originalQuery;
      }
    });

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

  describe('POST /api/admin/devices/:deviceId/assign', () => {
    it('requires an authenticated owner account', async () => {
      const anonymousResponse = await fetch(`${baseUrl}/api/admin/devices/DEVICE-001/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(anonymousResponse.status, 401);

      const buyerResponse = await fetch(`${baseUrl}/api/admin/devices/DEVICE-001/assign`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${createAuthToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      assert.equal(buyerResponse.status, 403);
    });

    it('does not request assignment details or link meters while prototype assignment is disabled', async () => {
      const response = await fetch(`${baseUrl}/api/admin/devices/DEVICE-001/assign`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${createAuthToken('owner@example.com', 'OWNER', false)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        success: false,
        error: 'Meter assignment is temporarily disabled for the prototype.',
      });
    });
  });

  describe('GET /api/marketplace/sources/me', () => {
    it('requires seller capability rather than buyer or owner role alone', async () => {
      const buyerResponse = await fetch(`${baseUrl}/api/marketplace/sources/me`, {
        headers: { Authorization: `Bearer ${createAuthToken('buyer@example.com', 'USER', true)}` },
      });
      assert.equal(buyerResponse.status, 403);

      const ownerResponse = await fetch(`${baseUrl}/api/marketplace/sources/me`, {
        headers: { Authorization: `Bearer ${createAuthToken('owner@example.com', 'OWNER', false)}` },
      });
      assert.equal(ownerResponse.status, 403);

      const originalQuery = pool.query;
      (pool as any).query = async (queryText: string) => {
        assert.match(queryText, /FROM energy_sources s/);
        return { rows: [] };
      };

      try {
        const sellerResponse = await fetch(`${baseUrl}/api/marketplace/sources/me`, {
          headers: {
            Authorization: `Bearer ${createAuthToken('seller@example.com', 'USER', true, true)}`,
          },
        });
        assert.equal(sellerResponse.status, 200);
      } finally {
        pool.query = originalQuery;
      }
    });
  });

  describe('POST /api/marketplace/listings/:id/purchase', () => {
    const authorization = () => 'Bearer ' + createAuthToken();
    const requestBody = (buyerDeviceId: string, buyerLatitude = 7.44, buyerLongitude = 3.9) => ({
      kwhRequested: 2,
      buyerLatitude,
      buyerLongitude,
      buyerDeviceId,
    });

    const mockPurchase = async (
      listingOverrides: Record<string, unknown> = {},
      buyerLatitude = 7.44,
      buyerLongitude = 3.9,
      sellerMeterLinked = true,
    ) => {
      const originalConnect = pool.connect;
      const statements: Array<{ sql: string; params?: unknown[] }> = [];
      (pool as any).connect = async () => ({
        query: async (sql: string, params?: unknown[]) => {
          statements.push({ sql, params });
          if (sql.includes('FROM energy_listings l') && sql.includes('FOR UPDATE')) {
            return {
              rows: [{
                id: 5,
                seller_id: 20,
                energy_source_id: 9,
                available_kwh: '10',
                reserved_kwh: '0',
                price_per_kwh: '200',
                status: 'ACTIVE',
                expires_at: new Date(Date.now() + 60_000).toISOString(),
                source_owner_id: 20,
                source_status: 'ACTIVE',
                is_demo: false,
                seller_is_seller: true,
                seller_role: 'USER',
                device_id: 'seller_source_meter',
                source_lat: '7.44',
                source_lon: '3.9',
                service_radius_m: 500,
                ...listingOverrides,
              }],
            };
          }
          if (sql.includes('FROM user_devices')) {
            if (params?.[0] === 10) {
              return { rows: [{ device_id: 'buyer_destination_meter' }] };
            }
            return { rows: sellerMeterLinked ? [{ device_id: 'seller_source_meter' }] : [] };
          }
          if (sql.includes('INSERT INTO marketplace_purchases')) {
            return { rows: [{ id: 81, deviceId: params?.[4], status: 'RESERVED' }] };
          }
          return { rows: [] };
        },
        release: () => {},
      });

      try {
        const response = await fetch(`${baseUrl}/api/marketplace/listings/5/purchase`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authorization() },
          body: JSON.stringify(requestBody('buyer_destination_meter', buyerLatitude, buyerLongitude)),
        });
        return { response, statements };
      } finally {
        pool.connect = originalConnect;
      }
    };

    it('captures the explicitly selected buyer meter, not the seller source meter', async () => {
      const originalConnect = pool.connect;
      const statements: Array<{ sql: string; params?: unknown[] }> = [];
      (pool as any).connect = async () => ({
        query: async (sql: string, params?: unknown[]) => {
          statements.push({ sql, params });
          if (sql.includes('FROM energy_listings l') && sql.includes('FOR UPDATE')) {
            return {
              rows: [{
                id: 5,
                seller_id: 20,
                energy_source_id: 9,
                available_kwh: '10',
                reserved_kwh: '0',
                price_per_kwh: '200',
                status: 'ACTIVE',
                expires_at: new Date(Date.now() + 60_000).toISOString(),
                source_owner_id: 20,
                source_status: 'ACTIVE',
                is_demo: false,
                seller_is_seller: true,
                seller_role: 'USER',
                device_id: 'seller_source_meter',
                source_lat: '7.44',
                source_lon: '3.9',
                service_radius_m: 500,
              }],
            };
          }
          if (sql.includes('FROM user_devices')) {
            if (params?.[0] === 10) {
              assert.deepEqual(params, [10, 'buyer_destination_meter']);
              return { rows: [{ device_id: 'buyer_destination_meter' }] };
            }
            return { rows: [{ device_id: 'seller_source_meter' }] };
          }
          if (sql.includes('INSERT INTO marketplace_purchases')) {
            return {
              rows: [{
                id: 81,
                deviceId: params?.[4],
                status: 'RESERVED',
              }],
            };
          }
          return { rows: [] };
        },
        release: () => {},
      });

      try {
        const response = await fetch(`${baseUrl}/api/marketplace/listings/5/purchase`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authorization() },
          body: JSON.stringify(requestBody('buyer_destination_meter')),
        });

        assert.equal(response.status, 201);
        const body = await response.json() as any;
        assert.equal(body.purchase.deviceId, 'buyer_destination_meter');
        assert.equal(
          statements.some(({ sql, params }) =>
            sql.includes('UPDATE energy_listings') && params?.[1] === 5
          ),
          true
        );
      } finally {
        pool.connect = originalConnect;
      }
    });

    it('rejects a meter that is not linked to the buyer account', async () => {
      const originalConnect = pool.connect;
      const statements: string[] = [];
      (pool as any).connect = async () => ({
        query: async (sql: string) => {
          statements.push(sql);
          if (sql.includes('FROM energy_listings l') && sql.includes('FOR UPDATE')) {
            return {
              rows: [{
                id: 5,
                seller_id: 20,
                energy_source_id: 9,
                available_kwh: '10',
                reserved_kwh: '0',
                price_per_kwh: '200',
                status: 'ACTIVE',
                device_id: 'seller_source_meter',
                source_lat: '7.44',
                source_lon: '3.9',
                service_radius_m: 500,
              }],
            };
          }
          if (sql.includes('FROM user_devices')) {
            return { rows: [] };
          }
          return { rows: [] };
        },
        release: () => {},
      });

      try {
        const response = await fetch(`${baseUrl}/api/marketplace/listings/5/purchase`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authorization() },
          body: JSON.stringify(requestBody('unlinked_meter')),
        });

        assert.equal(response.status, 400);
        const body = await response.json() as any;
        assert.equal(body.error, 'The selected destination meter is not linked to your account.');
        assert.equal(statements.some((sql) => sql.includes('UPDATE energy_listings')), false);
      } finally {
        pool.connect = originalConnect;
      }
    });

    it('rejects purchase when buyer is outside the seller service radius', async () => {
      const { response, statements } = await mockPurchase({}, 8, 3.9);
      assert.equal(response.status, 400);
      const body = await response.json() as any;
      assert.match(body.error, /outside allowed service radius/);
      assert.equal(statements.some(({ sql }) => sql.includes('UPDATE energy_listings')), false);
    });

    it('rejects paused, expired and demo-only listings without reserving energy', async () => {
      const cases = [
        {
          name: 'paused listing',
          listing: { status: 'PAUSED' },
          error: /no longer active/,
        },
        {
          name: 'expired listing',
          listing: { expires_at: new Date(Date.now() - 60_000).toISOString() },
          error: /has expired/,
        },
        {
          name: 'demo-only listing',
          listing: { is_demo: true },
          error: /not available for marketplace purchases/,
        },
        {
          name: 'source owned by another account',
          listing: { source_owner_id: 21 },
          error: /does not own its source/,
        },
        {
          name: 'seller capability disabled',
          listing: { seller_is_seller: false, seller_role: 'USER' },
          error: /Seller capability is no longer enabled/,
        },
      ];

      for (const testCase of cases) {
        const { response, statements } = await mockPurchase(testCase.listing);
        assert.equal(response.status, 400, testCase.name);
        const body = await response.json() as any;
        assert.match(body.error, testCase.error, testCase.name);
        assert.equal(
          statements.some(({ sql }) => sql.includes('UPDATE energy_listings')),
          false,
          testCase.name
        );
      }
    });

    it('rejects a seller whose source meter is no longer linked to their account', async () => {
      const { response, statements } = await mockPurchase({}, 7.44, 3.9, false);
      assert.equal(response.status, 400);
      const body = await response.json() as any;
      assert.equal(body.error, 'Seller no longer owns the meter for this energy source.');
      assert.equal(statements.some(({ sql }) => sql.includes('UPDATE energy_listings')), false);
    });
  });

  // ==========================================
  // 3. PAYMENT INITIATION ENDPOINT
  // ==========================================
  describe('POST /api/payment/initiate', () => {
    const authorization = () => `Bearer ${createAuthToken()}`;

    it('should return 400 Bad Request when mandatory fields are missing', async () => {
      const res = await fetch(`${baseUrl}/api/payment/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization() },
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
        headers: { 'Content-Type': 'application/json', Authorization: authorization() },
        body: JSON.stringify({ amount: 50, email: 'buyer@example.com', deviceId: 'device_001' }),
      });

      assert.equal(res.status, 400);
      const body = await res.json() as any;
      assert.equal(body.success, false);
      assert.equal(body.error, 'Minimum payment is #100');
    });

    it('should successfully initialize payment via Paystack and return paymentUrl', async () => {
      const originalPost = axios.post;
      const originalQuery = pool.query;
      (pool as any).query = async (queryText: string) => {
        assert.match(queryText, /FROM user_devices/);
        return { rows: [{ '?column?': 1 }] };
      };
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
          headers: { 'Content-Type': 'application/json', Authorization: authorization() },
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
        pool.query = originalQuery;
      }
    });

    it('should attach the seller subaccount to marketplace payments only', async () => {
      const originalPost = axios.post;
      const originalQuery = pool.query;
      let paystackPayload: Record<string, unknown> | undefined;
      (pool as any).query = async (queryText: string) => {
        if (queryText.includes('FROM user_devices')) {
          return { rows: [{ '?column?': 1 }] };
        }
        if (queryText.includes('paystack_subaccount_code')) {
          return { rows: [{ subaccountCode: 'ACCT_seller_123' }] };
        }
        throw new Error(`Unexpected query: ${queryText}`);
      };
      (axios as any).post = async (_url: string, data: Record<string, unknown>) => {
        paystackPayload = data;
        return {
          data: {
            status: true,
            data: {
              authorization_url: 'https://checkout.paystack.com/marketplace_token',
              reference: 'marketplace_ref_123',
            },
          },
        };
      };

      try {
        const res = await fetch(`${baseUrl}/api/payment/initiate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authorization() },
          body: JSON.stringify({
            amount: 1000,
            email: 'buyer@example.com',
            deviceId: 'buyer_meter_001',
            marketplacePurchaseId: 25,
          }),
        });

        assert.equal(res.status, 200);
        assert.equal(paystackPayload?.subaccount, 'ACCT_seller_123');
      } finally {
        axios.post = originalPost;
        pool.query = originalQuery;
      }
    });
  });

  describe('PUT /api/marketplace/payout-account', () => {
    it('verifies bank details and creates a 90/10 seller/platform subaccount', async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalQuery = pool.query;
      const sellerToken = jwt.sign(
        { userId: 10, email: 'seller@example.com', role: 'OWNER', isBuyer: false, isSeller: true },
        process.env.JWT_SECRET || 'paygo_default_jwt_secret_key_2026'
      );
      const sellerAuthorization = `Bearer ${sellerToken}`;
      let subaccountPayload: Record<string, unknown> | undefined;

      (axios as any).get = async (url: string) => {
        if (url.includes('/bank?')) {
          return { data: { status: true, data: [{ name: 'Test Bank', code: '001', active: true }] } };
        }
        if (url.includes('/bank/resolve?')) {
          return { data: { status: true, data: { account_name: 'Seller Name' } } };
        }
        throw new Error(`Unexpected Paystack URL: ${url}`);
      };
      (axios as any).post = async (_url: string, data: Record<string, unknown>) => {
        subaccountPayload = data;
        return { data: { status: true, data: { subaccount_code: 'ACCT_seller_123' } } };
      };
      (pool as any).query = async (queryText: string) => {
        if (queryText.includes('SELECT paystack_subaccount_code')) {
          return { rows: [{ subaccountCode: null }] };
        }
        if (queryText.includes('UPDATE users')) {
          return { rows: [{ id: 10 }] };
        }
        throw new Error(`Unexpected query: ${queryText}`);
      };

      try {
        const res = await fetch(`${baseUrl}/api/marketplace/payout-account`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: sellerAuthorization },
          body: JSON.stringify({
            businessName: 'Seller Business',
            bankCode: '001',
            accountNumber: '1234567890',
          }),
        });

        assert.equal(res.status, 200);
        assert.equal(subaccountPayload?.percentage_charge, 10);
        const body = await res.json() as any;
        assert.equal(body.account.sellerPayoutPercentage, 90);
        assert.equal(body.account.accountNumberLast4, '7890');
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        pool.query = originalQuery;
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

    it('should process charge.success webhook atomically and dispatch remote credit', async () => {
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
      const res = await fetch(`${baseUrl}/api/devices/ab`, {
        headers: { Authorization: `Bearer ${createAuthToken()}` },
      }); // length < 3
      assert.equal(res.status, 400);

      const body = await res.json() as any;
      assert.equal(body.success, false);
      assert.equal(body.error, 'Invalid device ID specification');
    });

    it('should return device balance and recent transactions for valid deviceId', async () => {
      const originalConnect = pool.connect;
      const originalQuery = pool.query;
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
      (pool as any).query = async (queryText: string) => {
        assert.match(queryText, /FROM user_devices/);
        return { rows: [{ '?column?': 1 }] };
      };

      try {
        const res = await fetch(`${baseUrl}/api/devices/device_001`, {
          headers: { Authorization: `Bearer ${createAuthToken()}` },
        });
        assert.equal(res.status, 200);

        const body = await res.json() as any;
        assert.equal(body.success, true);
        assert.equal(body.deviceId, 'device_001');
        assert.equal(body.balance, 25.5);
        assert.equal(body.status, 'ONLINE');
        assert.ok(Array.isArray(body.transactions));
      } finally {
        pool.connect = originalConnect;
        pool.query = originalQuery;
      }
    });
  });

  // ==========================================
  // 6. TRANSACTION VERIFICATION ENDPOINT
  // ==========================================
  describe('GET /api/transactions/verify/:reference', () => {
    it('should return status pending if transaction reference is not yet processed', async () => {
      const originalQuery = pool.query;
      const originalGet = axios.get;
      (pool as any).query = async () => ({ rows: [] });
      (axios as any).get = async () => ({ data: { status: true, data: { status: 'pending' } } });

      try {
        const res = await fetch(`${baseUrl}/api/transactions/verify/unprocessed_ref`, {
          headers: { Authorization: `Bearer ${createAuthToken()}` },
        });
        assert.equal(res.status, 200);

        const body = await res.json() as any;
        assert.deepEqual(body, {
          status: 'pending',
          message: 'Payment confirmation processing by background workers.',
        });
      } finally {
        pool.query = originalQuery;
        axios.get = originalGet;
      }
    });

    it('should return remote hardware status if transaction reference exists', async () => {
      const originalQuery = pool.query;
      const mockTransaction = {
        kwh_amount: '10.00',
        hardware_status: 'CONFIRMED',
        device_id: 'device_001',
      };

      (pool as any).query = async (queryText: string) => {
        assert.match(queryText, /FROM transactions/);
        return { rows: [mockTransaction] };
      };

      try {
        const res = await fetch(`${baseUrl}/api/transactions/verify/ref_processed_123`, {
          headers: { Authorization: `Bearer ${createAuthToken()}` },
        });
        assert.equal(res.status, 200);

        const body = await res.json() as any;
        assert.deepEqual(body, {
          status: 'success',
          data: {
            kwhAmount: 10,
            hardwareStatus: 'CONFIRMED',
            deviceId: 'device_001',
          },
        });
        assert.equal('fallbackToken' in body.data, false);
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

        assert.ok(hasBalanceUpsert, 'DB device balance upsert must execute');
        assert.ok(hasPendingTxInsert, 'Transaction record with PENDING hardware status must be inserted');
        assert.equal(executedQueries.some((q) => q.includes('INSERT INTO paygo_tokens')), false, 'Payment must not create a fallback token');
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

    it('records MQTT energy consumption as a Naira debit, not a zero-value credit', async () => {
      const originalConnect = pool.connect;
      let consumptionParams: unknown[] | undefined;

      (pool as any).connect = async () => ({
        query: async (queryText: string, params?: unknown[]) => {
          if (queryText.includes('SELECT current_balance')) {
            return { rows: [{ current_balance: '10.00' }] };
          }
          if (queryText.includes("type, amount, kwh_amount")) {
            consumptionParams = params;
          }
          return { rows: [] };
        },
        release: () => {},
      });

      try {
        const mqttService = (await import('../mqtt-client.js')).default;
        await (mqttService as any).handleEnergyReport('device_test_001', 500);

        assert.deepEqual(consumptionParams, ['device_test_001', -100, 0.5]);
      } finally {
        pool.connect = originalConnect;
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

    it('does not expose or accept manual fallback tokens', async () => {
      const tokensRes = await fetch(`${baseUrl}/api/devices/device_test_001/tokens`);
      const redeemRes = await fetch(`${baseUrl}/api/devices/device_test_001/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '1234567887654321' }),
      });

      assert.equal(tokensRes.status, 404);
      assert.equal(redeemRes.status, 404);
    });

    it('confirms pending remote credit when a hardware heartbeat matches the server balance', async () => {
      const originalQuery = pool.query;
      let confirmationQuery = '';

      (pool as any).query = async (queryText: string) => {
        if (queryText.includes('UPDATE transactions')) {
          confirmationQuery = queryText;
        }
        if (queryText.includes('SELECT current_balance')) {
          return { rows: [{ current_balance: '25.00' }] };
        }
        return { rows: [] };
      };

      try {
        const res = await fetch(`${baseUrl}/api/devices/device_test_001/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remaining_balance: 25 }),
        });

        assert.equal(res.status, 200);
        assert.match(confirmationQuery, /hardware_status = 'CONFIRMED'/);
        assert.match(confirmationQuery, /ABS\(\$2::numeric/);
      } finally {
        pool.query = originalQuery;
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
