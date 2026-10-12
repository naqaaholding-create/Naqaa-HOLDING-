/* NAQAA Field Lab payment readiness UI. Never simulates money or claims a payment succeeded. */
(function () {
  "use strict";
  var base = String(window.FIELD_LAB_API_BASE || "").trim().replace(/\/$/, "");
  var balanceEl = document.getElementById("wallet-balance");
  var accountEl = document.getElementById("wallet-account");
  var ledgerEl = document.getElementById("wallet-ledger");
  var noticeEl = document.getElementById("wallet-notice");
  var statusEl = document.getElementById("wallet-status-label");
  if (!balanceEl || !ledgerEl || !noticeEl) return;

  function message(text) { noticeEl.textContent = text; }
  function showUnconfigured() {
    statusEl.textContent = "بانتظار الإعداد";
    accountEl.textContent = "لم يتم نشر الخادم المالي أو ضبط عنوان الاستقبال";
    balanceEl.textContent = "غير متاح";
    ledgerEl.textContent = "";
    var p = document.createElement("p");
    p.className = "helper";
    p.textContent = "سيظهر هنا سجل المعاملات بعد ربط خادم آمن والتحقق من المعاملات على شبكة TRON.";
    ledgerEl.appendChild(p);
  }
  function readStatus() {
    if (!base) {
      showUnconfigured();
      message("زر الفحص يعمل: عنوان الخادم غير مضبوط في api-config.js. لم تُرسل أي بيانات مالية.");
      return Promise.resolve(false);
    }
    return fetch(base + "/payments/status", { headers: { "Accept": "application/json" } })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) throw new Error(data.detail || "تعذر قراءة حالة الدفع.");
          statusEl.textContent = data.payments_enabled ? "جاهز للدفع" : "غير مفعّل";
          accountEl.textContent = data.receive_address_configured ? "عنوان استقبال موجود — التحقق المالي غير مكتمل" : "عنوان استقبال SafePal غير مضبوط";
          balanceEl.textContent = "غير متاح";
          ledgerEl.textContent = "";
          var p = document.createElement("p");
          p.className = "helper";
          p.textContent = data.note || "لم يتم تفعيل أي معاملة مالية.";
          ledgerEl.appendChild(p);
          message("تم فحص الخادم. لا تعتبر أي دفعة ناجحة إلا بعد التحقق على الشبكة وتأكيدها من الخادم.");
          return Boolean(data.payments_enabled);
        });
      })
      .catch(function () {
        showUnconfigured();
        message("تعذر الاتصال بنقطة حالة المدفوعات. لم يتم إنشاء معاملة أو تغيير أي رصيد.");
        return false;
      });
  }

  document.getElementById("wallet-deposit-request").addEventListener("click", function () {
    if (!base) {
      message("الإيداع الحقيقي لم يُفعّل: يجب نشر API عبر HTTPS وضبط عنوان استقبال SafePal العام لشبكة TRON (TRC20) والتحقق من المعاملات على الخادم أولًا.");
      return;
    }
    readStatus().then(function (enabled) {
      if (!enabled) message("الإيداع غير متاح بعد. لا ترسل USDT الآن؛ يحتاج النظام إلى عنوان استقبال موثّق والتحقق الآلي أو مراجعة إدارية آمنة للمعاملة.");
      else message("الخادم يعلن أن الدفع متاح. اتبع تعليمات الإيداع التي يعرضها الخادم، وتأكد من الشبكة والمبلغ قبل الإرسال.");
    });
  });

  document.getElementById("wallet-withdraw-request").addEventListener("click", function () {
    message("السحب الحقيقي غير مفعّل بعد. يلزم رصيد مؤكد في سجل مالي على الخادم، وتسجيل طلب السحب، ومراجعة إدارية، وتنفيذ آمن دون وضع المفتاح الخاص لمحفظة SafePal داخل التطبيق.");
  });

  document.getElementById("wallet-refresh").addEventListener("click", function () {
    readStatus();
  });

  showUnconfigured();
}());
