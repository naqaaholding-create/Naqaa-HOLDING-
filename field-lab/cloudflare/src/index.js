const PLANS = {
  free: { price_usd: 0, duration_days: null, sites: 2, questions: 10, window_days: null, label: "التجربة المجانية" },
  daily: { price_usd: 10, duration_days: 1, sites: 2, questions: 20, window_days: 1, label: "الاشتراك اليومي" },
  weekly: { price_usd: 50, duration_days: 7, sites: 10, questions: 100, window_days: 7, label: "الاشتراك الأسبوعي" },
  monthly: { price_usd: 100, duration_days: 30, sites: 30, questions: 300, window_days: 30, label: "الاشتراك الشهري" }
};
const enc = new TextEncoder();
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const fail = (detail, status) => json({ detail }, status);
const nowIso = () => new Date().toISOString();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const fromB64url = (value) => {
  const s = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
};
const encodeJson = (value) => b64url(enc.encode(JSON.stringify(value)));
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function makeToken(userId, env) {
  if (!env.JWT_SECRET || enc.encode(env.JWT_SECRET).length < 32) throw new Error("JWT_SECRET must be at least 32 bytes");
  const now = Math.floor(Date.now() / 1000);
  const head = encodeJson({ alg: "HS256", typ: "JWT" });
  const body = encodeJson({ sub: String(userId), iat: now, exp: now + 12 * 3600 });
  const unsigned = head + "." + body;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.JWT_SECRET), enc.encode(unsigned));
  return unsigned + "." + b64url(sig);
}
async function readToken(request, env) {
  const header = request.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const parts = header.slice(7).trim().split(".");
  if (parts.length !== 3 || !env.JWT_SECRET) return null;
  try {
    const head = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
    if (head.alg !== "HS256" || !payload.sub || !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) return null;
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.JWT_SECRET), fromB64url(parts[2]), enc.encode(parts[0] + "." + parts[1]));
    return ok ? Number(payload.sub) : null;
  } catch (_) { return null; }
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 210000 }, key, 256);
  return "pbkdf2_sha256$210000$" + b64url(salt) + "$" + b64url(bits);
}
async function verifyPassword(password, digest) {
  try {
    const [algorithm, iterationsText, saltText, expectedText] = digest.split("$");
    if (algorithm !== "pbkdf2_sha256") return false;
    const iterations = Number(iterationsText);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) return false;
    const salt = fromB64url(saltText);
    const expected = fromB64url(expectedText);
    const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, expected.length * 8));
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch (_) { return false; }
}
async function bodyJson(request) {
  try { return await request.json(); } catch (_) { return null; }
}
function emailValid(value) {
  return typeof value === "string" && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
async function getUser(request, env) {
  const id = await readToken(request, env);
  if (!id || !Number.isSafeInteger(id) || id < 1) return null;
  return await env.DB.prepare("SELECT * FROM field_lab_users WHERE id = ?").bind(id).first();
}
function activePlan(user) {
  if (user.plan !== "free" && user.plan_expires_at && Date.parse(user.plan_expires_at) <= Date.now()) return "free";
  return PLANS[user.plan] ? user.plan : "free";
}
async function refreshUser(user, env, planName) {
  if (planName === "free") return user;
  const windowDays = PLANS[planName].window_days || 1;
  const started = Date.parse(user.usage_window_started_at || user.created_at);
  if (Date.now() >= started + windowDays * 86400000) {
    const now = nowIso();
    await env.DB.prepare("UPDATE field_lab_users SET sites_used=0, questions_used=0, usage_window_started_at=? WHERE id=?").bind(now, user.id).run();
    user.sites_used = 0; user.questions_used = 0; user.usage_window_started_at = now;
  }
  return user;
}
function usageOutput(user) {
  const planName = activePlan(user);
  const plan = PLANS[planName];
  return {
    plan: planName, plan_label: plan.label, price_usd: plan.price_usd,
    sites_used: user.sites_used, sites_limit: plan.sites,
    questions_used: user.questions_used, questions_limit: plan.questions,
    expires_at: planName === "free" ? null : user.plan_expires_at,
    payment_enabled: false
  };
}
async function usageFor(user, env) {
  const planName = activePlan(user);
  user = await refreshUser(user, env, planName);
  const fresh = await env.DB.prepare("SELECT * FROM field_lab_users WHERE id=?").bind(user.id).first();
  return usageOutput(fresh || user);
}
async function api(request, env) {
  if (!env.DB) return fail("قاعدة البيانات D1 غير مربوطة بعد.", 503);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/health") {
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      return json({ status: "ok", service: "naqaa-field-lab-api", payments_enabled: false });
    } catch (_) { return fail("قاعدة البيانات غير جاهزة.", 503); }
  }
  if (method === "GET" && path === "/plans") {
    return json({ plans: PLANS, currency: "USD", payments_enabled: false, note: "المدفوعات الحقيقية مغلقة." });
  }
  if (path.startsWith("/payments/")) {
    if (method === "GET" && path === "/payments/status") {
      return json({
        payments_enabled: false, network: "TRON", token: "USDT-TRC20",
        receive_address_configured: false, chain_provider_configured: false,
        persistent_database_configured: false, receive_address: null,
        requirements_remaining: ["المدفوعات الحقيقية معطلة في نسخة Cloudflare"],
        note: "الدفع الحقيقي مغلق. لا ترسل أي أموال."
      });
    }
    return fail("المدفوعات الحقيقية معطلة حاليًا. لا ترسل أي أموال.", 503);
  }

  if (method === "POST" && path === "/auth/register") {
    const body = await bodyJson(request);
    if (!body || !emailValid(body.email) || typeof body.password !== "string" || body.password.length < 10 || body.password.length > 128) {
      return fail("أدخل بريدًا صحيحًا وكلمة مرور من 10 إلى 128 حرفًا.", 422);
    }
    const email = body.email.trim().toLowerCase();
    const existing = await env.DB.prepare("SELECT id FROM field_lab_users WHERE email=?").bind(email).first();
    if (existing) return fail("هذا البريد مسجل مسبقًا", 409);
    const digest = await hashPassword(body.password);
    const now = nowIso();
    try {
      const result = await env.DB.prepare(
        "INSERT INTO field_lab_users (email,password_digest,plan,created_at,plan_expires_at,sites_used,questions_used,usage_window_started_at) VALUES (?,?, 'free', ?, NULL, 0, 0, ?)"
      ).bind(email, digest, now, now).run();
      const id = result.meta?.last_row_id;
      if (!id) return fail("تعذر إنشاء الحساب؛ حاول مجددًا.", 500);
      return json({ access_token: await makeToken(id, env), token_type: "bearer" }, 201);
    } catch (_) { return fail("تعذر إنشاء الحساب؛ ربما يكون البريد مسجلًا مسبقًا.", 409); }
  }

  if (method === "POST" && path === "/auth/login") {
    const body = await bodyJson(request);
    if (!body || !emailValid(body.email) || typeof body.password !== "string") return fail("البريد أو كلمة المرور غير صحيحة", 401);
    const user = await env.DB.prepare("SELECT * FROM field_lab_users WHERE email=?").bind(body.email.trim().toLowerCase()).first();
    if (!user || !(await verifyPassword(body.password, user.password_digest))) return fail("البريد أو كلمة المرور غير صحيحة", 401);
    return json({ access_token: await makeToken(user.id, env), token_type: "bearer" });
  }

  if (path === "/me" || path === "/me/usage" || path === "/usage/consume") {
    const user = await getUser(request, env);
    if (!user) return fail("يلزم تسجيل الدخول أو رمز الدخول غير صالح أو منتهي", 401);
    if (method === "GET" && path === "/me") {
      return json({ id: user.id, email: user.email, plan: activePlan(user), created_at: user.created_at });
    }
    if (method === "GET" && path === "/me/usage") return json(await usageFor(user, env));
    if (method === "POST" && path === "/usage/consume") {
      const body = await bodyJson(request);
      if (!body || !["site", "question"].includes(body.action) ||
          (body.request_id != null && (typeof body.request_id !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(body.request_id)))) {
        return fail("بيانات استهلاك غير صحيحة.", 422);
      }
      const planName = activePlan(user);
      await refreshUser(user, env, planName);
      const fresh = await env.DB.prepare("SELECT * FROM field_lab_users WHERE id=?").bind(user.id).first();
      const plan = PLANS[activePlan(fresh)];
      const field = body.action === "site" ? "sites_used" : "questions_used";
      const limit = body.action === "site" ? plan.sites : plan.questions;
      const nonce = crypto.randomUUID();
      if (body.request_id) {
        const prior = await env.DB.prepare("SELECT id FROM field_lab_usage_receipts WHERE user_id=? AND action=? AND request_id=?").bind(user.id, body.action, body.request_id).first();
        if (prior) return json(usageOutput(fresh));
        const batch = await env.DB.batch([
          env.DB.prepare("INSERT OR IGNORE INTO field_lab_usage_receipts (user_id,action,request_id,nonce,created_at) VALUES (?,?,?,?,?)").bind(user.id, body.action, body.request_id, nonce, nowIso()),
          env.DB.prepare(`UPDATE field_lab_users SET ${field}=${field}+1 WHERE id=? AND ${field} < ? AND EXISTS (SELECT 1 FROM field_lab_usage_receipts WHERE user_id=? AND action=? AND request_id=? AND nonce=?)`).bind(user.id, limit, user.id, body.action, body.request_id, nonce)
        ]);
        const changed = batch[1]?.meta?.changes || 0;
        if (!changed) {
          await env.DB.prepare("DELETE FROM field_lab_usage_receipts WHERE user_id=? AND action=? AND request_id=? AND nonce=?").bind(user.id, body.action, body.request_id, nonce).run();
          const check = await env.DB.prepare("SELECT * FROM field_lab_users WHERE id=?").bind(user.id).first();
          if ((body.action === "site" ? check.sites_used : check.questions_used) >= limit) {
            return fail(body.action === "site" ? "انتهت حصة المواقع لهذه الباقة" : "انتهت حصة الاستفسارات لهذه الباقة", 429);
          }
          return json(usageOutput(check));
        }
      } else {
        const result = await env.DB.prepare(`UPDATE field_lab_users SET ${field}=${field}+1 WHERE id=? AND ${field} < ?`).bind(user.id, limit).run();
        if (!result.meta?.changes) return fail(body.action === "site" ? "انتهت حصة المواقع لهذه الباقة" : "انتهت حصة الاستفسارات لهذه الباقة", 429);
      }
      const updated = await env.DB.prepare("SELECT * FROM field_lab_users WHERE id=?").bind(user.id).first();
      return json(usageOutput(updated));
    }
  }
  return fail("المسار غير موجود.", 404);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const apiPaths = ["/health", "/plans", "/auth/", "/me", "/usage/", "/payments/"];
    if (apiPaths.some(prefix => url.pathname === prefix || url.pathname.startsWith(prefix))) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      try { return await api(request, env); }
      catch (_) { return fail("حدث خطأ داخلي. حاول لاحقًا.", 500); }
    }
    return env.ASSETS.fetch(request);
  }
};
