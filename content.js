// FocusGuard - Content Script
// Runs at document_start on every page to intercept blocked sites

(async () => {
  const hostname = window.location.hostname;

  // Don't intercept our own pages or browser-internal pages
  if (
    window.location.protocol === "chrome-extension:" ||
    window.location.protocol === "chrome:" ||
    window.location.protocol === "about:"
  ) return;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "CHECK_BLOCKED",
      hostname
    });

    // Hard blocks are never "unlocked"; timed blocks are skipped while an unlock is active.
    if (response && response.blocked && (response.hard || !response.unlocked)) {
      // Freeze the page immediately
      document.documentElement.style.visibility = "hidden";

      const blockedPage = chrome.runtime.getURL("pages/blocked.html");
      const host = encodeURIComponent(hostname);

      if (response.hard) {
        const entry = encodeURIComponent(response.entry);
        window.location.replace(`${blockedPage}?mode=hard&host=${host}&entry=${entry}`);
      } else {
        // Redirect to blocked page, encoding the original URL
        const target = encodeURIComponent(window.location.href);
        window.location.replace(`${blockedPage}?url=${target}&host=${host}`);
      }
    }
  } catch (e) {
    // Extension context invalidated or other error — fail silently
  }
})();
