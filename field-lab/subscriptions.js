/* Subscription cards route to the real checkout panel; they do not claim payment success. */
(function () {
  "use strict";
  var message = document.getElementById("plan-message");
  var codeByLabel = {
    "الاشتراك اليومي": "daily",
    "الاشتراك الأسبوعي": "weekly",
    "الاشتراك الشهري": "monthly"
  };
  document.querySelectorAll(".plan-info").forEach(function (button) {
    button.addEventListener("click", function () {
      var label = button.getAttribute("data-plan") || "الباقة";
      var code = codeByLabel[label];
      if (code) {
        var select = document.getElementById("payment-plan");
        if (select) select.value = code;
        var panel = document.getElementById("internal-wallet");
        if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
        if (message) message.textContent = "تم اختيار " + label + ". سجّل الدخول ثم أنشئ طلب الدفع في قسم الدفع والاشتراكات.";
      } else if (message) {
        message.textContent = "التجربة المجانية لا تحتاج إلى دفع. أنشئ حسابًا في قسم الحساب.";
      }
    });
  });
}());
