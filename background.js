// FocusGuard - Background Service Worker

// The trained weights are optional at install time, but reflection submissions
// are held until they exist so the quality gate cannot be bypassed in the page.
importScripts("model/guard.js");

let guardModelPromise;
function getGuardModel() {
  if (!guardModelPromise) {
    guardModelPromise = self.FocusGuardModel.load(chrome.runtime.getURL("model/"))
      .catch((error) => {
        console.warn("FocusGuard: answer model is not installed. Train it with train_guard.py.", error);
        return null;
      });
  }
  return guardModelPromise;
}

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

// --- Hard blocks (no timer, no unlock) ---------------------------------------
// Removing a hard block requires: 5 written answers, then a 5 minute wait.
const REQUIRED_ANSWERS = 5;
const MIN_ANSWER_WORDS = 20;
const MIN_UNIQUE_WORDS = 8;
const HARD_REMOVAL_WAIT_MS = 5 * 60 * 1000;
const HARD_REMOVAL_EXPIRY_MS = 30 * 60 * 1000; // a finished reflection goes stale after this

// Initialize storage on install
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(["blockedSites", "countdownSeconds", "unlockMinutes", "hardBlockedSites"]);
  if (!data.blockedSites) {
    await chrome.storage.local.set({
      blockedSites: DEFAULT_SITES,
      countdownSeconds: DEFAULT_COUNTDOWN,
      unlockMinutes: DEFAULT_UNLOCK_DURATION,
      unlockSessions: {},   // { "reddit.com": expiryTimestamp }
      enabled: true
    });
  }
  if (!data.hardBlockedSites) {
    await chrome.storage.local.set({ hardBlockedSites: [], removalRequests: {} });
  }
  await syncHardRules();
});

chrome.runtime.onStartup.addListener(() => { syncHardRules(); });

// Messages that change hard blocks may only come from our own extension pages
// (popup / blocked page), never from a content script running inside a website.
const EXTENSION_ONLY = new Set([
  "ADD_HARD_SITE",
  "SUBMIT_REFLECTION",
  "FINISH_HARD_REMOVAL",
  "CANCEL_REMOVAL"
]);

function fromExtensionPage(sender) {
  return typeof sender?.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

// Message handler for popup and blocked page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true; // keep channel open for async
});

