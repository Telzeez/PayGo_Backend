# ⚡ PAYGO Backend - Solar Energy Metering & Billing System

A robust backend service built with **Node.js**, **Express.js**, **TypeScript**, **PostgreSQL**, and **MQTT**. This server powers the PAYGO solar energy platform, featuring **Automatic Remote Recharge**, Paystack payment webhooks, hardware ACK status tracking (`PENDING` | `CONFIRMED` | `FAILED`), device online/offline monitoring, and real-time meter crediting over secure MQTT.

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
  - [Marketplace Seller Payouts](#marketplace-seller-payouts)
  - [Paystack Webhook](#paystack-webhook)
  - [Device Profile & Status](#device-profile--status)
  - [Transaction Verification](#transaction-verification)
- [MQTT Communication Protocol](#-mqtt-communication-protocol)
  - [Topic Taxonomy](#topic-taxonomy)
  - [Remote Credit Command](#remote-credit-command)
  - [Hardware ACK Response](#hardware-ack-response)
  - [Device Status & Heartbeat](#device-status--heartbeat)
- [Security & Reliability Features](#-security--reliability-features)

---

## ✨ Features

- **Automatic Remote Recharge**: Paystack payments automatically credit the database balance (`devices.current_balance`) and dispatch an instant MQTT `CREDIT` command directly to the physical ESP32 meter.
- **Post-Commit Execution Safety**: Database transaction (`BEGIN` ➔ balance update ➔ transaction log ➔ `COMMIT`) completes **first** before publishing MQTT messages.
- **Hardware Credit Status Tracking**: `transactions.hardware_status` explicitly tracks physical execution state (`PENDING` | `CONFIRMED` | `FAILED`), updating to `CONFIRMED` on an ESP32 `CREDIT_ACK` or a matching hardware balance sync.
- **Internal Transaction ID Idempotency**: Each top-up assigns a unique internal `transactionId` (`TXN_XXXXXXXX`). The ESP32 tracks processed transaction IDs persistently to prevent duplicate crediting.
- **Paystack Webhook Idempotency**: DB-level `reference VARCHAR(255) UNIQUE` constraint prevents duplicate processing of retried Paystack webhooks.
- **Money vs. Energy Separation**: Explicitly stores both `amount` (financial value paid in Naira) and `kwh_amount` (energy units purchased in kWh).
- **Local Energy Marketplace Engine**: Powers peer-to-peer energy trading with a Haversine geographical distance matching engine. Buyers can discover sellers within a specific service radius, while the backend enforces strict idempotency and `reserved_kwh` locks to prevent race conditions during purchase.
- **Marketplace Seller Settlements**: Sellers can connect a Paystack-verified Nigerian bank account. Marketplace payments split 90% to the seller subaccount and 10% to the platform; buyer meter top-ups are not split.
- **Energy Consumption Ledger**: Records reported consumption as a Naira debit and kWh usage, rather than a zero-value credit.
- **Throttled Retry & Reconnect Engine**: Retries pending hardware credit commands when an ESP32 reconnects or sends heartbeats, respecting backoff delays (`last_attempt_at > 15s`).
- **Device Online/Offline Monitoring**: Automatically updates device connectivity state (`status: ONLINE/OFFLINE`, `last_seen_at`) upon receiving hardware messages.
- **HMAC-SHA512 Webhook Security**: Raw request body interception and HMAC-SHA512 signature validation to prevent unauthorized webhook spoofing.

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
    API->>DB: BEGIN TX: Add kWh to devices.balance, Insert Tx (hardware_status=PENDING)
    API->>DB: COMMIT TX

    note over API,ESP: STEP 2: POST-COMMIT MQTT DISPATCH & ACK
    API->>Broker: Publish paygo/device/{id}/command {action: CREDIT, transactionId, kwh}
    Broker->>ESP: Relay CREDIT Command

    alt ESP32 Online
        ESP->>ESP: Deduplicate transactionId & Energize Relay
        ESP->>Broker: Publish paygo/device/{id}/ack {status: ACCEPTED, transactionId}
        Broker->>API: Deliver CREDIT_ACK
        API->>DB: UPDATE transactions SET hardware_status = 'CONFIRMED'
    else ESP32 Offline
        Note over API,ESP: hardware_status remains PENDING. Auto-retry when the device reconnects.
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
    │   ├── marketplace.ts # /api/marketplace endpoints for haversine matching & energy purchases
    │   └── transactions.ts # /api/transactions/verify/:reference lookup endpoint
    ├── services/
    └── types/
        └── index.ts      # TypeScript interfaces and payload type definitions
```

---

## 🗄 Database Schema

The database schema is defined in [`src/init-db.sql`](<file:///c:/Users/Telzeez/Desktop/PayGo(SPM)/backend/src/init-db.sql>):

### 1. `devices`

Tracks physical meters, energy balances, and connectivity state.

| Column            | Type            | Constraints         | Description                                |
| :---------------- | :-------------- | :------------------ | :----------------------------------------- |
| `id`              | `SERIAL`        | `PRIMARY KEY`       | Database row identifier                    |
| `device_id`       | `VARCHAR(50)`   | `UNIQUE, NOT NULL`  | Physical meter hardware serial ID          |
| `current_balance` | `DECIMAL(10,2)` | `DEFAULT 0`         | Current available energy credit (kWh)      |
| `status`          | `VARCHAR(20)`   | `DEFAULT 'OFFLINE'` | Connectivity status (`ONLINE` / `OFFLINE`) |
| `last_seen_at`    | `TIMESTAMP`     | `NULL`              | Timestamp of last received hardware packet |
| `last_updated`    | `TIMESTAMP`     | `DEFAULT NOW()`     | Timestamp of last balance modification     |

### 2. `transactions`

Authoritative ledger for financial payments, energy consumption, and hardware execution status.

| Column            | Type            | Constraints                     | Description                                                   |
| :---------------- | :-------------- | :------------------------------ | :------------------------------------------------------------ |
| `id`              | `SERIAL`        | `PRIMARY KEY`                   | Ledger record ID                                              |
| `device_id`       | `VARCHAR(50)`   | `NOT NULL`                      | Target meter identifier                                       |
| `type`            | `VARCHAR(20)`   | `CHECK ('topup','consumption')` | Transaction classification                                    |
| `amount`          | `DECIMAL(10,2)` | `NOT NULL`                      | Monetary value paid (Naira)                                   |
| `kwh_amount`      | `DECIMAL(10,2)` | `DEFAULT 0`                     | Energy amount (kWh)                                           |
| `transaction_id`  | `VARCHAR(100)`  | `UNIQUE`                        | Internal transaction ID (`TXN_XXXXXXXX`)                      |
| `reference`       | `VARCHAR(255)`  | `UNIQUE`                        | Paystack payment reference                                    |
| `hardware_status` | `VARCHAR(20)`   | `DEFAULT 'PENDING'`             | Hardware credit status (`PENDING` \| `CONFIRMED` \| `FAILED`) |
| `retry_count`     | `INT`           | `DEFAULT 0`                     | Number of MQTT credit command retry attempts                  |
| `last_attempt_at` | `TIMESTAMP`     | `NULL`                          | Timestamp of last credit command attempt                      |
| `timestamp`       | `TIMESTAMP`     | `DEFAULT NOW()`                 | Record creation timestamp                                     |

**Indexes**: `idx_transactions_device_id`, `idx_transactions_tx_id`, `idx_transactions_ref`

### 3. `marketplace_sources` & `marketplace_listings`
Manages local energy sellers and available energy inventory.

| Table | Description |
| :--- | :--- |
| `marketplace_sources` | Stores seller configurations, `device_id`, exact `latitude`/`longitude` and `service_radius_meters`. |
| `marketplace_listings` | Stores active listings, `kwh_available`, `price_per_kwh_kobo`, and status (`ACTIVE`, `PAUSED`). |
| `marketplace_purchases` | Tracks peer-to-peer energy purchases including `buyer_device_id`, `amount`, and `status`. |

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
  4. Commits DB balance addition (`devices.current_balance += kwhAmount`) and creates a transaction (`hardware_status = 'PENDING'`).
  5. Post-commit: publishes `CREDIT` command over MQTT.

Payment verification returns the transaction's current `hardwareStatus`; it does not generate or return a manual fallback token.

---

### Marketplace Seller Payouts

Authenticated seller and owner accounts can configure a Paystack subaccount for marketplace settlements:

- `GET /api/marketplace/payout-account/banks` — list active Nigerian payout banks.
- `GET /api/marketplace/payout-account` — return the saved, masked payout-account details.
- `PUT /api/marketplace/payout-account` — verify a 10-digit bank account with Paystack and create or update the seller subaccount. The request body contains `businessName`, `bankCode`, and `accountNumber`.

The backend stores the Paystack subaccount code, bank name, verified account name, and last four account-number digits; the full account number is sent to Paystack for verification and subaccount setup, not stored by PayGo. Marketplace payment initialization attaches the seller's subaccount, which routes 90% to the seller and 10% to the platform. A seller without a configured subaccount cannot initiate a marketplace payment. Regular meter top-ups continue to use the existing payment flow without a seller split.

These endpoints require `PAYSTACK_SECRET_KEY` and a Paystack account enabled for Nigerian subaccounts. The database columns are added by the existing startup schema initialization from `src/init-db.sql`.

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

### `GET /api/marketplace/nearby`

Discovers active energy listings within a geographical radius using the Haversine formula.

- **Query Params**: `lat`, `lng`, `radiusMeters` (default 5000)
- **Response**: Array of eligible seller listings containing approximate distance in meters and tariff rates.

## 🔌 MQTT Communication Protocol

### Topic Taxonomy

| Direction              | MQTT Topic                        | Description                       |
| :--------------------- | :-------------------------------- | :-------------------------------- |
| **Backend ➔ Hardware** | `paygo/device/{deviceId}/command` | Credit commands & Relay control   |
| **Hardware ➔ Backend** | `paygo/device/{deviceId}/ack`     | Execution ACK confirmations       |
| **Hardware ➔ Backend** | `paygo/device/{deviceId}/status`  | Device heartbeats & online status |
| **Hardware ➔ Backend** | `paygo/device/{deviceId}/energy`  | Energy consumption reports        |

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
