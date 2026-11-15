// FocusGuard - Background Service Worker

const DEFAULT_SITES = [
  "reddit.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "instagram.com",
  "facebook.com",
  "tiktok.com"
];

const DEFAULT_COUNTDOWN = 30; // seconds
const DEFAULT_UNLOCK_DURATION = 10; // minutes an unlock lasts

// Initialize storage on install
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(["blockedSites", "countdownSeconds", "unlockMinutes"]);
  if (!data.blockedSites) {
    await chrome.storage.local.set({
      blockedSites: DEFAULT_SITES,
      countdownSeconds: DEFAULT_COUNTDOWN,
      unlockMinutes: DEFAULT_UNLOCK_DURATION,
      unlockSessions: {},   // { "reddit.com": expiryTimestamp }
      enabled: true
    });
  }
});

// Message handler for popup and blocked page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true; // keep channel open for async
});

async function handleMessage(message, sender, sendResponse) {
  const data = await chrome.storage.local.get(null);

  switch (message.type) {

    case "CHECK_BLOCKED": {
      const { hostname } = message;
      const blocked = isBlocked(hostname, data);
      const unlocked = isUnlocked(hostname, data.unlockSessions || {});
      sendResponse({ blocked, unlocked });
      break;
    }

    case "START_UNLOCK": {
      // Called from blocked page after countdown completes
      const { hostname, durationMinutes } = message;
      const sessions = data.unlockSessions || {};
      const expiry = Date.now() + (durationMinutes || data.unlockMinutes || DEFAULT_UNLOCK_DURATION) * 60 * 1000;
      sessions[hostname] = expiry;
      await chrome.storage.local.set({ unlockSessions: sessions });

      // Schedule alarm to clean up
      chrome.alarms.create(`unlock_${hostname}`, { delayInMinutes: durationMinutes || data.unlockMinutes || DEFAULT_UNLOCK_DURATION });

      sendResponse({ success: true });
      break;
    }

    case "GET_SETTINGS": {
      sendResponse({
        blockedSites: data.blockedSites || DEFAULT_SITES,
        countdownSeconds: data.countdownSeconds || DEFAULT_COUNTDOWN,
        unlockMinutes: data.unlockMinutes || DEFAULT_UNLOCK_DURATION,
        unlockSessions: data.unlockSessions || {},
        enabled: data.enabled !== false
      });
      break;
    }

    case "SAVE_SETTINGS": {
      const { blockedSites, countdownSeconds, unlockMinutes } = message;
      // 'enabled' is intentionally NOT settable here — toggling off requires
      // the countdown flow (DISABLE_PROTECTION). Toggling on is immediate.
      await chrome.storage.local.set({ blockedSites, countdownSeconds, unlockMinutes });
      sendResponse({ success: true });
      break;
    }

    case "DISABLE_PROTECTION": {
      await chrome.storage.local.set({ enabled: false });
      sendResponse({ success: true });
      break;
    }

    case "ENABLE_PROTECTION": {
      await chrome.storage.local.set({ enabled: true });
      sendResponse({ success: true });
      break;
    }

    case "REVOKE_UNLOCK": {
      const { hostname } = message;
      const sessions = data.unlockSessions || {};
      delete sessions[hostname];
      await chrome.storage.local.set({ unlockSessions: sessions });
      sendResponse({ success: true });
      break;
    }
  }
}

// Clean up expired unlock sessions on alarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith("unlock_")) {
    const hostname = alarm.name.replace("unlock_", "");
    const data = await chrome.storage.local.get("unlockSessions");
    const sessions = data.unlockSessions || {};
    if (sessions[hostname] && Date.now() >= sessions[hostname]) {
      delete sessions[hostname];
      await chrome.storage.local.set({ unlockSessions: sessions });
    }
  }
});

function isBlocked(hostname, data) {
  if (data.enabled === false) return false;
  const sites = data.blockedSites || [];
  return sites.some(site => {
    const clean = site.replace(/^www\./, "").toLowerCase();
    const host = hostname.replace(/^www\./, "").toLowerCase();
    return host === clean || host.endsWith("." + clean);
  });
}

function isUnlocked(hostname, sessions) {
  const clean = hostname.replace(/^www\./, "").toLowerCase();
  // Check direct match or root domain match
  for (const [site, expiry] of Object.entries(sessions)) {
    const cleanSite = site.replace(/^www\./, "").toLowerCase();
    if ((clean === cleanSite || clean.endsWith("." + cleanSite)) && Date.now() < expiry) {
      return true;
    }
  }
  return false;
}
