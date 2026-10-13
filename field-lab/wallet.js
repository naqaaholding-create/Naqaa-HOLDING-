/* Verified USDT-TRC20 subscription checkout. Never simulates money. */
(function () {
  "use strict";
  var base = String(window.FIELD_LAB_API_BASE || "").trim().replace(/\/$/, "");
  var balanceEl = document.getElementById("wallet-balance");
  var accountEl = document.getElementById("wallet-account");
  var ledgerEl = document.getElementById("wallet-ledger");
  var noticeEl = document.getElementById("wallet-notice");
  var statusEl = document.getElementById("wallet-status-label");
  var intentId = "";
  var receivingAddress = "";
  var instructions = document.getElementById("payment-instructions");
  if (!balanceEl || !accountEl || !ledgerEl || !noticeEl || !statusEl) return;

  function message(value) { noticeEl.textContent = value; }
  function authHeaders() {
    var token = String(window.FIELD_LAB_AUTH_TOKEN || "");
    if (!token) throw new Error("سجّل الدخول أولًا قبل شراء باقة.");
    return { "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json" };
  }
  function request(path, options) {
    if (!base) return Promise.reject(new Error("عنوان الخادم غير مضبوط. لا ترسل أي مبلغ."));
    options = options || {};
    options.headers = Object.assign({ "Accept": "application/json" }, options.headers || {});
    return fetch(base + path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.detail || "تعذر إكمال الطلب.");
        return data;
      });
    });
  }
  function initialState() {
    balanceEl.textContent = "غير مؤكدة";
    statusEl.textContent = "غير جاهز";
    accountEl.textContent = base ? "فحص إعدادات الدفع" : "عنوان الخادم غير مضبوط";
  }
  function refreshStatus() {
    return request("/payments/status").then(function (data) {
      window.FIELD_LAB_PAYMENTS_ENABLED = data.payments_enabled === true;
      statusEl.textContent = data.payments_enabled ? "الدفع متاح" : "الدفع مغلق";
      accountEl.textContent = data.payments_enabled ? "USDT على TRON (TRC20)" : "إعدادات الإنتاج غير مكتملة";
      message(data.note || (data.payments_enabled
        ? "الخادم جاهز. أنشئ طلب الدفع قبل التحويل."
        : "الدفع مغلق. لا ترسل أي مبلغ."));
      return Boolean(data.payments_enabled);
    }).catch(function () {
      window.FIELD_LAB_PAYMENTS_ENABLED = false;
      initialState();
      message("تعذر الاتصال بالخادم. لم يتم إنشاء أي طلب دفع.");
      return false;
    });
  }
  function showInvoice(data) {
    intentId = data.intent_id;
    receivingAddress = data.receive_address;
    if (data.payer_address) document.getElementById("payment-payer-address").value = data.payer_address;
    document.getElementById("payment-amount").textContent = data.amount_usdt + " USDT";
    document.getElementById("payment-receiving-address").value = receivingAddress;
    document.getElementById("payment-expiry").textContent =
      "تنتهي صلاحية الطلب: " + new Date(data.expires_at).toLocaleString() +
      ". يلزم 20 تأكيدًا على الأقل على شبكة TRON.";
    instructions.hidden = false;
    message("أنشأ الخادم طلب الدفع. تحقق بنفسك من العنوان والمبلغ والشبكة قبل الإرسال.");
    instructions.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function createInvoice() {
    var headers;
    try { headers = authHeaders(); } catch (error) { message(error.message); return; }
    var payerAddress = document.getElementById("payment-payer-address").value.trim();
    if (payerAddress.length < 30 || payerAddress.length > 40) {
      message("أدخل عنوان محفظتك الشخصية الصحيح على شبكة TRON قبل إنشاء الطلب.");
      return;
    }
    if (!window.FIELD_LAB_PAYMENTS_ENABLED) {
      refreshStatus().then(function (ready) {
        if (ready) createInvoice();
        else message("الدفع الحقيقي غير متاح بعد؛ لم يُنشأ طلب ولم يُخصم أي مبلغ.");
      });
      return;
    }
    message("جارٍ إنشاء طلب الدفع على الخادم…");
    request("/payments/intents", {
      method: "POST", headers: headers,
      body: JSON.stringify({
        plan_code: document.getElementById("payment-plan").value,
        payer_address: payerAddress
      })
    }).then(showInvoice).catch(function (error) { message(error.message); });
  }
  function verifyInvoice() {
    var txid = document.getElementById("payment-txid").value.trim();
    if (!intentId) { message("أنشئ طلب دفع قبل التحقق."); return; }
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      message("أدخل معرّف معاملة TRON الصحيح المكوّن من 64 خانة.");
      return;
    }
    var headers;
    try { headers = authHeaders(); } catch (error) { message(error.message); return; }
    message("التحقق من المبلغ والعنوان وعقد USDT والتأكيدات على الشبكة…");
    request("/payments/verify", {
      method: "POST", headers: headers,
      body: JSON.stringify({ intent_id: intentId, txid: txid })
    }).then(function (data) {
      if (data.status !== "confirmed") throw new Error("لم يصل تأكيد صحيح من الخادم.");
      balanceEl.textContent = "الاشتراك مؤكد";
      statusEl.textContent = "تم التفعيل";
      accountEl.textContent = data.plan_label || data.plan;
      message(data.already_processed
        ? "هذه المعاملة مؤكدة مسبقًا ولم تُحتسب مرة ثانية."
        : "تحقق الخادم من المعاملة وفعّل الاشتراك. التأكيدات: " + data.confirmations + ".");
      try {
        if (window.FIELD_LAB_REFRESH_USAGE) Promise.resolve(window.FIELD_LAB_REFRESH_USAGE()).catch(function () {});
      } catch (_) {}
      document.getElementById("payment-txid").value = "";
      loadHistory();
    }).catch(function (error) {
      message(error.message + " لم يُفعّل الاشتراك.");
    });
  }
  function loadHistory() {
    var headers;
    try { headers = authHeaders(); } catch (error) { message(error.message); return; }
    request("/payments/history", { headers: headers }).then(function (data) {
      ledgerEl.textContent = "";
      if (!data.transactions || !data.transactions.length) {
        var empty = document.createElement("p");
        empty.className = "helper";
        empty.textContent = "لا توجد طلبات دفع سابقة لهذا الحساب.";
        ledgerEl.appendChild(empty);
        return;
      }
      data.transactions.forEach(function (item) {
        var row = document.createElement("div");
        row.className = "wallet-ledger-row";
        var info = document.createElement("div");
        var title = document.createElement("strong");
        title.textContent = item.plan_label + " — " + item.amount_usdt + " USDT";
        var detail = document.createElement("small");
        detail.textContent = item.status === "paid" ? "مدفوع ومؤكد على الشبكة" :
          item.status === "expired" ? "انتهت صلاحية الطلب" : "بانتظار التحقق من المعاملة";
        info.appendChild(title);
        info.appendChild(detail);
        row.appendChild(info);
        var tag = document.createElement("span");
        tag.className = "wallet-amount";
        tag.textContent = item.status === "paid" ? "مؤكد" : item.status === "expired" ? "منتهي" : "معلّق";
        row.appendChild(tag);
        if (item.status === "pending") {
          var resume = document.createElement("button");
          resume.type = "button";
          resume.className = "button button-secondary button-small";
          resume.textContent = "استكمال الدفع";
          resume.addEventListener("click", function () {
            document.getElementById("payment-plan").value = item.plan_code;
            document.getElementById("payment-payer-address").value = item.payer_address || "";
            request("/payments/intents", {
              method: "POST", headers: headers,
              body: JSON.stringify({ plan_code: item.plan_code, payer_address: item.payer_address })
            }).then(showInvoice).catch(function (error) { message(error.message); });
          });
          row.appendChild(resume);
        }
        ledgerEl.appendChild(row);
      });
    }).catch(function (error) { message(error.message); });
  }

  document.getElementById("wallet-deposit-request").addEventListener("click", createInvoice);
  document.getElementById("wallet-verify-payment").addEventListener("click", verifyInvoice);
  document.getElementById("wallet-copy-address").addEventListener("click", function () {
    if (!receivingAddress) { message("أنشئ طلب دفع أولًا حتى يظهر العنوان من الخادم."); return; }
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      message("تعذر النسخ التلقائي. حدّد عنوان الاستقبال وانسخه يدويًا.");
      return;
    }
    navigator.clipboard.writeText(receivingAddress).then(function () {
      message("نُسخ العنوان. تأكد من USDT على شبكة TRON (TRC20) والمبلغ المحدد.");
    }).catch(function () { message("تعذر النسخ. انسخ العنوان يدويًا."); });
  });
  document.getElementById("wallet-refresh").addEventListener("click", refreshStatus);
  document.getElementById("wallet-history").addEventListener("click", loadHistory);
  initialState();
  refreshStatus();
}());
