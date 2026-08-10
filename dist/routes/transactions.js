"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_js_1 = __importDefault(require("../db.js"));
const router = express_1.default.Router();
router.get('/verify/:reference', async (req, res) => {
    try {
        const { reference } = req.params;
        if (!reference) {
            return res.status(400).json({ status: 'failed', error: 'Missing transaction reference' });
        }
        // Perform a lightweight, non-locking read query
        const result = await db_js_1.default.query(`SELECT kwh_amount, expires_at, used 
       FROM paygo_tokens 
       WHERE paystack_reference = $1`, [reference]);
        // CASE 1: Webhook has not executed yet (or payment failed entirely)
        if (result.rows.length === 0) {
            return res.status(200).json({
                status: 'pending',
                message: 'Payment confirmation processing by background workers.'
            });
        }
        // CASE 2: Token row was successfully written by the webhook transaction
        const tokenData = result.rows[0];
        return res.status(200).json({
            status: 'success',
            data: {
                kwhAmount: tokenData.kwh_amount,
                expiresAt: tokenData.expires_at,
                used: tokenData.used
            }
        });
    }
    catch (error) {
        console.error('CRITICAL: Transaction verification failed:', error);
        return res.status(500).json({
            status: 'failed',
            error: 'Internal database processing error'
        });
    }
});
exports.default = router;
//# sourceMappingURL=transactions.js.map