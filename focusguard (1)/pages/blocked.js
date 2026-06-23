const params = new URLSearchParams(window.location.search);
const targetUrl = decodeURIComponent(params.get("url") || "");
const hostname = decodeURIComponent(params.get("host") || "");
const mode = params.get("mode") || "unlock"; // "unlock" | "disable"

// Display
const siteLabel = document.getElementById("siteLabel");
const titleEl = document.getElementById("title");
const subtitleEl = document.getElementById("subtitle");
const proceedBtn = document.getElementById("proceedBtn");
const unlockMsg = document.getElementById("unlockMsg");
const unlockNote = document.getElementById("unlockNote");
const backBtn = document.getElementById("backBtn");

if (mode === "disable") {
  siteLabel.textContent = "FocusGuard";
  titleEl.textContent = "Turn off blocking?";
  subtitleEl.innerHTML = "Disabling FocusGuard removes all site blocks.<br>Wait through the countdown to confirm.";
  backBtn.textContent = "← Cancel";
  proceedBtn.textContent = "Done";
} else {
  siteLabel.textContent = hostname || "blocked site";
}

let totalSeconds = 30;
let remaining = 0;
let timer = null;
const CIRCUMFERENCE = 2 * Math.PI * 51; // ≈ 320.4

const ring = document.getElementById("ring");
const countNum = document.getElementById("countNum");
const msg = document.getElementById("msg");

ring.style.strokeDasharray = CIRCUMFERENCE;
ring.style.strokeDashoffset = 0;

// Load settings
chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (data) => {
  totalSeconds = data?.countdownSeconds || 30;
  countNum.textContent = totalSeconds;
});

document.getElementById("startBtn").addEventListener("click", startCountdown);
document.getElementById("cancelBtn").addEventListener("click", cancel);
backBtn.addEventListener("click", () => {
  if (mode === "disable") {
    window.close();
    history.back();
  } else {
    history.back();
  }
});

proceedBtn.addEventListener("click", () => {
  if (mode === "disable") {
    window.close();
  } else {
    window.location.href = targetUrl;
  }
});

function startCountdown() {
  remaining = totalSeconds;
  document.body.className = "counting";
  tick();
  timer = setInterval(tick, 1000);
}

function tick() {
  const progress = remaining / totalSeconds;
  const offset = CIRCUMFERENCE * (1 - progress);
  ring.style.strokeDashoffset = offset;
  countNum.textContent = remaining;

  if (remaining <= 5) {
    ring.className = "countdown-ring almost";
    msg.textContent = "Almost there…";
    msg.className = "message active";
  } else {
    ring.className = "countdown-ring";
    msg.textContent = "Stay with it. You're doing great.";
    msg.className = "message active";
  }

  if (remaining <= 0) {
    clearInterval(timer);
    if (mode === "disable") {
      confirmDisable();
    } else {
      unlocked();
    }
    return;
  }
  remaining--;
}

function cancel() {
  clearInterval(timer);
  remaining = 0;
  ring.style.strokeDashoffset = 0;
  countNum.textContent = totalSeconds || 30;
  ring.className = "countdown-ring";
  msg.textContent = "Ready when you are.";
  msg.className = "message";
  document.body.className = "";
}

function unlocked() {
  ring.className = "countdown-ring done";
  ring.style.strokeDashoffset = 0;
  countNum.className = "countdown-number done";
  countNum.textContent = "✓";
  document.body.className = "unlocked";
  msg.textContent = "";

  // Grant unlock in background
  chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (data) => {
    const mins = data?.unlockMinutes || 10;
    chrome.runtime.sendMessage({ type: "START_UNLOCK", hostname, durationMinutes: mins }, () => {
      unlockNote.textContent =
        `You have ${mins} minute${mins !== 1 ? 's' : ''} before this site is blocked again.`;
    });
  });
}

function confirmDisable() {
  ring.className = "countdown-ring done";
  ring.style.strokeDashoffset = 0;
  countNum.className = "countdown-number done";
  countNum.textContent = "✓";
  document.body.className = "unlocked";
  msg.textContent = "";

  chrome.runtime.sendMessage({ type: "DISABLE_PROTECTION" }, () => {
    unlockMsg.textContent = "✓ Blocking disabled";
    unlockNote.textContent = "FocusGuard is now off. Re-enable it anytime from the popup.";
  });
}

