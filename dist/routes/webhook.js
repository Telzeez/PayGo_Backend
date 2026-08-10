"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const crypto_1 = __importDefault(require("crypto"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const db_js_1 = __importDefault(require("../db.js"));
const sms_js_1 = require("../services/sms.js");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const router = express_1.default.Router();
const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10);
const TOKEN_EXPIRY_HOURS = parseInt(process.env.TOKEN_EXPIRY_HOURS || '72', 10);
const PRICE_PER_KWH = parseFloat(process.env.PRICE_PER_KWH || '200');
router.post('/paystack', async (req, res) => {
    // 🔑 Get a dedicated client from the pool to handle the single transaction session
    const client = await db_js_1.default.connect();
    try {
        const secret = process.env.PAYSTACK_SECRET_KEY || '';
        const signature = req.headers['x-paystack-signature'];
        const rawBodyString = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
        const hash = crypto_1.default.createHmac('sha512', secret).update(rawBodyString).digest('hex');
        if (hash !== signature) {
            console.warn('Invalid Paystack signature');
            client.release(); // Always release the client back to the pool
            return res.status(401).send('Invalid signature');
        }
        const event = req.body;
        if (event.event === 'charge.success') {
            const transaction = event.data;
            const reference = transaction.reference;
            // STEP 1: START THE TRANSACTION
            await client.query('BEGIN');
            // STEP 2: Idempotency Check (Using 'FOR UPDATE' locks this specific row if it exists)
            const existingTx = await client.query('SELECT id FROM paygo_tokens WHERE paystack_reference = $1 FOR UPDATE', [reference]);
            if (existingTx.rows.length > 0) {
                console.log(`Duplicate webhook received. Reference ${reference} already processed.`);
                await client.query('ROLLBACK'); // Safely cancel transaction
                client.release();
                return res.status(200).send('Webhook already processed');
            }
            const buyerEmail = transaction.customer.email;
            const amountPaid = transaction.amount / 100;
            const deviceId = transaction.metadata.deviceId || 'device_001';
            const kwhAmount = amountPaid / PRICE_PER_KWH;
            const tokenCode = crypto_1.default.randomInt(10000000, 99999999).toString();
            const hashedToken = await bcrypt_1.default.hash(tokenCode, SALT_ROUNDS);
            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + TOKEN_EXPIRY_HOURS);
            // STEP 3: Insert token within the transaction session
            try {
                await client.query(`INSERT INTO paygo_tokens 
             (buyer_email, device_id, kwh_amount, token_hash, expires_at, used, paystack_reference) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`, [buyerEmail, deviceId, kwhAmount, hashedToken, expiresAt, false, reference]);
            }
            catch (dbError) {
                if (dbError.code === '23505') {
                    console.log(` Race condition caught. Reference ${reference} processed concurrently.`);
                    await client.query('ROLLBACK');
                    client.release();
                    return res.status(200).send('Webhook already processed');
                }
                throw dbError; // Pass up to the main catch block to trigger full rollback
            }
            // STEP 4: Send the SMS
            // If this throws an error, the catch block will run 'ROLLBACK', erasing the DB entry above
            await (0, sms_js_1.sendSms)(buyerEmail, tokenCode);
            // STEP 5: COMMIT THE TRANSACTION
            // Only makes changes permanent if everything (including SMS) succeeded
            await client.query('COMMIT');
            client.release();
            console.log(`✅ Transaction fully processed. Token ${tokenCode} sent to ${buyerEmail}`);
            return res.status(200).send('Webhook processed');
        }
        client.release();
        res.status(200).send('Event ignored');
    }
    catch (error) {
        // CRITICAL PROTECTION: Erase database modifications if anything failed mid-process
        console.error('Webhook error, rolling back modifications:', error);
        try {
            await client.query('ROLLBACK');
        }
        catch (rollbackError) {
            console.error('Failed to rollback transaction:', rollbackError);
        }
        client.release();
        res.status(500).send('Webhook processing failed');
    }
});
exports.default = router;
//# sourceMappingURL=webhook.js.map