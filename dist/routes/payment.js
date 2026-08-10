"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const router = express_1.default.Router();
router.post('/initiate', async (req, res) => {
    try {
        const { amount, email, deviceId } = req.body;
        if (!amount || !email || !deviceId) {
            return res.status(400).json({
                success: false,
                error: `Missing required field: amount entered ${!amount ? "null" : amount} email: ${!email ? "null" : email}, deviceId: ${!deviceId ? "null" : deviceId}`
            });
        }
        if (amount < 100) {
            return res.status(400).json({
                success: false,
                error: "Minimum payment is #100"
            });
        }
        // call paystack API
        const response = await axios_1.default.post('https://api.paystack.co/transaction/initialize', {
            email,
            amount: amount * 100,
            metadata: { deviceId },
            callback_url: `${process.env.BASE_URL}/api/webhook/paystack`
        }, {
            headers: {
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });
        if (!response.data.status) {
            return res.status(400).json({
                success: false,
                error: 'Paystack initialization failed'
            });
        }
        res.json({
            success: true,
            paymentUrl: response.data.data.authorization_url,
            reference: response.data.data.reference,
        });
    }
    catch (error) {
        console.error('Payment iniitation error ', error);
        res.status(500).json({
            success: false,
            error: 'Payment initiation failed'
        });
    }
});
exports.default = router;
//# sourceMappingURL=payment.js.map