async function handleMessage(message, sender, sendResponse) {
  if (EXTENSION_ONLY.has(message.type) && !fromExtensionPage(sender)) {
    sendResponse({ success: false, error: "forbidden" });
    return;
  }

  const data = await chrome.storage.local.get(null);

  switch (message.type) {

    case "CHECK_BLOCKED": {
      const { hostname } = message;

      // Hard blocks win over everything: they ignore the on/off switch and can't be unlocked.
      const hardEntry = matchEntry(hostname, data.hardBlockedSites || []);
      if (hardEntry) {
        sendResponse({ blocked: true, unlocked: false, hard: true, entry: hardEntry });
        break;
      }

      const blocked = isBlocked(hostname, data);
      const unlocked = isUnlocked(hostname, data.unlockSessions || {});
      sendResponse({ blocked, unlocked, hard: false });
      break;
    }

    case "START_UNLOCK": {
      // Called from blocked page after countdown completes
      const { hostname, durationMinutes } = message;

      // Never grant a timed unlock for a hard-blocked site
      if (matchEntry(hostname, data.hardBlockedSites || [])) {
        sendResponse({ success: false, error: "hard_blocked" });
        break;
      }

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
        hardBlockedSites: data.hardBlockedSites || [],
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
      // 'hardBlockedSites' is intentionally NOT settable here either — it can only
      // change through ADD_HARD_SITE / the reflection flow.
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

    // ---- Hard blocks ---------------------------------------------------------

    case "ADD_HARD_SITE": {
      const site = normalizeSite(message.site);
      if (!site) {
        sendResponse({ success: false, error: "invalid_site" });
        break;
      }
      const hard = data.hardBlockedSites || [];
      if (!hard.includes(site)) hard.push(site);

      // A site is either timed or hard, never both: move it out of the timed list
      // and drop any unlock session it has.
      const soft = (data.blockedSites || []).filter(s => normalizeSite(s) !== site);
      const sessions = data.unlockSessions || {};
      delete sessions[site];

      await chrome.storage.local.set({ hardBlockedSites: hard, blockedSites: soft, unlockSessions: sessions });
      await syncHardRules();
      sendResponse({ success: true, hardBlockedSites: hard });
      break;
    }

    case "SUBMIT_REFLECTION": {
      // Step 1 of removal: the five written answers. Starts the 5 minute clock.
      const { entry, answers } = message;
      if (!(data.hardBlockedSites || []).includes(entry)) {
        sendResponse({ success: false, error: "not_hard_blocked" });
        break;
      }
      const problem = validateAnswers(answers);
      if (problem) {
        sendResponse({ success: false, error: problem });
        break;
      }
      const model = await getGuardModel();
      if (!model) {
        sendResponse({ success: false, error: "model_unavailable" });
        break;
      }
      const answerScores = answers.map((answer) => model.evaluate(answer).pReal);
      const rejected = answerScores.flatMap((score, index) => score < model.threshold ? [index] : []);
      if (rejected.length) {
        sendResponse({ success: false, error: "model_rejected", rejected, scores: answerScores });
        break;
      }
      const requests = data.removalRequests || {};
      requests[entry] = { reflectedAt: Date.now() }; // submitting again restarts the clock
      await chrome.storage.local.set({ removalRequests: requests });
      sendResponse({ success: true, waitMs: HARD_REMOVAL_WAIT_MS, scores: answerScores });
      break;
    }

    case "FINISH_HARD_REMOVAL": {
      // Step 2 of removal: only works once the full wait has passed on the wall clock.
      const { entry } = message;
      const requests = data.removalRequests || {};
      const req = requests[entry];
      if (!req) {
        sendResponse({ success: false, error: "no_reflection" });
        break;
      }
      const elapsed = Date.now() - req.reflectedAt;
      if (elapsed < HARD_REMOVAL_WAIT_MS) {
        sendResponse({ success: false, error: "too_early", remainingMs: HARD_REMOVAL_WAIT_MS - elapsed });
        break;
      }
      if (elapsed > HARD_REMOVAL_EXPIRY_MS) {
        delete requests[entry];
        await chrome.storage.local.set({ removalRequests: requests });
        sendResponse({ success: false, error: "expired" });
        break;
      }
      const hard = (data.hardBlockedSites || []).filter(s => s !== entry);
      delete requests[entry];
      await chrome.storage.local.set({ hardBlockedSites: hard, removalRequests: requests });
      await syncHardRules();
      sendResponse({ success: true, hardBlockedSites: hard });
      break;
    }

    case "CANCEL_REMOVAL": {
      const requests = data.removalRequests || {};
      delete requests[message.entry];
      await chrome.storage.local.set({ removalRequests: requests });
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

// Returns the list entry that covers `hostname` (exact match or subdomain), or null.
function matchEntry(hostname, list) {
  const host = hostname.replace(/^www\./, "").toLowerCase();
  for (const site of list) {
    const clean = site.replace(/^www\./, "").toLowerCase();
    if (host === clean || host.endsWith("." + clean)) return site;
  }
  return null;
}

function isBlocked(hostname, data) {
  if (data.enabled === false) return false;
  return matchEntry(hostname, data.blockedSites || []) !== null;
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

function normalizeSite(raw) {
  if (typeof raw !== "string") return null;
  const val = raw.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[\/?#].*$/, "")
    .replace(/^www\./, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(val) ? val : null;
}

function countWords(s) {
  return s.trim().split(/\s+/).filter(Boolean);
}

// Returns an error string, or null if the answers are acceptable.
function validateAnswers(answers) {
  if (!Array.isArray(answers) || answers.length !== REQUIRED_ANSWERS) return "need_five_answers";
  const seen = new Set();
  for (const a of answers) {
    if (typeof a !== "string") return "bad_answer";
    const words = countWords(a);
    if (words.length < MIN_ANSWER_WORDS) return "answer_too_short";
    if (new Set(words.map(w => w.toLowerCase())).size < MIN_UNIQUE_WORDS) return "answer_repetitive";
    const key = a.trim().toLowerCase();
    if (seen.has(key)) return "duplicate_answers";
    seen.add(key);
  }
  return null;
}

// Mirror hard blocks as declarativeNetRequest rules so the browser redirects the
// navigation itself, before the page loads. The content script stays as a fallback.
async function syncHardRules() {
  try {
    const { hardBlockedSites = [] } = await chrome.storage.local.get("hardBlockedSites");
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const addRules = hardBlockedSites.map((site, i) => ({
      id: i + 1,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          extensionPath: `/pages/blocked.html?mode=hard&host=${encodeURIComponent(site)}&entry=${encodeURIComponent(site)}`
        }
      },
      condition: { requestDomains: [site], resourceTypes: ["main_frame"] }
    }));
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map(r => r.id),
      addRules
    });
  } catch (e) {
    console.warn("FocusGuard: could not sync hard-block rules", e);
  }
}
