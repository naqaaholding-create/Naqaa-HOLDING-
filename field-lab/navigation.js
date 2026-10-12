/* Accessible page switching for the single-document mobile app. */
(function () {
  "use strict";
  function initPageNavigation() {
    var main = document.querySelector("main.container");
    if (!main || main.dataset.pageNavigationReady === "true") return;
    main.dataset.pageNavigationReady = "true";

    var pages = [
      { id: "home", title: "الرئيسية", icon: "⌂", selectors: [".intro", ".notice", ".roadmap", "footer"] },
      { id: "field", title: "العمل الميداني", icon: "⌖", selectors: [".grid-layout"] },
      { id: "account", title: "الحساب", icon: "♙", selectors: ["#account"] },
      { id: "wallet", title: "المحفظة", icon: "◈", selectors: ["#internal-wallet"] },
      { id: "plans", title: "الباقات", icon: "▤", selectors: ["#subscriptions"] },
      { id: "share", title: "المشاركة", icon: "↗", selectors: ["#share-app"] }
    ];
    pages.forEach(function (page) {
      page.nodes = page.selectors.map(function (selector) { return main.querySelector(selector); }).filter(Boolean);
      page.nodes.forEach(function (node) { node.classList.add("app-page"); });
    });

    var nav = document.createElement("nav");
    nav.className = "app-navigation";
    nav.setAttribute("aria-label", "التنقل بين صفحات مختبر نقاء");
    var heading = document.createElement("p");
    heading.className = "nav-title";
    heading.textContent = "صفحات التطبيق";
    nav.appendChild(heading);
    var items = document.createElement("div");
    items.className = "nav-items";
    nav.appendChild(items);
    var status = document.createElement("p");
    status.className = "page-status";
    status.setAttribute("aria-live", "polite");
    status.textContent = "الصفحة الحالية: الرئيسية";
    nav.appendChild(status);

    function showPage(id) {
      var active = pages.find(function (page) { return page.id === id; }) || pages[0];
      pages.forEach(function (page) {
        var isActive = page.id === active.id;
        page.nodes.forEach(function (node) { node.hidden = !isActive; });
        var button = items.querySelector('[data-page="' + page.id + '"]');
        if (button) {
          if (isActive) button.setAttribute("aria-current", "page");
          else button.removeAttribute("aria-current");
        }
      });
      status.textContent = "الصفحة الحالية: " + active.title;
      try { window.history.replaceState(null, "", "#" + active.id); } catch (_) {}
      window.scrollTo(0, 0);
      if (active.id === "field" && window.dispatchEvent) {
        window.setTimeout(function () {
          window.dispatchEvent(new Event("resize"));
        }, 80);
      }
    }

    pages.forEach(function (page) {
      var button = document.createElement("button");
      button.type = "button";
      button.dataset.page = page.id;
      button.textContent = page.icon + " " + page.title;
      button.addEventListener("click", function () { showPage(page.id); });
      items.appendChild(button);
    });

    var intro = main.querySelector(".intro");
    if (intro && intro.nextSibling) main.insertBefore(nav, intro.nextSibling);
    else main.insertBefore(nav, main.firstChild);

    var initial = (window.location.hash || "").slice(1);
    showPage(pages.some(function (page) { return page.id === initial; }) ? initial : "home");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initPageNavigation);
  else initPageNavigation();
}());
