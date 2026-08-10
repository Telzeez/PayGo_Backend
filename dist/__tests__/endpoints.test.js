"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const crypto_1 = __importDefault(require("crypto"));
const app_js_1 = __importDefault(require("../app.js"));
const db_js_1 = __importDefault(require("../db.js"));
const axios_1 = __importDefault(require("axios"));
let server;
let baseUrl;
(0, node_test_1.describe)('PAYGO API Endpoint Test Suite', () => {
    (0, node_test_1.before)((_context, done) => {
        server = app_js_1.default.listen(0, () => {
            const address = server.address();
            baseUrl = `http://localhost:${address.port}`;
            done();
        });
    });
    (0, node_test_1.after)((_context, done) => {
        server.close(done);
    });
    // ==========================================
    // 1. HEALTH CHECK ENDPOINT
    // ==========================================
    (0, node_test_1.describe)('GET /health', () => {
        (0, node_test_1.it)('should return 200 OK with server status metadata', async () => {
            const res = await fetch(`${baseUrl}/health`);
            strict_1.default.equal(res.status, 200);
            const body = await res.json();
            strict_1.default.equal(body.status, 'OK');
            strict_1.default.ok(body.timestamp);
            strict_1.default.ok(typeof body.uptime === 'number');
        });
        // ==========================================
        // AUTH ENDPOINTS (REGISTER, LOGIN, ME)
        // ==========================================
        (0, node_test_1.describe)('AUTH ENDPOINTS', () => {
            (0, node_test_1.it)('POST /api/auth/register - should validate missing fields', async () => {
                const res = await fetch(`${baseUrl}/api/auth/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: 'newbuyer@example.com' }), // missing password
                });
                strict_1.default.equal(res.status, 400);
                const body = await res.json();
                strict_1.default.equal(body.success, false);
                strict_1.default.equal(body.error, 'Email and password are required');
            });
            (0, node_test_1.it)('POST /api/auth/register - should create user and return JWT token', async () => {
                const originalQuery = db_js_1.default.query;
                const mockUser = {
                    id: 10,
                    email: 'newbuyer@example.com',
                    phone: '08012345678',
                    role: 'BUYER',
                    created_at: new Date().toISOString(),
                };
                db_js_1.default.query = async (queryText) => {
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
                    strict_1.default.equal(res.status, 201);
                    const body = await res.json();
                    strict_1.default.equal(body.success, true);
                    strict_1.default.ok(body.token);
                    strict_1.default.equal(body.user.email, 'newbuyer@example.com');
                    strict_1.default.equal(body.user.role, 'BUYER');
                }
                finally {
                    db_js_1.default.query = originalQuery;
                }
            });
            (0, node_test_1.it)('POST /api/auth/login - should authenticate valid user credentials', async () => {
                const originalQuery = db_js_1.default.query;
                const bcrypt = await import('bcrypt');
                const passwordHash = await bcrypt.hash('securepassword123', 10);
                const mockUser = {
                    id: 10,
                    email: 'newbuyer@example.com',
                    phone: '08012345678',
                    password_hash: passwordHash,
                    role: 'BUYER',
                };
                db_js_1.default.query = async () => ({ rows: [mockUser] });
                try {
                    const res = await fetch(`${baseUrl}/api/auth/login`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            email: 'newbuyer@example.com',
                            password: 'securepassword123',
                        }),
                    });
                    strict_1.default.equal(res.status, 200);
                    const body = await res.json();
                    strict_1.default.equal(body.success, true);
                    strict_1.default.ok(body.token);
                    strict_1.default.equal(body.user.email, 'newbuyer@example.com');
                }
                finally {
                    db_js_1.default.query = originalQuery;
                }
            });
        });
        // ==========================================
        // 2. UNKNOWN ROUTE 404 HANDLER
        // ==========================================
        (0, node_test_1.describe)('GET /api/nonexistent-endpoint', () => {
            (0, node_test_1.it)('should return 404 for unknown endpoints', async () => {
                const res = await fetch(`${baseUrl}/api/nonexistent-endpoint`);
                strict_1.default.equal(res.status, 404);
                const body = await res.json();
                strict_1.default.deepEqual(body, { error: 'Unknown endpoint' });
            });
        });
        // ==========================================
        // 3. PAYMENT INITIATION ENDPOINT
        // ==========================================
        (0, node_test_1.describe)('POST /api/payment/initiate', () => {
            (0, node_test_1.it)('should return 400 Bad Request when mandatory fields are missing', async () => {
                const res = await fetch(`${baseUrl}/api/payment/initiate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ amount: 500, email: 'buyer@example.com' }), // missing deviceId
                });
                strict_1.default.equal(res.status, 400);
                const body = await res.json();
                strict_1.default.equal(body.success, false);
                strict_1.default.ok(body.error.includes('Missing required field'));
            });
            (0, node_test_1.it)('should return 400 Bad Request when payment amount is less than 100', async () => {
                const res = await fetch(`${baseUrl}/api/payment/initiate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ amount: 50, email: 'buyer@example.com', deviceId: 'device_001' }),
                });
                strict_1.default.equal(res.status, 400);
                const body = await res.json();
                strict_1.default.equal(body.success, false);
                strict_1.default.equal(body.error, 'Minimum payment is #100');
            });
            (0, node_test_1.it)('should successfully initialize payment via Paystack and return paymentUrl', async () => {
                const originalPost = axios_1.default.post;
                axios_1.default.post = async () => ({
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
                    strict_1.default.equal(res.status, 200);
                    const body = await res.json();
                    strict_1.default.deepEqual(body, {
                        success: true,
                        paymentUrl: 'https://checkout.paystack.com/test_token_123',
                        reference: 'paystack_ref_9999',
                    });
                }
                finally {
                    axios_1.default.post = originalPost;
                }
            });
        });
        // ==========================================
        // 4. PAYSTACK WEBHOOK ENDPOINT
        // ==========================================
        (0, node_test_1.describe)('POST /api/webhook/paystack', () => {
            (0, node_test_1.it)('should return 401 Unauthorized for invalid HMAC signatures', async () => {
                const res = await fetch(`${baseUrl}/api/webhook/paystack`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-paystack-signature': 'invalid_signature_hash',
                    },
                    body: JSON.stringify({ event: 'charge.success' }),
                });
                strict_1.default.equal(res.status, 401);
                const text = await res.text();
                strict_1.default.equal(text, 'Invalid signature');
            });
            (0, node_test_1.it)('should process charge.success webhook atomically and dispatch token', async () => {
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
                const signature = crypto_1.default.createHmac('sha512', secret).update(rawBody).digest('hex');
                const originalConnect = db_js_1.default.connect;
                db_js_1.default.connect = async () => ({
                    query: async (queryText) => {
                        if (queryText.includes('FOR UPDATE')) {
                            return { rows: [] }; // Idempotency check: no duplicate found
                        }
                        return { rows: [] };
                    },
                    release: () => { },
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
                    strict_1.default.equal(res.status, 200);
                    const text = await res.text();
                    strict_1.default.equal(text, 'Webhook processed');
                }
                finally {
                    db_js_1.default.connect = originalConnect;
                }
            });
            (0, node_test_1.it)('should return 200 for duplicate webhooks (Idempotency)', async () => {
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
                const signature = crypto_1.default.createHmac('sha512', secret).update(rawBody).digest('hex');
                const originalConnect = db_js_1.default.connect;
                db_js_1.default.connect = async () => ({
                    query: async (queryText) => {
                        if (queryText.includes('FOR UPDATE')) {
                            return { rows: [{ id: 1 }] }; // Idempotency check: duplicate row exists!
                        }
                        return { rows: [] };
                    },
                    release: () => { },
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
                    strict_1.default.equal(res.status, 200);
                    const text = await res.text();
                    strict_1.default.equal(text, 'Webhook already processed');
                }
                finally {
                    db_js_1.default.connect = originalConnect;
                }
            });
        });
        // ==========================================
        // 5. DEVICE PROFILE ENDPOINT
        // ==========================================
        (0, node_test_1.describe)('GET /api/devices/:deviceId', () => {
            (0, node_test_1.it)('should return 400 Bad Request if deviceId is invalid or too short', async () => {
                const res = await fetch(`${baseUrl}/api/devices/ab`); // length < 3
                strict_1.default.equal(res.status, 400);
                const body = await res.json();
                strict_1.default.equal(body.success, false);
                strict_1.default.equal(body.error, 'Invalid device ID specification');
            });
            (0, node_test_1.it)('should return device balance and recent transactions for valid deviceId', async () => {
                const originalConnect = db_js_1.default.connect;
                const mockBalance = '25.50';
                const mockLastUpdated = new Date().toISOString();
                const mockTxRows = [
                    { id: 1, type: 'topup', amount: 25.5, timestamp: new Date().toISOString() },
                ];
                db_js_1.default.connect = async () => ({
                    query: async (queryText) => {
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
                    release: () => { },
                });
                try {
                    const res = await fetch(`${baseUrl}/api/devices/device_001`);
                    strict_1.default.equal(res.status, 200);
                    const body = await res.json();
                    strict_1.default.equal(body.success, true);
                    strict_1.default.equal(body.deviceId, 'device_001');
                    strict_1.default.equal(body.balance, 25.5);
                    strict_1.default.ok(Array.isArray(body.transactions));
                }
                finally {
                    db_js_1.default.connect = originalConnect;
                }
            });
        });
        // ==========================================
        // 6. TRANSACTION VERIFICATION ENDPOINT
        // ==========================================
        (0, node_test_1.describe)('GET /api/transactions/verify/:reference', () => {
            (0, node_test_1.it)('should return status pending if transaction reference is not yet processed', async () => {
                const originalQuery = db_js_1.default.query;
                db_js_1.default.query = async () => ({ rows: [] });
                try {
                    const res = await fetch(`${baseUrl}/api/transactions/verify/unprocessed_ref`);
                    strict_1.default.equal(res.status, 200);
                    const body = await res.json();
                    strict_1.default.deepEqual(body, {
                        status: 'pending',
                        message: 'Payment confirmation processing by background workers.',
                    });
                }
                finally {
                    db_js_1.default.query = originalQuery;
                }
            });
            (0, node_test_1.it)('should return token details if transaction reference exists', async () => {
                const originalQuery = db_js_1.default.query;
                const mockToken = {
                    kwh_amount: '10.00',
                    expires_at: '2026-08-13T18:00:00.000Z',
                    used: false,
                };
                db_js_1.default.query = async () => ({ rows: [mockToken] });
                try {
                    const res = await fetch(`${baseUrl}/api/transactions/verify/ref_processed_123`);
                    strict_1.default.equal(res.status, 200);
                    const body = await res.json();
                    strict_1.default.deepEqual(body, {
                        status: 'success',
                        data: {
                            kwhAmount: '10.00',
                            expiresAt: '2026-08-13T18:00:00.000Z',
                            used: false,
                        },
                    });
                }
                finally {
                    db_js_1.default.query = originalQuery;
                }
            });
        });
    });
});
//# sourceMappingURL=endpoints.test.js.map