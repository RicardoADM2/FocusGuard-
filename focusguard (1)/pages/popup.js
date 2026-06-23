// FocusGuard — Popup (read-only status)

const enableToggle = document.getElementById("enableToggle");
const siteCount    = document.getElementById("siteCount");
const unlocksSection = document.getElementById("unlocksSection");
const unlockList   = document.getElementById("unlockList");
const manageBtn    = document.getElementById("manageBtn");

// ── Load status ──────────────────────────────────────────────
chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (data) => {
  const enabled = data.enabled !== false;
  enableToggle.checked = enabled;

  siteCount.textContent = (data.blockedSites || []).length;

  // Show active unlock sessions
  const sessions = data.unlockSessions || {};
  const now = Date.now();
  const active = Object.entries(sessions).filter(([, expiry]) => expiry > now);

  if (active.length > 0) {
    unlocksSection.classList.add("visible");
    unlockList.innerHTML = active.map(([site, expiry]) => {
      const minsLeft = Math.ceil((expiry - now) / 60000);
      return `
        <div class="unlock-item">
          <span class="unlock-site">${site}</span>
          <span class="unlock-timer">${minsLeft}m left</span>
        </div>`;
    }).join("");
  }
});

// ── Enable / disable toggle ───────────────────────────────────
enableToggle.addEventListener("change", (e) => {
  if (e.target.checked) {
    // Turning on is immediate
    chrome.runtime.sendMessage({ type: "ENABLE_PROTECTION" });
  } else {
    // Turning off requires the countdown flow — revert toggle and open gate
    e.target.checked = true;
    const url = chrome.runtime.getURL("pages/blocked.html") + "?mode=disable";
    chrome.tabs.create({ url });
    window.close();
  }
});

// ── Manage button — opens settings tab via background ─────────
manageBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "OPEN_SETTINGS" });
  window.close();
});
