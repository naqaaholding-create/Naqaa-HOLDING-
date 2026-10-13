/* Account UI for the Field Lab API. Set FIELD_LAB_API_BASE in api-config.js before use. */
(function () {
  "use strict";
  var base = String(window.FIELD_LAB_API_BASE || "").trim().replace(/\/$/, "");
  var token = "";
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
      document.getElementById("usage-plan").textContent = data.plan_label + " — " + data.price_usd + " دولار";
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
          token = data.access_token;
          return loadUsage();
        })
        .catch(function (error) { showMessage(error.message, true); });
    });
  }
  auth("register-form", "/auth/register");
  auth("login-form", "/auth/login");
  var refresh = document.getElementById("refresh-usage");
  if (refresh) refresh.addEventListener("click", function () { loadUsage().catch(function (error) { showMessage(error.message, true); }); });
  var logout = document.getElementById("logout-button");
  if (logout) logout.addEventListener("click", function () {
    token = "";
    usagePanel.hidden = true;
    document.getElementById("login-password").value = "";
    showMessage("تم تسجيل الخروج من هذه الجلسة.");
  });

  function startPayment(plan) {
    if (!token) { showMessage("سجّل الدخول أولًا قبل إنشاء طلب الدفع.", true); return; }
    showMessage("جارٍ إنشاء طلب الدفع…");
    api("/payments/create", {method:"POST", body:JSON.stringify({plan:plan})}).then(function (data) {
      var box = document.getElementById("payment-panel");
      var details = document.getElementById("payment-details");
      var idField = document.getElementById("payment-id");
      if (box && details && idField) {
        idField.value = data.payment_id;
        details.textContent = "حوّل " + data.amount + " USDT عبر شبكة TRON (TRC20) إلى " + data.receive_address + " ثم أدخل معرّف المعاملة أدناه. لا ترسل مبلغًا مختلفًا.";
        box.hidden = false;
        box.scrollIntoView({behavior:"smooth", block:"center"});
      }
      showMessage("تم إنشاء طلب دفع. الاشتراك لن يتفعّل إلا بعد تأكيد التحويل على الشبكة.");
    }).catch(function (error) { showMessage(error.message, true); });
  }
  document.querySelectorAll(".plan-buy").forEach(function (button) {
    button.addEventListener("click", function () { startPayment(button.getAttribute("data-plan-code")); });
  });
  var confirmForm = document.getElementById("payment-confirm-form");
  if (confirmForm) confirmForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!token) { showMessage("سجّل الدخول أولًا.", true); return; }
    var paymentId = Number(document.getElementById("payment-id").value);
    var txid = String(document.getElementById("payment-txid").value || "").trim();
    showMessage("جارٍ التحقق من معاملة TRON المؤكدة…");
    api("/payments/confirm", {method:"POST", body:JSON.stringify({payment_id:paymentId, txid:txid})})
      .then(function (data) {
        showMessage("تم تأكيد الدفع وتفعيل باقة " + data.plan + " بنجاح.");
        document.getElementById("payment-panel").hidden = true;
        confirmForm.reset();
        return loadUsage();
      }).catch(function (error) { showMessage(error.message, true); });
  });
  if (base) showMessage("عنوان الخادم مضبوط. استخدم حسابًا تجريبيًا ولا تدخل بيانات حساسة حتى تكتمل مراجعة النشر.");
}());
