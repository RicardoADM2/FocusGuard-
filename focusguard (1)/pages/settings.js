// FocusGuard — Settings Page

// ═══════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════
let sites = [];
let unlockSessions = {};
let totalGateSeconds = 30;

// ═══════════════════════════════════════════════════════════
// Gate countdown (page-entry protection)
// ═══════════════════════════════════════════════════════════
const gate         = document.getElementById("gate");
const gateRing     = document.getElementById("gateRing");
const gateNum      = document.getElementById("gateNum");
const gateMsg      = document.getElementById("gateMsg");
const gateStartBtn = document.getElementById("gateStartBtn");
const gateCloseBtn = document.getElementById("gateCloseBtn");
const gateCancelBtn= document.getElementById("gateCancelBtn");

const GATE_CIRCUMFERENCE = 2 * Math.PI * 51; // ≈ 320.4
gateRing.style.strokeDasharray = GATE_CIRCUMFERENCE;
gateRing.style.strokeDashoffset = 0;

let gateRemaining = 0;
let gateTimer = null;

// Load settings first so the gate uses the real countdown value
chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (data) => {
  totalGateSeconds = data?.countdownSeconds || 30;
  gateNum.textContent = totalGateSeconds;
  loadSettings(data);
});

gateStartBtn.addEventListener("click", startGate);
gateCloseBtn.addEventListener("click", () => window.close());
gateCancelBtn.addEventListener("click", cancelGate);

function startGate() {
  gateRemaining = totalGateSeconds;
  gate.classList.add("phase-counting");
  gateTick();
  gateTimer = setInterval(gateTick, 1000);
}

function gateTick() {
  const progress = gateRemaining / totalGateSeconds;
  gateRing.style.strokeDashoffset = GATE_CIRCUMFERENCE * (1 - progress);
  gateNum.textContent = gateRemaining;

  if (gateRemaining <= 5) {
    gateRing.className = "ring-progress almost";
    gateMsg.textContent = "Almost there…";
    gateMsg.className = "gate-msg active";
  } else {
    gateRing.className = "ring-progress";
    gateMsg.textContent = "Stay with it. You're doing great.";
    gateMsg.className = "gate-msg active";
  }

  if (gateRemaining <= 0) {
    clearInterval(gateTimer);
    gateRing.className = "ring-progress done";
    gateRing.style.strokeDashoffset = 0;
    gateNum.className = "ring-num done";
    gateNum.textContent = "✓";
    gateMsg.textContent = "";
    // Small pause so the ✓ registers, then reveal settings
    setTimeout(() => { gate.classList.add("phase-done"); }, 600);
    return;
  }
  gateRemaining--;
}

function cancelGate() {
  clearInterval(gateTimer);
  gate.classList.remove("phase-counting");
  gateRing.style.strokeDashoffset = 0;
  gateRing.className = "ring-progress";
  gateNum.className = "ring-num";
  gateNum.textContent = totalGateSeconds;
  gateMsg.textContent = "Ready when you are.";
  gateMsg.className = "gate-msg";
}

// ═══════════════════════════════════════════════════════════
// Settings data
// ═══════════════════════════════════════════════════════════
function loadSettings(data) {
  sites = data.blockedSites || [];
  unlockSessions = data.unlockSessions || {};

  const cd = data.countdownSeconds || 30;
  document.getElementById("countdownSlider").value = cd;
  document.getElementById("countdownVal").textContent = cd + "s";

  const ul = data.unlockMinutes || 10;
  document.getElementById("unlockSlider").value = ul;
  document.getElementById("unlockVal").textContent = ul + "m";

  renderSites();
}

// ═══════════════════════════════════════════════════════════
// Site list rendering
// ═══════════════════════════════════════════════════════════
function isUnlocked(site) {
  const now = Date.now();
  for (const [key, expiry] of Object.entries(unlockSessions)) {
    if (key === site && now < expiry) return true;
  }
  return false;
}

function renderSites() {
  const list = document.getElementById("siteList");
  if (sites.length === 0) {
    list.innerHTML = '<div class="empty-list">No sites blocked yet — add one below.</div>';
    return;
  }

  list.innerHTML = sites.map(site => {
    const unlocked = isUnlocked(site);
    return `
      <div class="site-item${unlocked ? " unlocked-now" : ""}">
        <div class="site-info">
          <span class="site-name">${site}</span>
          ${unlocked ? '<span class="unlocked-badge">unlocked</span>' : ""}
        </div>
        <button class="remove-btn" data-site="${site}" title="Remove ${site}">
          Remove ✕
        </button>
      </div>`;
  }).join("");

  list.querySelectorAll(".remove-btn").forEach(btn => {
    btn.addEventListener("click", () => openRemoveModal(btn.dataset.site));
  });
}

