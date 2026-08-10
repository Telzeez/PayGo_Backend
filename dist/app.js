"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const middleware_js_1 = require("./middlewares/middleware.js");
const auth_js_1 = __importDefault(require("./routes/auth.js"));
const webhook_js_1 = __importDefault(require("./routes/webhook.js"));
const payment_js_1 = __importDefault(require("./routes/payment.js"));
const devices_js_1 = __importDefault(require("./routes/devices.js"));
const transactions_js_1 = __importDefault(require("./routes/transactions.js"));
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
// Intercept raw buffer during global JSON parsing
app.use(express_1.default.json({
    verify: (req, _res, buf) => {
        if (buf && buf.length) {
            req.rawBody = buf; // This makes req.rawBody globally available
        }
    },
}));
// Request logger
app.use(middleware_js_1.requestLogger);
// Register routes
app.use('/api/auth', auth_js_1.default);
app.use('/api/webhook', webhook_js_1.default);
app.use('/api/payment', payment_js_1.default);
app.use('/api/devices', devices_js_1.default);
app.use('/api/transactions', transactions_js_1.default);
// Health check endpoint
app.get('/health', (_req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });
});
app.use(middleware_js_1.notFoundError);
app.use(middleware_js_1.globalError);
exports.default = app;
//# sourceMappingURL=app.js.map