/* NAQAA Field Lab — direct link to the existing Telegram bot. */
(function () {
  "use strict";
  function addTelegramBotLink() {
    var container = document.querySelector("#share-app .share-buttons");
    if (!container || document.getElementById("telegram-bot-link")) return;
    var link = document.createElement("a");
    link.id = "telegram-bot-link";
    link.className = "button button-primary";
    link.href = "https://t.me/naqaa_field_lab?start=field_lab_app";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "فتح بوت NAQAA Field Lab على Telegram";
    link.setAttribute("aria-label", "فتح بوت NAQAA Field Lab على Telegram");
    container.insertBefore(link, container.firstChild);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addTelegramBotLink, { once: true });
  } else {
    addTelegramBotLink();
  }
})();