// ═══════════════════════════════════════════════════════════
// Add site (no countdown required — adding is safe)
// ═══════════════════════════════════════════════════════════
document.getElementById("addBtn").addEventListener("click", addSite);
document.getElementById("newSite").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSite();
});

function addSite() {
  let val = document.getElementById("newSite").value.trim().toLowerCase();
  val = val.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!val || sites.includes(val)) return;
  sites.push(val);
  document.getElementById("newSite").value = "";
  renderSites();
}

// ═══════════════════════════════════════════════════════════
// Remove site — gated by its own short countdown
// ═══════════════════════════════════════════════════════════
const removeModal    = document.getElementById("removeModal");
const removeSiteLabel= document.getElementById("removeSiteLabel");
const miniRing       = document.getElementById("miniRing");
const miniNum        = document.getElementById("miniNum");
const modalMsg       = document.getElementById("modalMsg");
const modalCancelBtn = document.getElementById("modalCancelBtn");
const modalConfirmBtn= document.getElementById("modalConfirmBtn");

const MINI_CIRCUMFERENCE = 2 * Math.PI * 33; // ≈ 207.3
miniRing.style.strokeDasharray = MINI_CIRCUMFERENCE;

let pendingRemoveSite = null;
let miniTimer = null;
let miniRemaining = 0;
// Use a fixed short countdown for removals (5 s), not the full gate countdown
const REMOVE_COUNTDOWN = 5;

function openRemoveModal(site) {
  pendingRemoveSite = site;
  removeSiteLabel.textContent = site;
  modalConfirmBtn.classList.remove("ready");
  miniNum.textContent = REMOVE_COUNTDOWN;
  miniRing.style.strokeDashoffset = 0;
  modalMsg.textContent = "Counting down…";
  removeModal.classList.add("open");

  // Auto-start the mini countdown
  miniRemaining = REMOVE_COUNTDOWN;
  clearInterval(miniTimer);
  miniTick();
  miniTimer = setInterval(miniTick, 1000);
}

function miniTick() {
  const progress = miniRemaining / REMOVE_COUNTDOWN;
  miniRing.style.strokeDashoffset = MINI_CIRCUMFERENCE * (1 - progress);
  miniNum.textContent = miniRemaining;

  if (miniRemaining <= 0) {
    clearInterval(miniTimer);
    miniNum.textContent = "✓";
    modalMsg.textContent = "Confirm to remove.";
    modalConfirmBtn.classList.add("ready");
    return;
  }
  miniRemaining--;
}

function closeRemoveModal() {
  clearInterval(miniTimer);
  removeModal.classList.remove("open");
  pendingRemoveSite = null;
  modalConfirmBtn.classList.remove("ready");
}

modalCancelBtn.addEventListener("click", closeRemoveModal);

modalConfirmBtn.addEventListener("click", () => {
  if (!pendingRemoveSite || !modalConfirmBtn.classList.contains("ready")) return;
  const site = pendingRemoveSite;
  sites = sites.filter(s => s !== site);
  chrome.runtime.sendMessage({ type: "REVOKE_UNLOCK", hostname: site });
  closeRemoveModal();
  renderSites();
});

// Close modal on backdrop click
removeModal.addEventListener("click", (e) => {
  if (e.target === removeModal) closeRemoveModal();
});

// ═══════════════════════════════════════════════════════════
// Sliders
// ═══════════════════════════════════════════════════════════
document.getElementById("countdownSlider").addEventListener("input", (e) => {
  document.getElementById("countdownVal").textContent = e.target.value + "s";
});

document.getElementById("unlockSlider").addEventListener("input", (e) => {
  document.getElementById("unlockVal").textContent = e.target.value + "m";
});

// ═══════════════════════════════════════════════════════════
// Save
// ═══════════════════════════════════════════════════════════
document.getElementById("saveBtn").addEventListener("click", () => {
  const settings = {
    blockedSites: sites,
    countdownSeconds: parseInt(document.getElementById("countdownSlider").value),
    unlockMinutes: parseInt(document.getElementById("unlockSlider").value)
  };

  chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", ...settings }, () => {
    const status = document.getElementById("saveStatus");
    status.classList.add("show");
    setTimeout(() => status.classList.remove("show"), 2000);
  });
});
