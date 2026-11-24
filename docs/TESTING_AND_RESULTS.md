# PAYGO Unit and Functional Test Record

**Repository:** Telzeez/PayGo_Backend  
**Test framework:** Node.js native test runner through `tsx --test`  
**Status:** Test cases are defined in source. A passing result is only recorded after the command is executed successfully in CI or a configured development environment.

## 1. Unit testing

Unit tests isolate deterministic functions and middleware. They do not prove that the physical meter, sensor, relay, Wi-Fi connection or Paystack production service works.

| Area | Test case | Expected/asserted result | Test location |
|---|---|---|---|
| Load assessment | Connected and simultaneous appliance demand | 240 W connected/simultaneous demand for the fixture; 288 W with 20% margin | `src/__tests__/loadAssessment.test.ts` |
| Load assessment | Apparent power and starting surge | 353.33 VA requested apparent power and 953.33 VA requested starting surge for the fixture | Same |
| Load assessment | Simultaneous quantity | Installed quantity 5 with 2 simultaneous gives 20 W demand | Same |
| Load assessment | Invalid selection, duplicate row, invalid margin and invalid override | Each invalid input throws a validation error | Same |
| Location | Coordinate validation | Valid latitude/longitude accepted; out-of-range and non-numeric values rejected | `src/__tests__/marketplace.test.ts` |
| Location | Haversine distance | Identical coordinates return 0 m; fixtures check approximately 178 m and 1.78 km | Same |
| Location | 50 m radius boundary | 50 m is included; 51 m is excluded | Same |
| Marketplace rules | Effective search radius | Smallest of buyer radius, seller service radius and platform cap is selected | Same |
| Marketplace rules | Sellable inventory | 7 kWh request is rejected when 6 kWh remains | Same |
| Security middleware | Missing device API key | Request rejected with HTTP 401; next middleware is not called | `src/__tests__/security.test.ts` |
| Security middleware | Non-admin role | OWNER role is rejected by the ADMIN-only guard with HTTP 403 | Same |
| Security middleware | ADMIN role | Authenticated ADMIN passes the role guard | Same |

## 2. Functional and API integration testing

These tests start the Express application on a local ephemeral HTTP port and exercise API routes. External dependencies and database operations are stubbed/mocked in several cases; therefore these are automated route/integration simulations, not end-to-end tests against live Paystack, a live PostgreSQL database, MQTT broker or physical ESP32.

| Area | Test case | Expected/asserted result | Test location |
|---|---|---|---|
| Health endpoint | GET /health | HTTP 200 with status, timestamp and uptime | `src/__tests__/endpoints.test.ts` |
| Authentication | Register with missing required fields | HTTP 400 and validation error | Same |
| Authentication | Register valid buyer fixture | HTTP 201 and token/user payload | Same |
| Authentication | Login with valid mocked credentials | HTTP 200 and token/user payload | Same |
| Routing | Unknown API route | HTTP 404 | Same |
| Payment initiation | Missing device ID | HTTP 400 | Same |
| Payment initiation | Amount below ₦100 minimum | HTTP 400 | Same |
| Payment initiation | Mocked Paystack initialization | HTTP 200 with checkout URL and reference | Same |
| Paystack webhook | Invalid HMAC signature | HTTP 401 | Same |
| Paystack webhook | Valid signed success event | HTTP 200; mocked DB path checks transaction/balance/token write intent | Same |
| Paystack webhook | Replayed reference | HTTP 200 duplicate response; no second balance credit in the mocked query path | Same |
| Device API access | Unauthenticated platform device reads | HTTP 401 | Same |
| Hardware API access | Missing device API key on balance/heartbeat/ACK/energy/redeem routes | HTTP 401 | Same |
| Transaction verification | Unknown reference | Pending response | Same |
| Transaction verification | Existing mocked token record | Success response with token details | Same |
| Hardware lifecycle simulation | Accepted credit ACK | Transaction hardware status updated to CONFIRMED in mocked DB | Same |
| Firmware idempotency simulation | Same transaction ID delivered twice | Second credit ignored; simulated balance remains 25 kWh | Same |
| Fallback token simulation | Token marked auto_credited | No second database balance addition | Same |
| Offline payment simulation | MQTT unavailable during payment | Test checks PENDING hardware state and fallback-token creation in mocked DB path | Same |

## 3. Prototype tests that are not software unit tests

The following require physical measurements or a live hardware/network setup. Do not label them as passed based only on automated code tests.

| Test | Evidence required before recording a measured result |
|---|---|
| Voltage/current/power accuracy | Simultaneous PZEM readings and reference multimeter/clamp meter or plug-in watt meter readings |
| Load stability | Timestamped readings over a stated duration; calculate mean and standard deviation |
| Load step response | Actual time-series readings during load switching |
| Energy accounting | Known load and run duration compared with meter kWh and backend balance deduction |
| Prepaid cut-off | Actual remaining balance and relay opening time across repeated runs |
| Offline/reconnection sync | Device and server balances logged before, during and after Wi-Fi outage |
| Payment-to-device latency | Timestamped Paystack test payment, webhook receipt and meter credit acknowledgement |
| Marketplace distance validation | Known coordinate pairs compared with a named mapping/reference source |

## 4. Commands to execute

Run from the backend repository root:

```bash
npm run type-check
npm test
npm run test:integration
```

- `npm test` runs the unit test files configured in `package.json`.
- `npm run test:integration` runs the HTTP/API and hardware-lifecycle integration simulations.
- Record the actual pass/fail totals and execution date from the terminal or CI output. Do not substitute expected outcomes for executed results.

## 5. Important implementation note

The current payment processor source comments state that the ESP32 obtains payment credits through HTTPS heartbeat/balance synchronisation. Some legacy MQTT lifecycle tests and README descriptions still describe MQTT credit dispatch. Confirm the currently deployed firmware/backend path before using those legacy MQTT tests as evidence of the live payment-to-meter flow. The tests in this document describe the assertions present in the repository, not proof of a physical device test.
