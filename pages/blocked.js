const params = new URLSearchParams(window.location.search);
// URLSearchParams already decodes the values, so no second decodeURIComponent here
// (a second pass throws on any URL containing a literal "%").
const targetUrl = params.get("url") || "";
const hostname = params.get("host") || "";
const entry = params.get("entry") || hostname;
const mode = params.get("mode") || "unlock"; // "unlock" | "disable" | "hard" | "remove"

// ---------------------------------------------------------------------------
// Removing a hard block: five questions, then a 5 minute wait.
// Edit the questions freely. The background script enforces the number of
// answers (5), the minimum length, and the wait; keep QUESTIONS at 5 entries.
// ---------------------------------------------------------------------------
const QUESTIONS = [
  "Why did you block this site in the first place? Describe the actual damage it was doing: the hours lost, the work you skipped, how you felt afterwards. Don't soften it.",
  "What are you hoping to get from this site right now? Is it a real need, or an urge? Describe exactly what you were feeling in the minutes before you came here.",
  "What important thing are you avoiding by wanting this? Name the task, the deadline, and the specific reason it feels uncomfortable to start.",
  "How many times have you made this same deal with yourself — \"just this once\", \"just five minutes\" — and what has it really cost you? Be specific and be honest.",
  "A year from now, if you keep dropping your own rules the moment they get uncomfortable, what has that cost you? And what will you do in the next ten minutes instead of visiting this site?"
];
const MIN_WORDS = 20;
const WAIT_MS = 5 * 60 * 1000;

const ERRORS = {
  answer_too_short: `Every answer needs at least ${MIN_WORDS} words.`,
  answer_repetitive: "One of your answers repeats the same words. Write real sentences.",
  duplicate_answers: "Two of your answers are identical. Answer each question separately.",
  not_hard_blocked: "This site is no longer hard-blocked.",
  forbidden: "This action isn't allowed from here.",
  model_unavailable: "The answer-quality model isn't installed yet. Train it with train_guard.py, then place meta.json, vocab.json, and weights.bin in the extension's model folder.",
  model_rejected: "One or more answers look like scrambled or random text. Rewrite those answers as clear, connected sentences, then submit again."
};

// Display
const siteLabel = document.getElementById("siteLabel");
const titleEl = document.getElementById("title");
const subtitleEl = document.getElementById("subtitle");
const iconEl = document.getElementById("icon");
const proceedBtn = document.getElementById("proceedBtn");
const unlockMsg = document.getElementById("unlockMsg");
const unlockNote = document.getElementById("unlockNote");
const backBtn = document.getElementById("backBtn");

function closeThisTab() {
  window.close();
  // window.close() is ignored for some tabs; fall back to the tabs API.
  setTimeout(() => {
    chrome.tabs.getCurrent((tab) => { if (tab) chrome.tabs.remove(tab.id); });
  }, 100);
}

function leavePage() {
  if (history.length > 1) history.back();
  else closeThisTab();
}

if (mode === "hard") {
  initHard();
} else if (mode === "remove") {
  initRemove();
} else {
  initTimed();
}

// ===========================================================================
// Timed block (original behaviour) and "turn off blocking"
// ===========================================================================
function initTimed() {
  if (mode === "disable") {
    siteLabel.textContent = "FocusGuard";
    titleEl.textContent = "Turn off blocking?";
    subtitleEl.innerHTML = "Disabling FocusGuard removes all timed blocks. Hard blocks stay on.<br>Wait through the countdown to confirm.";
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
      closeThisTab();
    } else {
      leavePage();
    }
  });

  proceedBtn.addEventListener("click", () => {
    if (mode === "disable") {
      closeThisTab();
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
      unlockNote.textContent = "Timed blocks are now off. Hard blocks are still on. Re-enable anytime from the popup.";
    });
  }
}

