# API deployment checklist

This API is **not yet production-ready**. Containerizing it does not deploy it, create HTTPS, or provision durable storage.

## Required production infrastructure

- Deploy this folder as a Docker web service behind provider-managed HTTPS.
- Provision managed PostgreSQL and set `FIELD_LAB_DATABASE_URL` to its private connection URL.
- Set `FIELD_LAB_ENV=production` and a unique random `FIELD_LAB_JWT_SECRET` (at least 32 random bytes).
- Set `FIELD_LAB_ALLOWED_ORIGINS` to the exact HTTPS frontend origins.
- Add managed backups, monitoring, request limits, database migrations, rate limits, email verification, password reset, and audit logging.
- Keep all secrets in the host's secret/environment settings, never in Git or the Android app.
- Payment intents and on-chain subscription verification are implemented in the release branch; keep `FIELD_LAB_LIVE_PAYMENTS_ENABLED=0` until the production checklist below passes.
- Live payments require persistent PostgreSQL, not SQLite or ephemeral storage.
- The app has no withdrawal feature.

## Safe TRON testnet verification

The `payments_testnet.py` module only allows the official Nile testnet endpoint and does not credit balances or activate subscriptions. To run its unit tests:

```sh
cd field-lab/api
python -m unittest -v test_payments_testnet.py
```

For an optional manual Nile test, configure all of the following in a **test-only environment**:

- `FIELD_LAB_ENV=test`
- `FIELD_LAB_TRON_TEST_RECEIVE_ADDRESS`: your testnet receiving address (not a mainnet address)
- `TRON_TESTNET_USDT_CONTRACT`: the exact verified token contract deployed on Nile, 40 hex characters without a prefix
- `TRON_TESTNET_TOKEN_DECIMALS=6` (only if the test token actually uses six decimals)
- `TRON_TESTNET_MIN_CONFIRMATIONS=2`
- Optional `TRONGRID_API_KEY` for the provider

Do not assume a mainnet USDT contract exists on Nile. Obtain and independently verify the test token contract from a trusted TRON testnet source before running an on-chain test. This testnet verifier is not wired into account balances or subscriptions and must not be used to claim a payment was received. Mainnet and real payments remain disabled.

## Android signing

The repository workflow `.github/workflows/mobile-android-store-release.yml` requires the GitHub Actions secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Store the original keystore and passwords safely outside GitHub; never commit them or paste them into chat. Run the workflow only after confirming that the keystore is backed up and matches any previously distributed release. The workflow builds an Android App Bundle for Play Store, not a signed universal APK.


## Mainnet USDT subscription payments

- Tether lists USDT on TRON (TRC20) and the canonical token contract in its supported-protocols reference: https://tether.to/en/supported-protocols/
- Runtime variables: `FIELD_LAB_ENV=production`, `FIELD_LAB_LIVE_PAYMENTS_ENABLED=0` (set to `1` only once production checks pass), `FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS` (public address only), `TRONGRID_API_KEY`, `FIELD_LAB_DATABASE_URL` (persistent PostgreSQL), and `FIELD_LAB_ALLOWED_ORIGINS` (the exact HTTPS frontend origin).
- Each invoice expires after 60 minutes. A plan activates only after an on-chain successful transfer to the configured receiver from the canonical USDT contract with the exact amount and at least 20 confirmations. Transaction IDs cannot be reused.
- Never put private keys or recovery phrases in the application or repository. Check the SafePal receiving address carefully. The release must stay closed while `/payments/status` returns `payments_enabled: false`.
