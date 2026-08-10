# ⚡ PAYGO Backend - Solar Energy Metering & Billing System

A robust, enterprise-grade backend service built with **Node.js**, **Express.js**, **TypeScript**, **PostgreSQL**, and **MQTT**. This server powers the PAYGO (Pay-As-You-Go) solar energy trading and metering platform, enabling automated payment processing via Paystack, cryptographic token generation, SMS notification delivery via Termii, and real-time hardware meter balance crediting over secure MQTT (HiveMQ Cloud TLS).

---

## 📋 Table of Contents

- [Features](#-features)
- [System Architecture](#-system-architecture)
- [Tech Stack](#-tech-stack)
- [Project Directory Structure](#-project-directory-structure)
- [Database Schema](#-database-schema)
- [Environment Variables](#-environment-variables)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Database Setup](#database-setup)
  - [Installation](#installation)
  - [Running the Server](#running-the-server)
- [API Reference](#-api-reference)
  - [Health Check](#health-check)
  - [Payment Initiation](#payment-initiation)
  - [Paystack Webhook](#paystack-webhook)
  - [Device Synchronization](#device-synchronization)
  - [Transaction Verification](#transaction-verification)
- [MQTT Communication Protocol](#-mqtt-communication-protocol)
  - [Redemption Flow](#redemption-flow)
  - [Topic Taxonomy](#topic-taxonomy)
- [Security & Reliability Features](#-security--reliability-features)

---

## ✨ Features

- **Automated Paystack Payment Integration**: Seamlessly initialize transactions and handle asynchronous webhook notifications for verified payments.
- **HMAC-SHA512 Webhook Security**: Raw request body interception and HMAC-SHA512 signature validation to prevent unauthorized webhook spoofing.
- **Cryptographic Token Engine**: Generates 8-digit secure numerical tokens per payment, salted and hashed using `bcrypt` before storage.
- **Atomic Database Transactions**: Utilizes PostgreSQL explicit transactions (`BEGIN`, `FOR UPDATE`, `COMMIT`, `ROLLBACK`) for race-condition prevention and strict idempotency.
- **Real-Time Hardware Messaging (MQTT)**: Connected via TLS (`mqtts://`) to HiveMQ Cloud. Subscribes to hardware redemption requests and issues real-time hardware credit commands.
- **SMS Token Dispatch**: Dispatches generated token codes directly to customer mobile numbers via Termii SMS API with automatic console fallbacks for development.
- **Device Ledger & Balance Tracking**: Dynamic upsert and balance calculation for hardware meters, tracking total top-ups and energy consumption records.

---

## 🏗 System Architecture

```mermaid
sequenceDiagram
    autonumber
    actor Buyer as Buyer / User
    participant App as Mobile/Web Frontend
    participant PS as Paystack Gateway
    participant API as Backend Server (Express)
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
    API->>API: Verify Signature & Generate 8-Digit Token
    API->>DB: Atomic DB Tx: Hash Token & Insert Row
    API->>SMS: Send Token via SMS
    SMS-->>Buyer: Deliver SMS with Token Code
    
    Note over Buyer,ESP: Token Redemption via Hardware Keypad or MQTT
    Buyer->>ESP: Input 8-Digit Token Code
    ESP->>Broker: Publish paygo/device/{id}/redeem {code}
    Broker->>API: Deliver Redemption Message
    API->>DB: Query Token Hash (bcrypt verify) & Lock Device Row
    API->>DB: Update Token (used=true), Add Balance, Insert Tx Record
    API->>Broker: Publish paygo/device/{id}/command {action: CREDIT, kwh}
    API->>Broker: Publish paygo/device/{id}/response {status: SUCCESS}
    Broker->>ESP: Relay CREDIT Command & Response
    ESP->>ESP: Energize Relay & Credit Meter Balance
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
- **Dev Runner**: `tsx` (TypeScript Execute & Watcher)

---

## 📁 Project Directory Structure

```text
backend/
├── .env                  # Environment configurations (Git ignored)
├── package.json          # Project dependencies & scripts
├── tsconfig.json         # TypeScript compiler configurations
└── src/
    ├── app.ts            # Express application setup & middleware/routes mounting
    ├── index.ts          # Main HTTP server entrypoint & MQTT client bootstrapper
    ├── db.ts             # PostgreSQL pool connection configuration
    ├── mqtt-client.ts    # MQTT client instance, topics handler & redemption logic
    ├── init-db.sql       # Database table schemas, constraints & indexes
    ├── __tests__/
    │   └── endpoints.test.ts # Endpoint unit & integration test suite
    ├── middlewares/
    │   └── middleware.ts # Request logger, 404 handler, global error handler
    ├── routes/
    │   ├── payment.ts    # /api/payment/initiate endpoint
    │   ├── webhook.ts    # /api/webhook/paystack HMAC-verified webhook handler
    │   ├── devices.ts    # /api/devices/:deviceId balance & transactions handler
    │   └── transactions.ts # /api/transactions/verify/:reference lookup endpoint
    ├── services/
    │   └── sms.ts        # Termii SMS delivery service with fallback logger
    └── types/
        └── index.ts      # TypeScript interfaces and payload type definitions
```

---

## 🗄 Database Schema

The database schema is defined in [`src/init-db.sql`](file:///c:/Users/Telzeez/Desktop/SolarPayMe(SPM)/backend/src/init-db.sql) and consists of three primary tables:

### 1. `paygo_tokens`
Stores generated electricity top-up tokens.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `SERIAL` | `PRIMARY KEY` | Auto-incrementing identifier |
| `buyer_email` | `VARCHAR(255)` | `NOT NULL` | Email address of the token purchaser |
| `device_id` | `VARCHAR(50)` | `NOT NULL` | Associated hardware meter ID |
| `kwh_amount` | `DECIMAL(10,2)`| `NOT NULL` | Purchased energy units in kWh |
| `token_hash` | `VARCHAR(255)` | `NOT NULL` | Bcrypt hash of the 8-digit token code |
| `paystack_reference`| `VARCHAR(255)`| `UNIQUE` | Unique Paystack transaction reference |
| `created_at` | `TIMESTAMP` | `DEFAULT NOW()` | Record creation timestamp |
| `expires_at` | `TIMESTAMP` | `NOT NULL` | Token expiration date (72h default) |
| `used` | `BOOLEAN` | `DEFAULT FALSE` | Flag indicating if token has been redeemed |
| `redeemed_at` | `TIMESTAMP` | `NULL` | Timestamp of successful token redemption |

**Indexes**: `idx_tokens_device_id`, `idx_tokens_used`, `idx_tokens_expires_at`

### 2. `devices`
Tracks hardware units and current active meter balances.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `SERIAL` | `PRIMARY KEY` | Unique database identifier |
| `device_id` | `VARCHAR(50)` | `UNIQUE, NOT NULL` | Target meter serial number / ID |
| `current_balance` | `DECIMAL(10,2)`| `DEFAULT 0` | Current available energy credit (kWh) |
| `last_updated` | `TIMESTAMP` | `DEFAULT NOW()` | Timestamp of last balance change |

### 3. `transactions`
Maintains an immutable historical audit ledger for meter operations.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `SERIAL` | `PRIMARY KEY` | Unique transaction ID |
| `device_id` | `VARCHAR(50)` | `NOT NULL` | Target device identifier |
| `type` | `VARCHAR(20)` | `CHECK ('topup','consumption')` | Ledger transaction classification |
| `amount` | `DECIMAL(10,2)`| `NOT NULL` | Amount of kWh added or deducted |
| `timestamp` | `TIMESTAMP` | `DEFAULT NOW()` | Log timestamp |

**Indexes**: `idx_transactions_device_id`

---

## ⚙️ Environment Variables

Create a `.env` file in the `backend/` directory with the following parameters:

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

# HiveMQ / MQTT Broker Connection
MQTT_BROKER_URL=mqtts://your-broker.hivemq.cloud:8883
MQTT_USER=paygo_server
MQTT_PASS=YourMqttPassword
```

---

## 🚀 Getting Started

### Prerequisites

Ensure you have the following installed on your system:
- **Node.js** (v18.x or higher)
- **npm** (v9.x or higher)
- **PostgreSQL** (v14.x or higher)

### Database Setup

1. Start your local or remote PostgreSQL instance.
2. Create a database for the application (e.g., `paygo_db`).
3. Run the initialization script [`src/init-db.sql`](file:///c:/Users/Telzeez/Desktop/SolarPayMe(SPM)/backend/src/init-db.sql) to set up tables and indexes:

```bash
psql -U postgres -d paygo_db -f src/init-db.sql
```

### Installation

1. Clone the repository and navigate into the `backend` folder:
   ```bash
   cd backend
   ```
2. Install npm dependencies:
   ```bash
   npm install
   ```

### Running the Server

- **Development Mode** (Hot Reloading via `tsx`):
  ```bash
  npm run dev
  ```
- **Run Endpoint Tests**:
  ```bash
  npm test
  ```
- **Type Checking**:
  ```bash
  npm run type-check
  ```
- **Production Build & Start**:
  ```bash
  npm run build
  npm start
  ```

---

## 📡 API Reference

### Health Check

#### `GET /health`
Returns the server status, uptime, and system timestamp.

**Response (200 OK):**
```json
{
  "status": "OK",
  "timestamp": "2026-08-10T18:30:00.000Z",
  "uptime": 124.52
}
```

---

### Payment Initiation

#### `POST /api/payment/initiate`
Initializes a Paystack payment session for energy unit purchasing.

**Request Body:**
```json
{
  "amount": 1000,
  "email": "customer@example.com",
  "deviceId": "device_001"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "paymentUrl": "https://checkout.paystack.com/xxxxxx",
  "reference": "px_ref_12345678"
}
```

---

### Paystack Webhook

#### `POST /api/webhook/paystack`
Receives payment notification events from Paystack.

- **Headers Required**: `x-paystack-signature` (HMAC-SHA512 signature computed with `PAYSTACK_SECRET_KEY`).
- **Behavior**:
  1. Validates signature against raw body buffer.
  2. Initiates atomic DB transaction (`BEGIN`).
  3. Checks idempotency using `FOR UPDATE`.
  4. Calculates `kwhAmount = amountPaid / PRICE_PER_KWH`.
  5. Generates random 8-digit token, hashes with `bcrypt`, stores token record.
  6. Dispatches SMS via Termii API.
  7. Commits transaction (`COMMIT`).

---

### Device Synchronization

#### `GET /api/devices/:deviceId`
Extracts current meter balance and recent transaction history. If the device record does not exist, performs an atomic upsert to register it.

**Response (200 OK):**
```json
{
  "success": true,
  "deviceId": "device_001",
  "balance": 15.5,
  "lastUpdated": "2026-08-10T18:00:00.000Z",
  "transactions": [
    {
      "id": 1,
      "type": "topup",
      "amount": 5.0,
      "timestamp": "2026-08-10T17:45:00.000Z"
    }
  ]
}
```

---

### Transaction Verification

#### `GET /api/transactions/verify/:reference`
Queries token processing state using the Paystack reference string.

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "kwhAmount": "5.00",
    "expiresAt": "2026-08-13T17:45:00.000Z",
    "used": false
  }
}
```

---

## 🔌 MQTT Communication Protocol

The backend maintains an active connection to HiveMQ Cloud using MQTTS (Port `8883`).

```
                +-----------------------+
                |  HiveMQ Cloud Broker  |
                +-----------+-----------+
                            |
         +------------------+------------------+
         |                                     |
[Sub: paygo/device/+/redeem]      [Pub: paygo/device/{id}/command]
         |                                     |
+--------v--------+                   +--------v--------+
| PAYGO Backend   |                   | ESP32 Hardware  |
| Server          |                   | Meter           |
+-----------------+                   +-----------------+
```

### Redemption Flow

1. **Device Requests Redemption**:
   Device publishes a payload to topic `paygo/device/{deviceId}/redeem`:
   ```json
   {
     "code": "84729104"
   }
   ```

2. **Server Validates Token**:
   - Queries active, unused, non-expired tokens for `{deviceId}` with row locks (`FOR UPDATE`).
   - Verifies code against `token_hash` via `bcrypt.compare`.

3. **Server Credits Meter**:
   If valid, server marks token `used = true`, updates `devices.current_balance`, logs a transaction, and publishes a command to `paygo/device/{deviceId}/command`:
   ```json
   {
     "action": "CREDIT",
     "kwh": 5.0,
     "timestamp": "2026-08-10T18:31:00.000Z"
   }
   ```

4. **Server Sends Response**:
   Server publishes status report to `paygo/device/{deviceId}/response`:
   ```json
   {
     "status": "SUCCESS",
     "message": "5 kWh added",
     "timestamp": "2026-08-10T18:31:00.000Z"
   }
   ```

---

## 🔒 Security & Reliability Features

1. **HMAC-SHA512 Webhook Verification**: Raw buffer middleware captures body bytes before parsing to verify Paystack cryptographic headers.
2. **Double-Spend & Race Condition Protection**: PostgreSQL row-level locking (`FOR UPDATE`) ensures two concurrent redemption requests or duplicated webhooks cannot redeem the same token twice.
3. **Password & Token Security**: Tokens are generated via high-entropy `crypto.randomInt` and stored using `bcrypt` standard hashing. Raw tokens are never logged or persisted in cleartext DB tables.
4. **Resilient MQTT Ticker**: Automatic reconnection strategy using `reconnectPeriod` and strict TLS certificate verification (`rejectUnauthorized: true`).
5. **Database Transaction Rollback**: All multi-step database mutations (e.g. token insertion + SMS dispatch or redemption + credit issuance) rollback automatically on failures to maintain database integrity.

---

## 📄 License

This backend repository is part of the PAYGO Solar Energy Trading Platform project. Developed by Abdlazeez Olasunkanmi, 2026.
