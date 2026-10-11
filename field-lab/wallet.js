/* NAQAA Field Lab internal wallet demo. Local-only test ledger; no real funds or external wallet. */
(function () {
  "use strict";
  var KEY = "naqaa-field-lab-wallet-demo-v1";
  var balanceEl = document.getElementById("wallet-balance");
  var accountEl = document.getElementById("wallet-account");
  var ledgerEl = document.getElementById("wallet-ledger");
  var noticeEl = document.getElementById("wallet-notice");
  if (!balanceEl || !ledgerEl) return;

  function readState() {
    try {
      var parsed = JSON.parse(localStorage.getItem(KEY) || "null");
      if (parsed && typeof parsed.balance === "number" && Array.isArray(parsed.entries)) return parsed;
    } catch (_) {}
    return { balance: 0, entries: [] };
  }
  var state = readState();

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (_) { noticeEl.textContent = "تعذر حفظ محفظة الاختبار على هذا الجهاز."; }
    render();
  }
  function money(value) { return Number(value).toFixed(2) + " EUR"; }
  function render() {
    balanceEl.textContent = money(state.balance);
    ledgerEl.textContent = "";
    if (!state.entries.length) {
      var empty = document.createElement("p");
      empty.className = "helper";
      empty.textContent = "لا توجد حركات حتى الآن.";
      ledgerEl.appendChild(empty);
    } else {
      state.entries.slice().reverse().forEach(function (entry) {
        var row = document.createElement("div");
        row.className = "wallet-ledger-row";
        var detail = document.createElement("div");
        var title = document.createElement("strong");
        title.textContent = entry.title;
        var date = document.createElement("small");
        date.textContent = new Date(entry.at).toLocaleString("ar");
        var amount = document.createElement("span");
        amount.className = "wallet-amount" + (entry.amount < 0 ? " negative" : "");
        amount.textContent = (entry.amount > 0 ? "+" : "") + money(entry.amount);
        detail.appendChild(title);
        detail.appendChild(date);
        row.appendChild(detail);
        row.appendChild(amount);
        ledgerEl.appendChild(row);
      });
    }
    try {
      var profile = JSON.parse(localStorage.getItem("naqaa-field-lab-user") || "null");
      accountEl.textContent = profile && profile.email ? "الحساب: " + profile.email + " (محلي)" : "الحساب: لم يتم التحقق من حساب عبر خادم";
    } catch (_) {
      accountEl.textContent = "الحساب: محلي تجريبي";
    }
  }

  document.getElementById("wallet-add-demo").addEventListener("click", function () {
    state.balance = Math.round((state.balance + 5) * 100) / 100;
    state.entries.push({ title: "حركة إضافة اختبارية — ليست أموالًا حقيقية", amount: 5, at: new Date().toISOString() });
    noticeEl.textContent = "أُضيفت حركة اختبارية محلية فقط؛ لم يتم تحصيل أو تحويل أي أموال.";
    save();
  });
  document.getElementById("wallet-refresh").addEventListener("click", function () {
    state = readState();
    noticeEl.textContent = "تم تحديث ملخص المحفظة المحلية من بيانات هذا الجهاز.";
    render();
  });
  document.getElementById("wallet-reset").addEventListener("click", function () {
    state = { balance: 0, entries: [] };
    save();
    noticeEl.textContent = "أُعيدت محفظة الاختبار إلى الصفر على هذا الجهاز.";
  });
  render();
}());
