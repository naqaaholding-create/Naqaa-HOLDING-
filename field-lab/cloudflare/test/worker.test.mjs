import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function makeEnv() {
  return {
    DB: {
      prepare(sql) {
        return {
          async first() {
            if (sql.includes("SELECT 1 AS ok")) return { ok: 1 };
            return null;
          },
          bind() { return this; },
          async run() { return { meta: { changes: 0 } }; },
          async all() { return { results: [] }; }
        };
      },
      async batch() { return []; }
    },
    ASSETS: { fetch: async () => new Response("asset") }
  };
}

async function call(path, init = {}) {
  return worker.fetch(new Request("https://example.test" + path, init), makeEnv());
}

test("health endpoint verifies the database binding", async () => {
  const response = await call("/health");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("plans endpoint keeps real payments disabled", async () => {
  const response = await call("/plans");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.payments_enabled, false);
  assert.equal(body.plans.free.price_usd, 0);
  assert.equal(body.plans.daily.price_usd, 10);
});

test("payment status explicitly reports that no receiving address is configured", async () => {
  const response = await call("/payments/status");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.payments_enabled, false);
  assert.equal(body.receive_address_configured, false);
  assert.equal(body.receive_address, null);
});

test("payment creation stays closed", async () => {
  const response = await call("/payments/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan: "daily" })
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).detail, /معطلة/);
});

test("unknown API routes return 404 rather than serving the app shell", async () => {
  const response = await call("/auth/not-a-route", { method: "POST" });
  assert.equal(response.status, 404);
});
