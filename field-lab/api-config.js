/* Production uses the same HTTPS origin; Android can receive an explicit API URL at build time. */
(function () {
  "use strict";
  var configured = String(window.FIELD_LAB_API_BASE_OVERRIDE || "").trim().replace(/\/+$/, "");
  var host = String(window.location.hostname || "").toLowerCase();
  var onGitHubPages = host === "github.io" || host.endsWith(".github.io");
  var isSecureWeb = window.location.protocol === "https:";
  var isLocalWebView = host === "localhost" || host === "127.0.0.1";
  window.FIELD_LAB_API_BASE = configured || ((!onGitHubPages && !isLocalWebView && isSecureWeb) ? window.location.origin : "");
}());
