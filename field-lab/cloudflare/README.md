# Cloudflare Worker + D1 (separate, safe deployment path)

This is a separate Cloudflare implementation for NAQAA Field Lab. It does not replace the existing FastAPI/PostgreSQL backend.

## Included
- Serves the existing `field-lab/` static app from Worker Assets.
- Implements `/health`, `/plans`, `/auth/register`, `/auth/login`, `/me`, `/me/usage`, and `/usage/consume`.
- Stores accounts and usage in Cloudflare D1.
- Uses Web Crypto PBKDF2-SHA256 password hashing and HMAC-SHA256 JWTs.
- All payment endpoints remain hard-disabled and return no live invoice. Never send real funds.

## Important status
This is a deployment scaffold, not a production approval. It must pass runtime tests before public use. Email verification, password reset, rate limiting, monitoring, and security review are still needed. Existing records/photos remain in browser IndexedDB; this API does not upload or sync them.

## Set up once in Cloudflare
1. Create a D1 database named `naqaa-field-lab-db` in the Cloudflare dashboard.
2. Copy its database ID into `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`.
3. In the Worker settings, add a secret named `JWT_SECRET` with at least 32 random bytes. Do not commit the secret or send it in chat.
4. Run the SQL in `schema.sql` against that D1 database (Cloudflare D1 > database > Console, or Wrangler).
5. Deploy this folder with the Wrangler configuration. Assets are served from the parent `field-lab/` folder.
6. Check `/health`, register a test account, sign in, and test quotas. Keep payments disabled.

## Free tier
Cloudflare's free plan has usage limits and product terms can change. This folder does not guarantee unlimited use or that every account feature is free. Review Cloudflare's current plan and billing screen before creating resources. Do not enable paid resources without explicit approval.
