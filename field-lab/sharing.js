/* Sharing helpers for NAQAA Field Lab. Shares the current hosted page URL only. */
(function () {
  "use strict";
  function el(id) { return document.getElementById(id); }
  function currentUrl() { return window.location.href; }
  function shareText() { return "مختبر نقاء الميداني — توثيق المواقع والملاحظات والصور: " + currentUrl(); }
  function updateLinks() {
    var url = encodeURIComponent(currentUrl());
    var text = encodeURIComponent("مختبر نقاء الميداني — توثيق المواقع والملاحظات والصور");
    el("whatsapp-share").href = "https://wa.me/?text=" + encodeURIComponent(shareText());
    el("telegram-share").href = "https://t.me/share/url?url=" + url + "&text=" + text;
    el("facebook-share").href = "https://www.facebook.com/sharer/sharer.php?u=" + url;
  }
  function status(message) { el("share-status").textContent = message; }
  function init() {
    updateLinks();
    el("copy-share-link").addEventListener("click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(currentUrl()).then(function () {
          status("تم نسخ رابط الصفحة. تأكد من أنه رابط HTTPS منشور وليس عنوانًا محليًا.");
        }).catch(function () { status("تعذر النسخ تلقائيًا. انسخ عنوان الصفحة من شريط المتصفح."); });
      } else {
        status("انسخ عنوان الصفحة من شريط المتصفح؛ النسخ التلقائي غير متاح هنا.");
      }
    });
    el("native-share-button").addEventListener("click", function () {
      if (navigator.share) {
        navigator.share({ title: "NAQAA Field Lab", text: "مختبر نقاء الميداني", url: currentUrl() })
          .then(function () { status("تم فتح المشاركة عبر التطبيقات المتاحة على جهازك."); })
          .catch(function (error) { if (!error || error.name !== "AbortError") status("تعذرت المشاركة. جرّب نسخ الرابط أو أحد خيارات المشاركة أدناه."); });
      } else {
        status("المشاركة المباشرة غير مدعومة في هذا المتصفح. استخدم أزرار WhatsApp أو Telegram أو Facebook.");
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}());