/* Account UI for the Field Lab API. Set FIELD_LAB_API_BASE in api-config.js before use. */
(function () {
  "use strict";
  var base = String(window.FIELD_LAB_API_BASE || "").trim().replace(/\/$/, "");
  var token = "";
  try { token = window.sessionStorage.getItem("naqaa_field_lab_session") || ""; } catch (_) {}
  window.FIELD_LAB_AUTH_TOKEN = token;
  function saveToken(value) {
    token = value || "";
    window.FIELD_LAB_AUTH_TOKEN = token;
    try {
      if (token) window.sessionStorage.setItem("naqaa_field_lab_session", token);
      else window.sessionStorage.removeItem("naqaa_field_lab_session");
    } catch (_) {}
  }
  var statusBox = document.getElementById("account-status");
  var usagePanel = document.getElementById("usage-panel");
  function showMessage(message, isError) {
    if (!statusBox) return;
    statusBox.textContent = message;
    statusBox.classList.toggle("account-error", Boolean(isError));
  }
  function api(path, options) {
    if (!base) throw new Error("لم يتم ضبط عنوان الخادم بعد. يجب نشر API ثم وضع عنوانه في api-config.js.");
    options = options || {};
    options.headers = Object.assign({"Content-Type":"application/json"}, options.headers || {});
    if (token) options.headers.Authorization = "Bearer " + token;
    return fetch(base + path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.detail || "تعذر تنفيذ الطلب");
        return data;
      });
    });
  }
  function loadUsage() {
    return api("/me/usage").then(function (data) {
      document.getElementById("usage-plan").textContent = data.plan_label + " — " + data.price_usd + " دولار (عرض معلوماتي؛ الدفع غير مفعّل)";
      document.getElementById("sites-usage").textContent = data.sites_used + " / " + data.sites_limit;
      document.getElementById("questions-usage").textContent = data.questions_used + " / " + data.questions_limit;
      usagePanel.hidden = false;
      showMessage("تم تسجيل الدخول بنجاح. هذه الحصة محسوبة من الخادم.");
    });
  }
  function auth(formId, path) {
    var form = document.getElementById(formId);
    if (!form) return;
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var fields = new FormData(form);
      showMessage("جارٍ الاتصال بالخادم…");
      api(path, {method:"POST", body:JSON.stringify({email:fields.get("email"), password:fields.get("password")})})
        .then(function (data) {
          saveToken(data.access_token);
          return loadUsage().then(function () {
            if (typeof window.FIELD_LAB_SYNC_RECORDS !== "function") return;
            return window.FIELD_LAB_SYNC_RECORDS().then(function (result) {
              if (result && !result.skipped) showMessage("تم تسجيل الدخول ومزامنة السجلات مع الخادم.");
            }).catch(function () {
              showMessage("تم تسجيل الدخول. تعذرت المزامنة الآن؛ ستبقى السجلات المحلية محفوظة.");
            });
          });
        })
        .catch(function (error) { showMessage(error.message, true); });
    });
  }
  window.FIELD_LAB_REFRESH_USAGE = function () { return loadUsage(); };
  auth("register-form", "/auth/register");
  auth("login-form", "/auth/login");
  var refresh = document.getElementById("refresh-usage");
  if (refresh) refresh.addEventListener("click", function () { loadUsage().catch(function (error) { showMessage(error.message, true); }); });
  var logout = document.getElementById("logout-button");
  if (logout) logout.addEventListener("click", function () {
    saveToken("");
    usagePanel.hidden = true;
    document.getElementById("login-password").value = "";
    showMessage("تم تسجيل الخروج من هذه الجلسة.");
  });
  if (base) showMessage("عنوان الخادم مضبوط. استخدم حسابًا تجريبيًا ولا تدخل بيانات حساسة حتى تكتمل مراجعة النشر.");
}());
