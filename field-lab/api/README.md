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
- `GET /payments/status` — readiness-only status for the planned USDT-TRC20 integration; always reports live payments and withdrawals disabled until transaction verification and ledger controls are implemented.

## Proposed limits

- Free trial: 2 site records and 10 questions lifetime.
- Daily: $10, 2 site records and 20 questions per day.
- Weekly: $50, 10 site records and 100 questions per 7-day window.
- Monthly: $100, 30 site records and 300 questions per 30-day window.

## Tests

Run `pip install -r requirements.txt pytest httpx` and then `pytest -q`. GitHub Actions runs these tests when files in `field-lab/api/` change.

## Important limitations

- Payments are disabled. Paid plans cannot be purchased or self-activated. Do not treat a displayed price as a payment integration.
- The account UI is not yet fully integrated with actual site creation; the API is an initial backend milestone.
- Usage limits must be checked by the server before creating records or running any analysis. The client must not call `/usage/consume` until it is ready to perform the corresponding action, or users could consume quota without completing it.
- Before production: configure a strong secret, HTTPS, an externally managed database, database migrations, rate limiting, account verification/password reset, audit logging, backups, and a verified payment provider/webhook. Add atomic quota consumption / idempotency for concurrent requests before public launch.
- No automatic scientific image analysis is provided by this API.


## Real-money readiness (not live yet)

The wallet interface no longer creates fake balances. The current payment status endpoint is fail-closed and reports live payments/withdrawals as disabled. The intended first payment route is USDT on TRON (TRC20) using a **public receiving address** from SafePal. Do not commit the address or provider keys to Git; configure secrets only in the deployment environment.

Before accepting real funds, implement and test: chain transaction lookup and confirmation thresholds; exact token contract and amount checks; unique payment intents and idempotent processing; a server-side double-entry ledger; subscription activation only after verified settlement; authenticated admin review for withdrawals; audit logs and alerts; abuse/rate limiting; backups; and an independent security review. Never request or store a SafePal seed phrase or private key in the app or server. Do not send money while the app says payments are disabled.
