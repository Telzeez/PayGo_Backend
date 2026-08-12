import mqtt, { MqttClient } from 'mqtt';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import pool from './db.js';
import { MqttRedeemPayload, MqttCreditCommand, MqttCreditAck, MqttResponsePayload } from './types/index.js';
import dotenv from 'dotenv';

dotenv.config();

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
        ['paygo/device/+/redeem', 'paygo/device/+/energy', 'paygo/device/+/ack', 'paygo/device/+/status'],
        { qos: 1 },
        (err) => {
          if (err) {
            console.error('❌ MQTT Subscription error:', err);
          } else {
            console.log('📡 Subscribed to streams: redeem, energy, ack, status');
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

      if (topic.includes('/ack') && payload.action === 'CREDIT_ACK') {
        await this.handleCreditAck(deviceId, payload as MqttCreditAck);
      } else if (topic.includes('/redeem') && payload.code) {
        await this.handleRedemption(deviceId, payload.code);
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
        `INSERT INTO transactions (device_id, type, amount, kwh_amount) VALUES ($1, 'consumption', 0, $2)`,
        [deviceId, kwhConsumed]
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

  private async handleRedemption(deviceId: string, tokenCode: string): Promise<void> {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT id, token_hash, kwh_amount, auto_credited, transaction_id 
         FROM paygo_tokens 
         WHERE device_id = $1 AND used = false AND expires_at > NOW()
         ORDER BY created_at DESC 
         FOR UPDATE`, 
        [deviceId]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        this.publishResponse(deviceId, 'ERROR', 'No valid tokens found');
        return;
      }

      let matchedTokenRow = null;

      for (const row of result.rows) {
        const isMatch: boolean = await bcrypt.compare(tokenCode, row.token_hash);
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
      const autoCredited = matchedTokenRow.auto_credited === true;
      const txId = matchedTokenRow.transaction_id || `TXN_${crypto.randomUUID().substring(0, 8).toUpperCase()}`;

      const deviceLock = await client.query(
        `SELECT current_balance FROM devices WHERE device_id = $1 FOR UPDATE`,
        [deviceId]
      );

      if (deviceLock.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        this.publishResponse(deviceId, 'ERROR', 'Device record not found');
        return;
      }

      await client.query(
        `UPDATE paygo_tokens SET used = true, redeemed_at = NOW() WHERE id = $1`,
        [tokenId]
      );

      if (autoCredited) {
        // DB balance was ALREADY updated when webhook ran. Do NOT add balance again!
        await client.query('COMMIT');
        client.release();

        await this.publishCreditCommand(deviceId, kwhAmount, txId);

        this.publishResponse(deviceId, 'SUCCESS', `${kwhAmount} kWh credited (Recovery mode)`);
        console.log(`✅ Fallback token redeemed for ${deviceId}: ${kwhAmount} kWh (DB balance already credited)`);
        return;
      }

      // Legacy or manual token insertion without prior auto credit
      await client.query(
        `UPDATE devices SET current_balance = current_balance + $1, last_updated = NOW() WHERE device_id = $2`,
        [kwhAmount, deviceId]
      );

      await client.query(
        `INSERT INTO transactions (device_id, type, amount, kwh_amount, transaction_id, hardware_status, last_attempt_at) 
         VALUES ($1, 'topup', 0, $2, $3, 'PENDING', NOW())`,
        [deviceId, kwhAmount, txId]
      );

      await client.query('COMMIT');
      client.release();

      await this.publishCreditCommand(deviceId, kwhAmount, txId);

      this.publishResponse(deviceId, 'SUCCESS', `${kwhAmount} kWh added`);
      console.log(`✅ Manual Token redeemed for ${deviceId}: ${kwhAmount} kWh`);

    } catch (error) {
      console.error('CRITICAL: Redemption transaction aborted. Rolling back alterations.', error);
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Failed to issue transaction abort command:', rollbackErr);
      }
      client.release();
      this.publishResponse(deviceId, 'ERROR', 'Server processing error');
    }
  }

  private publishResponse(deviceId: string, status: 'SUCCESS' | 'ERROR', message: string): void {
    const payload: MqttResponsePayload = {
      status,
      message,
      timestamp: new Date().toISOString(),
    };

    this.client?.publish(
      `paygo/device/${deviceId}/response`,
      JSON.stringify(payload),
      { qos: 1 }
    );
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
