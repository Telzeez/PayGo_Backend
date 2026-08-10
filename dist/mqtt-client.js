"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mqtt_1 = __importDefault(require("mqtt"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const crypto_1 = __importDefault(require("crypto")); // 🔥 Added native crypto for clean client ID generation
const db_js_1 = __importDefault(require("./db.js"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
class MqttService {
    client = null;
    connect() {
        // 🔥 Secure Fallback: Default to local TLS or the value parsed from your .env
        const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtts://localhost:8883';
        const username = process.env.MQTT_USER || '';
        const password = process.env.MQTT_PASS || '';
        if (!process.env.MQTT_USER || !process.env.MQTT_PASS) {
            console.warn('⚠️ WARNING: MQTT credentials are missing from your environment variables.');
        }
        // 🔥 MODIFIED: Handshake specifications hardened for HiveMQ Cloud TLS
        this.client = mqtt_1.default.connect(brokerUrl, {
            username: username || undefined,
            password: password || undefined,
            clientId: `paygo-backend-${crypto_1.default.randomUUID().substring(0, 8)}`, // Native UUID string prevents collisions
            clean: true,
            connectTimeout: 5000,
            reconnectPeriod: 5000, // Built-in automated reconnect ticker (Removes old setTimeout leak)
            rejectUnauthorized: true, // 🔒 MANDATORY FOR CLOUD: Validates broker's secure SSL certificates
        });
        this.client.on('connect', () => {
            console.log('✅ MQTT successfully connected to secure cloud broker');
            // Subscribe to redemption requests from any device
            this.client?.subscribe('paygo/device/+/redeem', { qos: 1 }, (err) => {
                if (err) {
                    console.error('❌ MQTT Subscription assignment error:', err);
                }
                else {
                    console.log('📡 Subscribed to stream: paygo/device/+/redeem');
                }
            });
        });
        this.client.on('error', (error) => {
            console.error('❌ MQTT execution error:', error.message);
            // NOTE: The library handles reconnecting automatically now via `reconnectPeriod`
        });
        this.client.on('message', async (topic, message) => {
            await this.handleMessage(topic, message);
        });
    }
    async handleMessage(topic, message) {
        try {
            const payload = JSON.parse(message.toString());
            const topicParts = topic.split('/');
            const deviceId = topicParts[2];
            if (!deviceId) {
                console.warn('Invalid topic format parse received:', topic);
                return;
            }
            console.log(`📩 Message intercepted from ${deviceId}:`, payload);
            if (topic.includes('/redeem') && payload.code) {
                await this.handleRedemption(deviceId, payload.code);
            }
        }
        catch (error) {
            console.error('MQTT message payload format parse error:', error);
        }
    }
    async handleRedemption(deviceId, tokenCode) {
        const client = await db_js_1.default.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(`SELECT id, token_hash, kwh_amount 
         FROM paygo_tokens 
         WHERE device_id = $1 AND used = false AND expires_at > NOW()
         ORDER BY created_at DESC 
         FOR UPDATE`, [deviceId]);
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                client.release();
                this.publishResponse(deviceId, 'ERROR', 'No valid tokens found');
                return;
            }
            let matchedTokenRow = null;
            for (const row of result.rows) {
                const isMatch = await bcrypt_1.default.compare(tokenCode, row.token_hash);
                if (isMatch) {
                    matchedTokenRow = row;
                    break;
                }
            }
            if (!matchedTokenRow) {
                await client.query('ROLLBACK');
                client.release();
                this.publishResponse(deviceId, 'ERROR', 'Invalid or expired token');
                return;
            }
            const tokenId = matchedTokenRow.id;
            const kwhAmount = parseFloat(matchedTokenRow.kwh_amount);
            const deviceLock = await client.query(`SELECT current_balance FROM devices WHERE device_id = $1 FOR UPDATE`, [deviceId]);
            if (deviceLock.rows.length === 0) {
                await client.query('ROLLBACK');
                client.release();
                this.publishResponse(deviceId, 'ERROR', 'Device record not found');
                return;
            }
            await client.query(`UPDATE paygo_tokens SET used = true, redeemed_at = NOW() WHERE id = $1`, [tokenId]);
            await client.query(`UPDATE devices SET current_balance = current_balance + $1, last_updated = NOW() WHERE device_id = $2`, [kwhAmount, deviceId]);
            await client.query(`INSERT INTO transactions (device_id, type, amount) VALUES ($1, 'topup', $2)`, [deviceId, kwhAmount]);
            const command = {
                action: 'CREDIT',
                kwh: kwhAmount,
                timestamp: new Date().toISOString(),
            };
            this.client?.publish(`paygo/device/${deviceId}/command`, JSON.stringify(command), { qos: 1 });
            await client.query('COMMIT');
            client.release();
            this.publishResponse(deviceId, 'SUCCESS', `${kwhAmount} kWh added`);
            console.log(`✅ Token redeemed for ${deviceId}: ${kwhAmount} kWh`);
        }
        catch (error) {
            console.error('CRITICAL: Redemption transaction aborted. Rolling back alterations.', error);
            try {
                await client.query('ROLLBACK');
            }
            catch (rollbackErr) {
                console.error('Failed to issue transaction abort command:', rollbackErr);
            }
            client.release();
            this.publishResponse(deviceId, 'ERROR', 'Server processing error');
        }
    }
    publishResponse(deviceId, status, message) {
        const payload = {
            status,
            message,
            timestamp: new Date().toISOString(),
        };
        this.client?.publish(`paygo/device/${deviceId}/response`, JSON.stringify(payload), { qos: 1 });
    }
    disconnect() {
        this.client?.end();
        console.log('MQTT disconnected');
    }
}
const mqttService = new MqttService();
mqttService.connect();
exports.default = mqttService;
//# sourceMappingURL=mqtt-client.js.map