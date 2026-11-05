import mqtt, { MqttClient } from 'mqtt';
import crypto from 'crypto';
import pool from './db.js';
import { MqttCreditCommand, MqttCreditAck } from './types/index.js';
import dotenv from 'dotenv';

dotenv.config();

const PRICE_PER_KWH = parseFloat(process.env.PRICE_PER_KWH || '200');

class MqttService {
  private client: MqttClient | null = null;

  connect(): void {
    const brokerUrl: string = process.env.MQTT_BROKER_URL || 'mqtts://localhost:8883';
    const username: string = process.env.MQTT_USER || '';
    const password: string = process.env.MQTT_PASS || '';

    if (!process.env.MQTT_USER || !process.env.MQTT_PASS) {
      console.warn('⚠️ WARNING: MQTT credentials are missing from your environment variables.');
    }

    let lastMqttErrorMsg = '';

    this.client = mqtt.connect(brokerUrl, {
      username: username || undefined,
      password: password || undefined,
      clientId: `paygo-backend-${crypto.randomUUID().substring(0, 8)}`,
      clean: true,
      connectTimeout: 10000,
      reconnectPeriod: 10000,
      keepalive: 60,
      rejectUnauthorized: true,
    });

    this.client.on('connect', () => {
      console.log('✅ MQTT successfully connected to secure cloud broker');
      lastMqttErrorMsg = '';
      
      this.client?.subscribe(
        ['paygo/device/+/energy', 'paygo/device/+/ack', 'paygo/device/+/status'],
        { qos: 1 },
        (err) => {
          if (err) {
            console.error('❌ MQTT Subscription error:', err);
          } else {
            console.log('📡 Subscribed to streams: energy, ack, status');
          }
        }
      );
    });

    this.client.on('error', (error: Error) => {
      if (error.message !== lastMqttErrorMsg) {
        console.error('❌ MQTT execution error:', error.message);
        lastMqttErrorMsg = error.message;
      }
    });

    this.client.on('message', async (topic: string, message: Buffer) => {
      await this.handleMessage(topic, message);
    });
  }

  private async handleMessage(topic: string, message: Buffer): Promise<void> {
    try {
      const payload = JSON.parse(message.toString());
      const topicParts = topic.split('/');
      const deviceId = topicParts[2];

      if (!deviceId) {
        console.warn('Invalid topic format parse received:', topic);
        return;
      }

      // Mark device as ONLINE and update last_seen_at
      await this.updateDeviceOnlineStatus(deviceId);

      console.log(`📩 Message intercepted from ${deviceId} on ${topic}:`, payload);

      if (topic.includes('/ack') && (payload.action === 'CREDIT_ACK' || payload.status === 'ACCEPTED' || payload.status === 'REJECTED')) {
        await this.handleCreditAck(deviceId, payload as MqttCreditAck);
      } else if (topic.includes('/energy') && typeof payload.wh_consumed === 'number') {
        await this.handleEnergyReport(deviceId, payload.wh_consumed);
      }

      // Check and retry any pending hardware credits if device is online
      await this.retryPendingTransactionsForDevice(deviceId);
    } catch (error) {
      console.error('MQTT message payload format parse error:', error);
    }
  }

