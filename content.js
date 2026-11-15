// FocusGuard - Content Script
// Runs at document_start on every page to intercept blocked sites

(async () => {
  const hostname = window.location.hostname;

  // Don't intercept our own blocked page or chrome:// pages
  if (
    window.location.href.includes("blocked.html") ||
    window.location.protocol === "chrome-extension:" ||
    window.location.protocol === "chrome:" ||
    window.location.protocol === "about:"
  ) return;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "CHECK_BLOCKED",
      hostname
    });

    if (response && response.blocked && !response.unlocked) {
      // Freeze the page immediately
      document.documentElement.style.visibility = "hidden";

      // Redirect to blocked page, encoding the original URL
      const blockedPage = chrome.runtime.getURL("pages/blocked.html");
      const target = encodeURIComponent(window.location.href);
      const host = encodeURIComponent(hostname);
      window.location.replace(`${blockedPage}?url=${target}&host=${host}`);
    }
  } catch (e) {
    // Extension context invalidated or other error — fail silently
  }
})();
