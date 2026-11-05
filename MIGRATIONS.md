# Database migrations

The backend's existing `src/init-db.sql` is an idempotent development/bootstrap schema, not a versioned production migration system. New schema changes are stored under `migrations/` and are **not** automatically applied by server startup.

## Migration 001

`001_platform_roles_devices_marketplace.up.sql` adds the platform-admin MFA/session fields, device registration and assignment metadata, energy-source meter-assignment relationships, immutable buyer-meter snapshots, demo archive markers, and audit/operation tables.

Before deploying:

1. Take a database backup and verify it can be restored.
2. Deploy compatible backend code and required environment configuration.
3. Inspect existing `OWNER` users and decide which accounts, if any, should receive `PLATFORM_ADMIN` through a trusted operator-only SQL procedure. The migration deliberately converts legacy `OWNER` roles to ordinary `USER`; it never promotes all owners to administrators.
4. Run the migration using a database operator, for example:

   ```sh
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_platform_roles_devices_marketplace.up.sql
   ```

5. Verify the migration and admin MFA enrollment before enabling the new portal.

The migration archives (rather than deletes) the three seeded `DEVICE-001` sources and their listings. Historical purchase, payment, transaction, and device rows are retained. `DEVICE-001` is marked as demo hardware and is not assigned to a buyer or prosumer.

## Rollback

`001_platform_roles_devices_marketplace.down.sql` removes only the new relationship constraints. It intentionally retains audit logs, hardware-operation records, pairing challenges, demo archive markers, role/MFA fields, and purchase snapshots. Removing those fields/tables would destroy new audit and payment-reconciliation evidence; a full destructive rollback requires a reviewed backup restore and is not automated here.

## Current hardware pairing limitation

The checked-in backend currently receives unsigned HTTP heartbeat/ACK payloads and shared MQTT messages. The corresponding firmware/provisioning source is not present in this repository. A secure self-service ownership proof cannot be completed by trusting a user-entered meter ID or an unsigned heartbeat. The migration reserves the storage for expiring one-time challenges, but public pairing must remain disabled until device firmware can return a device-specific cryptographic proof and deployment provisioning can seed the corresponding verifier. Do not place a shared MQTT secret or a reusable device secret in client-side code.
