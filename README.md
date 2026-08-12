# ⚡ PAYGO Backend - Solar Energy Metering & Billing System

A robust, enterprise-grade backend service built with **Node.js**, **Express.js**, **TypeScript**, **PostgreSQL**, and **MQTT**. This server powers the PAYGO (Pay-As-You-Go) solar energy trading and metering platform, featuring **Automatic Remote Recharge**, Paystack payment webhooks, cryptographic token generation, hardware ACK status tracking (`PENDING` | `CONFIRMED` | `FAILED`), device online/offline monitoring, and real-time hardware meter balance crediting over secure MQTT (HiveMQ Cloud TLS).

---

## 📋 Table of Contents

- [Features](#-features)
- [System Architecture & Remote Recharge Flow](#-system-architecture--remote-recharge-flow)
- [Tech Stack](#-tech-stack)
- [Project Directory Structure](#-project-directory-structure)
- [Database Schema](#-database-schema)
- [Environment Variables](#-environment-variables)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Database Setup](#database-setup)
  - [Installation](#installation)
  - [Running & Testing](#running--testing)
- [API Reference](#-api-reference)
  - [Health Check](#health-check)
  - [Payment Initiation](#payment-initiation)
  - [Paystack Webhook](#paystack-webhook)
  - [Device Profile & Status](#device-profile--status)
  - [Transaction Verification](#transaction-verification)
- [MQTT Communication Protocol](#-mqtt-communication-protocol)
  - [Topic Taxonomy](#topic-taxonomy)
  - [Remote Credit Command](#remote-credit-command)
  - [Hardware ACK Response](#hardware-ack-response)
  - [Device Status & Heartbeat](#device-status--heartbeat)
  - [Fallback Token Redemption](#fallback-token-redemption)
- [Security & Reliability Features](#-security--reliability-features)

---

## ✨ Features

- **Automatic Remote Recharge**: Paystack payments automatically credit the database balance (`devices.current_balance`) and dispatch an instant MQTT `CREDIT` command directly to the physical ESP32 meter.
- **Post-Commit Execution Safety**: Database transaction (`BEGIN` ➔ balance update ➔ transaction log ➔ token creation ➔ `COMMIT`) completes **first** before publishing MQTT messages.
- **Hardware Credit Status Tracking**: `transactions.hardware_status` explicitly tracks physical execution state (`PENDING` | `CONFIRMED` | `FAILED`), updating to `CONFIRMED` only when the ESP32 returns a `CREDIT_ACK` message.
- **Internal Transaction ID Idempotency**: Each top-up assigns a unique internal `transactionId` (`TXN_XXXXXXXX`). The ESP32 tracks processed transaction IDs persistently to prevent duplicate crediting.
- **Paystack Webhook Idempotency**: DB-level `reference VARCHAR(255) UNIQUE` constraint prevents duplicate processing of retried Paystack webhooks.
- **Money vs. Energy Separation**: Explicitly stores both `amount` (financial value paid in Naira) and `kwh_amount` (energy units purchased in kWh).
- **Fallback Recovery Token Engine**: Generates 16-digit fallback tokens marked `auto_credited = true`. Manual token entry checks financial status first, skipping DB balance re-addition while re-dispatching hardware commands.
- **Throttled Retry & Reconnect Engine**: Retries pending hardware credit commands when an ESP32 reconnects or sends heartbeats, respecting backoff delays (`last_attempt_at > 15s`).
- **Device Online/Offline Monitoring**: Automatically updates device connectivity state (`status: ONLINE/OFFLINE`, `last_seen_at`) upon receiving hardware messages.
- **HMAC-SHA512 Webhook Security**: Raw request body interception and HMAC-SHA512 signature validation to prevent unauthorized webhook spoofing.
- **SMS Token Dispatch**: Dispatches fallback token codes to customer mobile numbers via Termii SMS API.

---

## 🏗 System Architecture & Remote Recharge Flow

```mermaid
sequenceDiagram
    autonumber
    actor Buyer as Buyer / User
    participant App as Mobile/Web Frontend
    participant PS as Paystack Gateway
    participant API as Express Backend
    participant DB as PostgreSQL DB
    participant SMS as Termii SMS API
    participant Broker as HiveMQ MQTT Cloud
    participant ESP as ESP32 Hardware Meter

    Buyer->>App: Enter Payment (Amount, Email, Device ID)
    App->>API: POST /api/payment/initiate
    API->>PS: Initialize Transaction
    PS-->>API: Return Auth URL & Reference
    API-->>App: Return Payment URL & Reference
    Buyer->>PS: Complete Payment
    PS->>API: Webhook (charge.success) [HMAC-SHA512 Signed]
    API->>API: Verify Signature & Generate Internal transactionId (TXN_XXX)
    
    note over API,DB: STEP 1: COMMIT DB FINANCIAL CREDIT FIRST
    API->>DB: BEGIN TX: Add kWh to devices.balance, Insert Tx (hardware_status=PENDING), Insert Fallback Token
    API->>DB: COMMIT TX
    API->>SMS: Send Fallback Token via SMS

    note over API,ESP: STEP 2: POST-COMMIT MQTT DISPATCH & ACK
    API->>Broker: Publish paygo/device/{id}/command {action: CREDIT, transactionId, kwh}
    Broker->>ESP: Relay CREDIT Command
    
    alt ESP32 Online
        ESP->>ESP: Deduplicate transactionId & Energize Relay
        ESP->>Broker: Publish paygo/device/{id}/ack {status: ACCEPTED, transactionId}
        Broker->>API: Deliver CREDIT_ACK
        API->>DB: UPDATE transactions SET hardware_status = 'CONFIRMED'
    else ESP32 Offline
        Note over API,ESP: hardware_status remains PENDING. Auto-retry on device reconnect or fallback token entry.
    end
```

---

## 🛠 Tech Stack

- **Runtime**: Node.js (v18+)
- **Framework**: Express.js (v5)
- **Language**: TypeScript (v5+) with strict typing
- **Database**: PostgreSQL (v14+) via `pg` (node-postgres) connection pool
- **MQTT Engine**: `mqtt` (v5) over TLS (WSS / MQTTS)
- **Payment Processing**: Paystack API
- **SMS Communications**: Termii REST API via `axios`
- **Security & Hashing**: `bcrypt`, `crypto` (HMAC SHA512, randomInt, UUID)
- **Testing Suite**: Node.js Native Test Runner (`tsx --test`)

---

## 📁 Project Directory Structure

```text
backend/
├── .env                  # Environment configurations (Git ignored)
├── package.json          # Project dependencies & scripts
├── tsconfig.json         # TypeScript compiler configurations
├── README.md             # Project documentation
└── src/
    ├── app.ts            # Express application setup & middleware/routes mounting
    ├── index.ts          # Main HTTP server entrypoint & MQTT client bootstrapper
    ├── db.ts             # PostgreSQL pool connection configuration
    ├── mqtt-client.ts    # MQTT service: client, topic handlers, ACK listener, retry engine
    ├── init-db.sql       # Database table schemas, constraints & indexes
    ├── __tests__/
    │   └── endpoints.test.ts # Endpoint & MQTT hardware lifecycle integration test suite
    ├── middlewares/
    │   ├── middleware.ts # Request logger, 404 handler, global error handler
    │   └── authMiddleware.ts # JWT authentication & role guard middleware
    ├── routes/
    │   ├── auth.ts       # /api/auth/register, /login, /me, /logout endpoints
    │   ├── payment.ts    # /api/payment/initiate endpoint
    │   ├── webhook.ts    # /api/webhook/paystack HMAC-verified remote recharge handler
    │   ├── devices.ts    # /api/devices/:deviceId profile, status & transactions endpoint
    │   └── transactions.ts # /api/transactions/verify/:reference lookup endpoint
    ├── services/
    │   └── sms.ts        # Termii SMS delivery service with fallback logger
    └── types/
        └── index.ts      # TypeScript interfaces and payload type definitions
```

---

## 🗄 Database Schema

The database schema is defined in [`src/init-db.sql`](file:///c:/Users/Telzeez/Desktop/SolarPayMe(SPM)/backend/src/init-db.sql):

### 1. `devices`
Tracks physical meters, energy balances, and connectivity state.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `SERIAL` | `PRIMARY KEY` | Database row identifier |
| `device_id` | `VARCHAR(50)` | `UNIQUE, NOT NULL` | Physical meter hardware serial ID |
| `current_balance` | `DECIMAL(10,2)`| `DEFAULT 0` | Current available energy credit (kWh) |
| `status` | `VARCHAR(20)` | `DEFAULT 'OFFLINE'`| Connectivity status (`ONLINE` / `OFFLINE`) |
| `last_seen_at` | `TIMESTAMP` | `NULL` | Timestamp of last received hardware packet |
| `last_updated` | `TIMESTAMP` | `DEFAULT NOW()` | Timestamp of last balance modification |

### 2. `transactions`
Authoritative ledger for financial payments, energy consumption, and hardware execution status.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `SERIAL` | `PRIMARY KEY` | Ledger record ID |
| `device_id` | `VARCHAR(50)` | `NOT NULL` | Target meter identifier |
| `type` | `VARCHAR(20)` | `CHECK ('topup','consumption')` | Transaction classification |
| `amount` | `DECIMAL(10,2)`| `NOT NULL` | Monetary value paid (Naira) |
| `kwh_amount` | `DECIMAL(10,2)`| `DEFAULT 0` | Energy amount (kWh) |
| `transaction_id` | `VARCHAR(100)`| `UNIQUE` | Internal transaction ID (`TXN_XXXXXXXX`) |
| `reference` | `VARCHAR(255)`| `UNIQUE` | Paystack payment reference |
| `hardware_status` | `VARCHAR(20)`| `DEFAULT 'PENDING'` | Hardware credit status (`PENDING` \| `CONFIRMED` \| `FAILED`) |
| `retry_count` | `INT` | `DEFAULT 0` | Number of MQTT credit command retry attempts |
| `last_attempt_at` | `TIMESTAMP` | `NULL` | Timestamp of last credit command attempt |
| `timestamp` | `TIMESTAMP` | `DEFAULT NOW()` | Record creation timestamp |

**Indexes**: `idx_transactions_device_id`, `idx_transactions_tx_id`, `idx_transactions_ref`

### 3. `paygo_tokens`
Stores generated fallback recovery tokens.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `SERIAL` | `PRIMARY KEY` | Identifier |
| `buyer_email` | `VARCHAR(255)` | `NOT NULL` | Purchaser email address |
| `device_id` | `VARCHAR(50)` | `NOT NULL` | Associated meter ID |
| `kwh_amount` | `DECIMAL(10,2)`| `NOT NULL` | Energy units in kWh |
| `token_hash` | `VARCHAR(255)` | `NOT NULL` | Bcrypt hash of 16-digit token code |
| `transaction_id` | `VARCHAR(100)`| `NULL` | Associated internal transaction ID |
| `paystack_reference`| `VARCHAR(255)`| `UNIQUE` | Paystack reference |
| `auto_credited` | `BOOLEAN` | `DEFAULT FALSE` | Flag indicating if DB was credited during payment |
| `used` | `BOOLEAN` | `DEFAULT FALSE` | Flag indicating if fallback token was redeemed |
| `expires_at` | `TIMESTAMP` | `NOT NULL` | Token expiration date (72h) |
| `redeemed_at` | `TIMESTAMP` | `NULL` | Redemption timestamp |

**Indexes**: `idx_tokens_device_id`, `idx_tokens_used`, `idx_tokens_expires_at`

---

## ⚙️ Environment Variables

Create a `.env` file in the `backend/` directory:

```env
# Server Configuration
PORT=3000
BASE_URL=http://localhost:3000

# Database Configuration
DATABASE_URL=postgresql://username:password@localhost:5432/paygo_db

# Security & Business Constants
PRICE_PER_KWH=200
BCRYPT_SALT_ROUNDS=10
TOKEN_EXPIRY_HOURS=72

# Paystack API Keys
PAYSTACK_SECRET_KEY=sk_test_xxx...

# Termii SMS Gateway
SMS_API_KEY=tlv_xxx...
SMS_ENDPOINT_URL=https://v4.api.termii.com/api/sms/send

# HiveMQ / MQTT Broker Connection
MQTT_BROKER_URL=mqtts://your-broker.hivemq.cloud:8883
MQTT_USER=paygo_server
MQTT_PASS=YourMqttPassword
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** (v18.x or higher)
- **npm** (v9.x or higher)
- **PostgreSQL** (v14.x or higher)

### Database Setup

```bash
psql -U postgres -d paygo_db -f src/init-db.sql
```

### Installation

```bash
cd backend
npm install
```

### Running & Testing

- **Development Server** (with watcher):
  ```bash
  npm run dev
  ```
- **Type Checking**:
  ```bash
  npm run type-check
  ```
- **Run Full Integration Test Suite**:
  ```bash
  npm test
  ```

---

## 📡 API Reference

### `POST /api/webhook/paystack`
Handles incoming Paystack payment webhooks with automatic remote credit.

- **Headers**: `x-paystack-signature` (HMAC-SHA512)
- **Flow**:
  1. Validates signature against raw request body.
  2. Verifies idempotency against `transactions.reference`.
  3. Generates internal `transaction_id` (`TXN_XXXXXXXX`).
  4. Commits DB balance addition (`devices.current_balance += kwhAmount`), creates transaction (`hardware_status = 'PENDING'`), and creates fallback token (`auto_credited = true`).
  5. Post-commit: publishes `CREDIT` command over MQTT.
  6. Sends SMS with fallback token code.

---

### `GET /api/devices/:deviceId`
Retrieves meter status, balance, connectivity state, and transaction ledger.

**Response (200 OK):**
```json
{
  "success": true,
  "deviceId": "device_001",
  "balance": 25.5,
  "status": "ONLINE",
  "lastSeenAt": "2026-08-12T02:30:00.000Z",
  "lastUpdated": "2026-08-12T02:30:00.000Z",
  "transactions": [
    {
      "id": 1,
      "type": "topup",
      "amount": 5000,
      "kwhAmount": 25.5,
      "transactionId": "TXN_8F72A91",
      "reference": "ref_101",
      "hardwareStatus": "CONFIRMED",
      "timestamp": "2026-08-12T02:30:00.000Z"
    }
  ]
}
```

---

## 🔌 MQTT Communication Protocol

### Topic Taxonomy

| Direction | MQTT Topic | Description |
| :--- | :--- | :--- |
| **Backend ➔ Hardware** | `paygo/device/{deviceId}/command` | Credit commands & Relay control |
| **Hardware ➔ Backend** | `paygo/device/{deviceId}/ack` | Execution ACK confirmations |
| **Hardware ➔ Backend** | `paygo/device/{deviceId}/status` | Device heartbeats & online status |
| **Hardware ➔ Backend** | `paygo/device/{deviceId}/energy` | Energy consumption reports |
| **Hardware ➔ Backend** | `paygo/device/{deviceId}/redeem` | Keypad fallback token redemption |

---

### Remote Credit Command
Published by backend to `paygo/device/{deviceId}/command`:
```json
{
  "action": "CREDIT",
  "transactionId": "TXN_8F72A91",
  "deviceId": "device_001",
  "kwh": 25.5,
  "timestamp": "2026-08-12T02:30:00Z"
}
```

### Hardware ACK Response
Published by ESP32 to `paygo/device/{deviceId}/ack`:
```json
{
  "action": "CREDIT_ACK",
  "transactionId": "TXN_8F72A91",
  "deviceId": "device_001",
  "status": "ACCEPTED",
  "balance": 25.5,
  "timestamp": "2026-08-12T02:30:05Z"
}
```

---

## 📄 License

Part of the PAYGO Solar Energy Trading Platform project. Developed by Abdlazeez Olasunkanmi, 2026.
