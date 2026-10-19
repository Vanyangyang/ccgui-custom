/**
 * Boot watchdog — the first of the app's three crash-defence layers.
 *
 * Runs as a classic script from index.html BEFORE the module bundle, so it
 * still executes when the bundle fails to load or throws before React mounts.
 * If the app hasn't marked itself mounted within BOOT_TIMEOUT_MS, it replaces
 * the splash with a failure panel that names the reason (read from the same
 * `ccgui:last-crash` record src/lib/crash.ts writes) and offers a reload.
 *
 * Kept as a standalone file (not inline) because the packaged CSP is
 * `script-src 'self'` with no 'unsafe-inline'.
 */
(function () {
  var BOOT_TIMEOUT_MS = 8000;
  var LAST_CRASH_KEY = "ccgui:last-crash";

  function lastCrashReason() {
    try {
      // The watchdog precedes the module that partitions all storage globals.
      // Read only the development crash key; never fall back to stable data.
      var key = LAST_CRASH_KEY;
      var pathname = location.pathname;
      if (pathname === "/.ccgui-dev" || pathname.indexOf("/.ccgui-dev/") === 0) {
        var profile = /^\/(\.ccgui-dev\/dev-[a-f0-9]{64})(?:\/|$)/.exec(pathname);
        if (!profile) return "";
        key = "ccgui-profile:/" + profile[1] + ":" + key;
        // After module evaluation localStorage already applies the prefix.
        if (window.__ccguiStorageProfile === "/" + profile[1]) key = LAST_CRASH_KEY;
      }
      var raw = localStorage.getItem(key);
      if (!raw) return "";
      var report = JSON.parse(raw);
      if (!report || !report.message) return "";
      return (report.source ? "[" + report.source + "] " : "") + report.message;
    } catch (error) {
      return "";
    }
  }

  function showBootFailure(reason) {
    var root = document.getElementById("root");
    if (!root || document.documentElement.dataset.appMounted === "1") return;

    var panel = document.createElement("div");
    panel.className = "boot-failure";

    var title = document.createElement("h1");
    title.textContent = "CC GUI 启动失败 / Failed to start";
    panel.appendChild(title);

    if (reason) {
      var reasonEl = document.createElement("p");
      reasonEl.className = "boot-failure-reason";
      reasonEl.textContent = reason;
      panel.appendChild(reasonEl);
    }

    var hint = document.createElement("p");
    hint.className = "boot-failure-hint";
    hint.textContent = "可以重新加载应用再试一次。/ Reload the app to try again.";
    panel.appendChild(hint);

    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "重新加载 / Reload";
    button.addEventListener("click", function () {
      location.reload();
    });
    panel.appendChild(button);

    root.textContent = "";
    root.appendChild(panel);
  }

  window.__ccguiShowBootFailure = showBootFailure;

  // Catch errors thrown before the module bundle (or the React boundary) is
  // up; defer one tick so a crash handler that reports synchronously wins.
  window.addEventListener("error", function (event) {
    if (!event.error && !event.message) return;
    window.setTimeout(function () {
      if (document.documentElement.dataset.appMounted !== "1") {
        showBootFailure(event.message || lastCrashReason());
      }
    }, 0);
  });

  window.setTimeout(function () {
    if (document.documentElement.dataset.appMounted === "1") return;
    showBootFailure(lastCrashReason());
  }, BOOT_TIMEOUT_MS);
})();
