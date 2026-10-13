/* Production serves Field Lab and its API on one HTTPS origin.
   Local files and GitHub Pages keep the API unset until an API URL is explicitly configured. */
(function () {
  "use strict";
  var host = String(window.location.hostname || "").toLowerCase();
  var onGitHubPages = host === "github.io" || host.endsWith(".github.io");
  var isSecureWeb = window.location.protocol === "https:";
  var isLocalWebView = host === "localhost" || host === "127.0.0.1";
  window.FIELD_LAB_API_BASE = (!onGitHubPages && !isLocalWebView && isSecureWeb) ? window.location.origin : "";
}());
