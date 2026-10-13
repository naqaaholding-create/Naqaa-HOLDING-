# API deployment checklist

This API is **not yet production-ready**. Containerizing it does not deploy it, create HTTPS, or provision durable storage.

## Required production infrastructure

- Deploy this folder as a Docker web service behind provider-managed HTTPS.
- Provision managed PostgreSQL and set `FIELD_LAB_DATABASE_URL` to its private connection URL.
- Set `FIELD_LAB_ENV=production` and a unique random `FIELD_LAB_JWT_SECRET` (at least 32 random bytes).
- Set `FIELD_LAB_ALLOWED_ORIGINS` to the exact HTTPS frontend origins.
- Add managed backups, monitoring, request limits, database migrations, rate limits, email verification, password reset, and audit logging.
- Keep all secrets in the host's secret/environment settings, never in Git or the Android app.
- Payment intents and on-chain subscription verification are implemented on `main`; the dedicated `render.field-lab.yaml` deploys this API and the Field Lab frontend at one origin. Keep `FIELD_LAB_LIVE_PAYMENTS_ENABLED=0` until the production checklist below passes.
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

Do not assume a mainnet USDT contract exists on Nile. Obtain and independently verify the test token contract from a trusted TRON testnet source before running an on-chain test. This testnet verifier is separate from live subscription verification and must not be used to claim a mainnet payment was received. The live-payment flag defaults to off and remains off until the production blueprint and required credentials are configured.

## Android signing

The Field Lab release workflow `.github/workflows/field-lab-signed-android-release.yml` requires the GitHub Actions secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Store the original keystore and passwords safely outside GitHub; never commit them or paste them into chat. Run the workflow only after confirming that the keystore is backed up and matches any previously distributed release. The workflow builds an Android App Bundle for Play Store, not a signed universal APK.


## Mainnet USDT subscription payments

- Tether lists USDT on TRON (TRC20) and the canonical token contract in its supported-protocols reference: https://tether.to/en/supported-protocols/
- Runtime variables: `FIELD_LAB_ENV=production`, `FIELD_LAB_LIVE_PAYMENTS_ENABLED=0` (set to `1` only once production checks pass), `FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS` (public address only), `TRONGRID_API_KEY`, `FIELD_LAB_DATABASE_URL` (persistent PostgreSQL), and `FIELD_LAB_ALLOWED_ORIGINS` (the exact HTTPS frontend origin).
- Each invoice expires after 60 minutes. A plan activates only after an on-chain successful transfer to the configured receiver from the canonical USDT contract with the exact amount and at least 20 confirmations. Transaction IDs cannot be reused.
- Never put private keys or recovery phrases in the application or repository. Check the SafePal receiving address carefully. The release must stay closed while `/payments/status` returns `payments_enabled: false`.


## One-click infrastructure template

The dedicated Render Blueprint is `render.field-lab.yaml` in the repository root. In Render, create a new Blueprint and set the Blueprint file path to this filename (do not use the repository's `render.yaml`, which belongs to NAQAA Market). It declares the Field Lab Docker API plus persistent PostgreSQL. It provisions paid compute/database resources; review prices in the Render Dashboard before applying it.

After provisioning:
1. Set `FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS` to the confirmed public SafePal receive address for TRON mainnet USDT and `TRONGRID_API_KEY` in Render's secret settings.
2. Check that the API's `/payments/status` returns all readiness checks clean and `payments_enabled: false` until the app frontend is pointing to the new HTTPS API URL.
3. Update `field-lab/api-config.js` with the assigned API HTTPS URL; commit and wait for Pages deployment.
4. Check account registration/login, invoice creation, mainnet verification behavior, quotas, and the health endpoint. Only after these pass, set `FIELD_LAB_LIVE_PAYMENTS_ENABLED=1` and verify `/payments/status` returns `payments_enabled: true`.
5. Do not ask customers to send payment until the frontend displays the verified receiving address and exact current invoice amount. Do not test with a real transfer; use mocked tests first.

The Render Blueprint cannot infer the unique URL assigned to your account before you apply it, so `field-lab/api-config.js` intentionally remains blank until that URL exists.


## Signed Android production build

The manual release workflow `.github/workflows/field-lab-signed-android-release.yml` also requires a GitHub Actions secret named `FIELD_LAB_API_BASE`. Set it to the actual HTTPS origin assigned to the deployed Render service, without a path or trailing slash. This is injected into the app's packaged `api-config.js`, so Android uses the remote API instead of its local WebView origin. It is a public service URL, not a private key.

Keep the Android signing keystore and passwords in these repository Actions secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Do not store these values in source code or this chat.