  private async updateDeviceOnlineStatus(deviceId: string): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO devices (device_id, current_balance, status, last_seen_at, last_updated)
         VALUES ($1, 0, 'ONLINE', NOW(), NOW())
         ON CONFLICT (device_id)
         DO UPDATE SET status = 'ONLINE', last_seen_at = NOW(), last_updated = NOW()`,
        [deviceId]
      );
    } catch (err) {
      console.error(`Failed to update device status for ${deviceId}:`, err);
    }
  }

  public async publishCreditCommand(deviceId: string, kwhAmount: number, transactionId: string): Promise<boolean> {
    if (!this.client || !this.client.connected) {
      console.warn(`⚠️ MQTT not connected. Credit command for ${deviceId} (${transactionId}) will be queued.`);
      return false;
    }

    const command: MqttCreditCommand = {
      action: 'CREDIT',
      transactionId,
      deviceId,
      kwh: kwhAmount,
      timestamp: new Date().toISOString(),
    };

    this.client.publish(
      `paygo/device/${deviceId}/command`,
      JSON.stringify(command),
      { qos: 1 },
      async (err) => {
        if (err) {
          console.error(`❌ Failed to publish MQTT credit command for ${deviceId}:`, err);
        } else {
          console.log(`📡 Dispatched MQTT CREDIT command for ${deviceId} (txId: ${transactionId}, kwh: ${kwhAmount})`);
          try {
            await pool.query(
              `UPDATE transactions SET last_attempt_at = NOW(), retry_count = retry_count + 1 WHERE transaction_id = $1`,
              [transactionId]
            );
          } catch (dbErr) {
            console.error('Error updating transaction last_attempt_at:', dbErr);
          }
        }
      }
    );

    return true;
  }

  private async handleCreditAck(deviceId: string, payload: MqttCreditAck): Promise<void> {
    const { transactionId, status, reason } = payload;
    if (!transactionId) return;

    if (status === 'ACCEPTED') {
      await pool.query(
        `UPDATE transactions SET hardware_status = 'CONFIRMED' WHERE transaction_id = $1`,
        [transactionId]
      );
      console.log(`✅ Hardware ACK RECEIVED: ${deviceId} confirmed credit for transaction ${transactionId}`);
    } else if (status === 'REJECTED') {
      await pool.query(
        `UPDATE transactions SET hardware_status = 'FAILED' WHERE transaction_id = $1`,
        [transactionId]
      );
      console.warn(`❌ Hardware ACK REJECTED for ${deviceId} (txId: ${transactionId}): ${reason || 'Unknown reason'}`);
    }
  }

  public async retryPendingTransactionsForDevice(deviceId: string): Promise<void> {
    try {
      const res = await pool.query(
        `SELECT transaction_id, kwh_amount, retry_count, last_attempt_at 
         FROM transactions 
         WHERE device_id = $1 AND type = 'topup' AND hardware_status = 'PENDING'
           AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '15 seconds')
         ORDER BY timestamp ASC`,
        [deviceId]
      );

      for (const row of res.rows) {
        console.log(`🔄 Retrying pending hardware credit for ${deviceId} (txId: ${row.transaction_id})`);
        await this.publishCreditCommand(deviceId, parseFloat(row.kwh_amount), row.transaction_id);
      }
    } catch (err) {
      console.error(`Error checking pending retries for ${deviceId}:`, err);
    }
  }

  private async handleEnergyReport(deviceId: string, whConsumed: number): Promise<void> {
    if (whConsumed <= 0) return;
    const kwhConsumed = whConsumed / 1000;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const deviceRes = await client.query(
        `SELECT current_balance FROM devices WHERE device_id = $1 FOR UPDATE`,
        [deviceId]
      );

      if (deviceRes.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return;
      }

      const currentBalance = parseFloat(deviceRes.rows[0].current_balance);
      const newBalance = Math.max(0, currentBalance - kwhConsumed);

      await client.query(
        `UPDATE devices SET current_balance = $1, last_updated = NOW() WHERE device_id = $2`,
        [newBalance, deviceId]
      );

      await client.query(
        `INSERT INTO transactions (device_id, type, amount, kwh_amount) VALUES ($1, 'consumption', $2, $3)`,
        [deviceId, -(kwhConsumed * PRICE_PER_KWH), kwhConsumed]
      );

      await client.query('COMMIT');
      client.release();

      console.log(`⚡ Energy report for ${deviceId}: deducted ${kwhConsumed} kWh, new balance: ${newBalance} kWh`);

      if (newBalance <= 0) {
        const closeCommand = {
          action: 'CLOSE',
          reason: 'BALANCE_EXHAUSTED',
          timestamp: new Date().toISOString(),
        };
        this.client?.publish(
          `paygo/device/${deviceId}/command`,
          JSON.stringify(closeCommand),
          { qos: 1 }
        );
        console.log(`🔒 Zero balance reached for ${deviceId}. Issued CLOSE relay command.`);
      }
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {}
      client.release();
      console.error(`Error processing energy report for ${deviceId}:`, error);
    }
  }

  public disconnect(): void {
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
    console.log('MQTT disconnected');
  }
}

const mqttService = new MqttService();
mqttService.connect();

export default mqttService;
