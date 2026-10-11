/* Informational plan selector only; no payment or subscription is activated here. */
(function () {
  "use strict";
  var message = document.getElementById("plan-message");
  document.querySelectorAll(".plan-info").forEach(function (button) {
    button.addEventListener("click", function () {
      var plan = button.getAttribute("data-plan") || "الباقة";
      if (message) {
        message.textContent = "اخترت: " + plan + ". هذه معاينة فقط؛ لن يتم تحصيل أي مبلغ أو تفعيل اشتراك. سيُتاح التفعيل بعد إضافة حسابات المستخدمين والخادم الآمن ونظام الدفع والتحقق من الحصص.";
        message.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  });
}());
