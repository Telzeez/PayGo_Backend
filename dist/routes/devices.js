"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_js_1 = __importDefault(require("../db.js"));
const router = express_1.default.Router();
router.get('/:deviceId', async (req, res) => {
    // Acquire a dedicated connection thread to maintain atomicity across our dual queries
    const client = await db_js_1.default.connect();
    try {
        const deviceId = req.params.deviceId;
        if (!deviceId || typeof deviceId !== 'string' || deviceId.trim().length < 3) {
            client.release();
            return res.status(400).json({
                success: false,
                error: 'Invalid device ID specification',
            });
        }
        // STEP 1: Initialize transaction boundary
        await client.query('BEGIN');
        // STEP 2: Atomic Upsert Pattern. Ensures device creation or retrieval in 1 statement.
        // If it exists, it minimally touches the row to return the correct, current data.
        const balanceResult = await client.query(`INSERT INTO devices (device_id, current_balance) 
       VALUES ($1, 0)
       ON CONFLICT (device_id) 
       DO UPDATE SET last_updated = NOW() -- Soft modification to trigger output mapping
       RETURNING current_balance, last_updated`, [deviceId]);
        const balance = parseFloat(balanceResult.rows[0].current_balance.toString());
        const lastUpdated = balanceResult.rows[0].last_updated;
        // STEP 3: Execute ledger history slice extraction inside the locked transaction timeline
        const txResult = await client.query(`SELECT id, type, amount, timestamp 
       FROM transactions 
       WHERE device_id = $1 
       ORDER BY timestamp DESC 
       LIMIT 20`, [deviceId]);
        // STEP 4: Commit changes to close database connection locks
        await client.query('COMMIT');
        client.release();
        return res.json({
            success: true,
            deviceId,
            balance,
            lastUpdated,
            transactions: txResult.rows,
        });
    }
    catch (error) {
        // Gracefully clean database stack traces on execution exceptions
        try {
            await client.query('ROLLBACK');
        }
        catch (rollbackErr) {
            console.error('Failed to issue transaction rollback:', rollbackErr);
        }
        client.release();
        console.error('CRITICAL: Device profile synchronization failure:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal service synchronization failure',
        });
    }
});
exports.default = router;
//# sourceMappingURL=devices.js.map