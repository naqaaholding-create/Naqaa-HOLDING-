# NAQAA Field Lab API (initial backend)

This folder contains the first backend layer for account registration/login and server-enforced usage quotas. It is separate from the static/Capacitor app.

## Local run

```bash
cd field-lab/api
python -m venv .venv
# activate the environment, then:
pip install -r requirements.txt
export FIELD_LAB_JWT_SECRET="replace-with-a-long-random-secret"
uvicorn main:app --host 127.0.0.1 --port 8000
```

Open `/docs` for the interactive API reference and `/health` for a health check.

## Endpoints

- `POST /auth/register` — create a user with a hashed password; new accounts start on the free trial.
- `POST /auth/login` — issue a short-lived bearer token.
- `GET /me` — current account.
- `GET /me/usage` — server-calculated plan quota.
- `POST /usage/consume` with `{"action":"site"}` or `{"action":"question"}` — consume a quota unit.
- `GET /plans` — show the proposed prices and limits.
- `GET /health` — basic health status.
- `GET /payments/status` — shows whether all required production settings are valid.
- `POST /payments/intents` — creates an authenticated USDT subscription invoice.
- `POST /payments/verify` — verifies a mainnet transaction before subscription activation.
- `GET /payments/history` — lists payment requests belonging to the logged-in account.

## Proposed limits

- Free trial: 2 site records and 10 questions lifetime.
- Daily: $10, 2 site records and 20 questions per day.
- Weekly: $50, 10 site records and 100 questions per 7-day window.
- Monthly: $100, 30 site records and 300 questions per 30-day window.

## Tests

Run `pip install -r requirements.txt pytest httpx` and then `pytest -q`. GitHub Actions runs these tests when files in `field-lab/api/` change.

## Important limitations

- Live payments are disabled by default. They become available only when all production settings are valid; prices alone do not enable checkout.
- Site records and photos are currently stored in the browser's local IndexedDB, not synced to the server or shared across devices. If the API URL is configured, site quota is checked against the account before local save.
- Usage limits must be checked by the server before creating records or running any analysis. The client must not call `/usage/consume` until it is ready to perform the corresponding action, or users could consume quota without completing it.
- Before production: configure a strong secret, HTTPS, a persistent database, schema migrations, rate limiting, account verification/password reset, audit logging, backups, monitoring, and independent security review.
- No automatic scientific image analysis is provided by this API.


## Real-money readiness (not live yet)

The payment feature accepts subscription purchases only; this app has no withdrawal feature. It accepts USDT solely on TRON (TRC20) to the configured public receiving address. The server validates the official Tether contract, exact amount, receiver, the sender address declared before checkout, successful execution, invoice time window, at least 20 confirmations, and unique transaction IDs. Customers must send directly from that declared TRON wallet address; third-party exchange transfers may not match the sender check. Subscription activation is committed with the payment record in the same database transaction. Never commit the receiver address or provider API key to Git; set these only in the hosting provider's secret/environment settings. Never request or store a SafePal seed phrase or private key.

Live payments require `FIELD_LAB_ENV=production`, `FIELD_LAB_LIVE_PAYMENTS_ENABLED=1`, a valid `FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS`, `TRONGRID_API_KEY`, persistent PostgreSQL at `FIELD_LAB_DATABASE_URL`, and an HTTPS origin in `FIELD_LAB_ALLOWED_ORIGINS`. The default payment flag is off. Verify the receiving address in SafePal and the canonical contract with Tether's official documentation before enabling checkout. Do not tell customers to send funds while `GET /payments/status` reports `payments_enabled: false`.
