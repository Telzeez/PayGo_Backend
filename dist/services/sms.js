"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendSms = sendSms;
const axios_1 = __importDefault(require("axios"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
async function sendSms(phoneNumber, tokenCode) {
    try {
        const apiKey = process.env.SMS_API_KEY || '';
        if (!apiKey) {
            console.log(`📱 [DEV] Token for ${phoneNumber}: ${tokenCode}`);
            console.warn('SMS not sent - SMS_API_KEY not configured');
            return;
        }
        const response = await axios_1.default.post(process.env.BASE_URL || '', {
            to: phoneNumber,
            from: "PAYGO",
            sms: `Your PAYGO token is ${tokenCode}. valid for 72 hours.`,
            type: 'plain',
            channel: 'generic',
            api_key: apiKey,
        }, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log(`📨 SMS sent to ${phoneNumber}: ${tokenCode}`);
    }
    catch (error) {
        console.log(`📱 [FALLBACK] Token for ${phoneNumber}: ${tokenCode}`);
        console.warn('SMS sending failed:', error);
    }
}
//# sourceMappingURL=sms.js.map