// ===========================================================================
// Hard block page: nothing to wait through, nothing to unlock
// ===========================================================================
function initHard() {
  document.body.dataset.view = "hard";
  iconEl.textContent = "🔒";
  siteLabel.textContent = entry || "blocked site";
  titleEl.textContent = "This site is hard-blocked";
  subtitleEl.textContent = "You blocked it on purpose, while you were thinking clearly.";

  document.getElementById("hardBackBtn").addEventListener("click", leavePage);
  document.getElementById("hardRemoveBtn").addEventListener("click", () => {
    window.location.href = chrome.runtime.getURL("pages/blocked.html") +
      "?mode=remove&entry=" + encodeURIComponent(entry);
  });
}

// ===========================================================================
// Removal flow: questions -> 5 minute wait -> final confirmation
// ===========================================================================
function initRemove() {
  document.body.dataset.view = "remove";
  document.body.dataset.stage = "questions";
  iconEl.textContent = "🔒";
  siteLabel.textContent = entry || "unknown site";
  titleEl.textContent = "Remove this block?";
  subtitleEl.textContent = "Answer five questions in your own words, then wait five minutes. Quitting at any point keeps the block.";

  const qProgress = document.getElementById("qProgress");
  const qCount = document.getElementById("qCount");
  const qText = document.getElementById("qText");
  const qInput = document.getElementById("qInput");
  const qHint = document.getElementById("qHint");
  const wordCountEl = document.getElementById("wordCount");
  const qPrev = document.getElementById("qPrev");
  const qNext = document.getElementById("qNext");

  const waitRing = document.getElementById("waitRing");
  const waitNum = document.getElementById("waitNum");
  const waitMsg = document.getElementById("waitMsg");
  const doneText = document.getElementById("doneText");

  const HINT_DEFAULT = qHint.textContent;
  const CIRC = 2 * Math.PI * 51;
  waitRing.style.strokeDasharray = CIRC;
  waitRing.style.transition = "none";

  const answers = QUESTIONS.map(() => "");
  let qIndex = 0;
  let waitTimer = null;

  document.getElementById("doneBtn").addEventListener("click", closeThisTab);

  if (!entry) {
    document.body.dataset.stage = "done";
    doneText.textContent = "No site was specified. Open this page from the FocusGuard popup.";
    return;
  }

  const countWords = (s) => s.trim().split(/\s+/).filter(Boolean).length;

  // Questions ---------------------------------------------------------------
  QUESTIONS.forEach(() => qProgress.appendChild(document.createElement("span")));

  function renderQuestion() {
    qText.textContent = QUESTIONS[qIndex];
    qCount.textContent = `Question ${qIndex + 1} of ${QUESTIONS.length}`;
    qInput.value = answers[qIndex];
    [...qProgress.children].forEach((el, i) => {
      el.className = i < qIndex ? "done" : i === qIndex ? "current" : "";
    });
    qPrev.disabled = qIndex === 0;
    qNext.textContent = qIndex === QUESTIONS.length - 1 ? "Submit answers" : "Next";
    qHint.textContent = HINT_DEFAULT;
    updateCount();
    qInput.focus();
  }

  function updateCount() {
    const n = countWords(qInput.value);
    wordCountEl.textContent = `${n} / ${MIN_WORDS} words`;
    wordCountEl.className = n >= MIN_WORDS ? "ok" : "";
    qNext.disabled = n < MIN_WORDS;
  }

  qInput.addEventListener("input", () => {
    answers[qIndex] = qInput.value;
    qHint.textContent = HINT_DEFAULT;
    updateCount();
  });

  // No pasting or dropping text in: the answers have to be typed.
  ["paste", "drop"].forEach(evt => qInput.addEventListener(evt, (e) => e.preventDefault()));
  qInput.addEventListener("beforeinput", (e) => {
    if (e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop" || e.inputType === "insertFromYank") {
      e.preventDefault();
    }
  });

  qPrev.addEventListener("click", () => {
    if (qIndex > 0) { qIndex--; renderQuestion(); }
  });

  qNext.addEventListener("click", () => {
    if (qNext.disabled) return;
    if (qIndex < QUESTIONS.length - 1) {
      qIndex++;
      renderQuestion();
    } else {
      submitAnswers();
    }
  });

  function submitAnswers() {
    qNext.disabled = true;
    chrome.runtime.sendMessage({ type: "SUBMIT_REFLECTION", entry, answers: answers.map(a => a.trim()) }, (res) => {
      if (res && res.success) {
        startWait();
      } else if (res?.error === "model_rejected" && Array.isArray(res.rejected) && res.rejected.length) {
        qIndex = res.rejected[0];
        renderQuestion();
        qHint.textContent = `Answer ${qIndex + 1} looks like scrambled or random text. Rewrite it as clear, connected sentences.`;
      } else {
        qHint.textContent = ERRORS[res?.error] || "Couldn't submit your answers. Try again.";
        updateCount();
      }
    });
  }

  function keepBlock() {
    clearInterval(waitTimer);
    chrome.runtime.sendMessage({ type: "CANCEL_REMOVAL", entry }, () => {
      document.body.dataset.stage = "done";
      titleEl.textContent = "Block kept";
      doneText.textContent = `${entry} stays blocked.`;
    });
  }

  document.getElementById("qKeep").addEventListener("click", keepBlock);
  document.getElementById("timerKeep").addEventListener("click", keepBlock);
  document.getElementById("finalKeep").addEventListener("click", keepBlock);

  // Wait --------------------------------------------------------------------
  // The clock only runs while this tab is visible and focused. The background
  // script separately refuses to remove the block until 5 real minutes have passed.
  function startWait() {
    document.body.dataset.stage = "timer";
    buildReadback();

    let visibleMs = 0;
    let last = performance.now();

    function waitTick() {
      const now = performance.now();
      const dt = Math.min(now - last, 1000); // a sleeping laptop doesn't count as time served
      last = now;
      const active = !document.hidden && document.hasFocus();
      if (active) visibleMs += dt;

      const left = Math.max(0, WAIT_MS - visibleMs);
      waitNum.textContent = formatTime(left);
      waitRing.style.strokeDashoffset = CIRC * (1 - left / WAIT_MS);
      waitMsg.textContent = active
        ? "Read what you wrote. The clock only runs while this tab is in front."
        : "Paused. Come back to this tab to keep the clock running.";

      if (left <= 0) {
        clearInterval(waitTimer);
        document.body.dataset.stage = "final";
        document.getElementById("finalKeep").focus();
      }
    }

    waitTick();
    waitTimer = setInterval(waitTick, 250);
  }

  function formatTime(ms) {
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function buildReadback() {
    const box = document.getElementById("readback");
    box.textContent = "";
    const h = document.createElement("h2");
    h.textContent = "Your answers";
    box.appendChild(h);
    const dl = document.createElement("dl");
    QUESTIONS.forEach((q, i) => {
      const dt = document.createElement("dt");
      dt.textContent = q;
      const dd = document.createElement("dd");
      dd.textContent = answers[i].trim();
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    box.appendChild(dl);
  }

  // Final -------------------------------------------------------------------
  document.getElementById("finalRemove").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "FINISH_HARD_REMOVAL", entry }, (res) => {
      if (res && res.success) {
        document.body.dataset.stage = "done";
        iconEl.textContent = "🔓";
        titleEl.textContent = "Block removed";
        doneText.textContent = `${entry} is no longer blocked.`;
      } else if (res?.error === "too_early") {
        const secs = Math.ceil((res.remainingMs || 1000) / 1000);
        document.querySelector(".final-text").textContent =
          `Not quite yet. Try again in ${secs} second${secs !== 1 ? "s" : ""}.`;
      } else if (res?.error === "expired") {
        document.body.dataset.stage = "done";
        doneText.textContent = "That took too long and the request expired. The block is still on.";
      } else {
        document.body.dataset.stage = "done";
        doneText.textContent = "Couldn't remove the block. It's still on.";
      }
    });
  });

  renderQuestion();
}
