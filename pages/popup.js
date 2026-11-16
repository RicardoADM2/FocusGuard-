let sites = [];
let hardSites = [];
let unlockSessions = {};

    // Load settings
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (data) => {
      sites = data.blockedSites || [];
      hardSites = data.hardBlockedSites || [];
      unlockSessions = data.unlockSessions || {};

      document.getElementById("enableToggle").checked = data.enabled !== false;
      document.getElementById("toggleLabel").textContent = data.enabled !== false ? "On" : "Off";

      const cd = data.countdownSeconds || 30;
      document.getElementById("countdownSlider").value = cd;
      document.getElementById("countdownVal").textContent = cd + "s";

      const ul = data.unlockMinutes || 10;
      document.getElementById("unlockSlider").value = ul;
      document.getElementById("unlockVal").textContent = ul + "m";

      renderSites();
      renderHardSites();
    });

    // Toggle
    document.getElementById("enableToggle").addEventListener("change", (e) => {
      const turningOn = e.target.checked;

      if (turningOn) {
        chrome.runtime.sendMessage({ type: "ENABLE_PROTECTION" }, () => {
          document.getElementById("toggleLabel").textContent = "On";
        });
      } else {
        // Revert the visual toggle immediately — disabling requires the countdown
        e.target.checked = true;
        document.getElementById("toggleLabel").textContent = "On";

        const url = chrome.runtime.getURL("pages/blocked.html") + "?mode=disable";
        chrome.tabs.create({ url });
      }
    });

    // Sliders
    document.getElementById("countdownSlider").addEventListener("input", (e) => {
      document.getElementById("countdownVal").textContent = e.target.value + "s";
    });

    document.getElementById("unlockSlider").addEventListener("input", (e) => {
      document.getElementById("unlockVal").textContent = e.target.value + "m";
    });

    // Add site
    document.getElementById("addBtn").addEventListener("click", addSite);
    document.getElementById("newSite").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addSite();
    });

    function cleanSite(raw) {
      const val = raw.trim().toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/[\/?#].*$/, "")
        .replace(/^www\./, "");
      return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(val) ? val : null;
    }

    function flagInvalid() {
      const input = document.getElementById("newSite");
      input.classList.add("invalid");
      setTimeout(() => input.classList.remove("invalid"), 1200);
    }

    // Hard blocks need a second click so they can't be added by accident.
    const addBtn = document.getElementById("addBtn");
    const hardCheck = document.getElementById("hardCheck");
    let confirmTimer = null;

    function resetAddButton() {
      clearTimeout(confirmTimer);
      confirmTimer = null;
      addBtn.textContent = hardCheck.checked ? "Hard block" : "Add";
      addBtn.classList.toggle("btn-danger-solid", hardCheck.checked);
      addBtn.classList.toggle("btn-accent", !hardCheck.checked);
    }

    hardCheck.addEventListener("change", () => {
      document.getElementById("hardHint").classList.toggle("show", hardCheck.checked);
      resetAddButton();
    });

    document.getElementById("newSite").addEventListener("input", resetAddButton);

    function addSite() {
      const input = document.getElementById("newSite");
      const val = cleanSite(input.value);
      if (!val) { if (input.value.trim()) flagInvalid(); return; }

      if (hardCheck.checked) {
        if (hardSites.includes(val)) { input.value = ""; return; }
        if (!confirmTimer) {
          addBtn.textContent = "Sure? Click again";
          confirmTimer = setTimeout(resetAddButton, 4000);
          return;
        }
        resetAddButton();
        chrome.runtime.sendMessage({ type: "ADD_HARD_SITE", site: val }, (res) => {
          if (!res || !res.success) { flagInvalid(); return; }
          hardSites = res.hardBlockedSites;
          sites = sites.filter(s => s !== val); // it moved from timed to hard
          input.value = "";
          renderSites();
          renderHardSites();
        });
        return;
      }

      if (hardSites.some(h => val === h || val.endsWith("." + h))) {
        flagInvalid(); // already covered by a hard block
        return;
      }
      if (sites.includes(val)) return;
      sites.push(val);
      input.value = "";
      renderSites();
    }

    function removeSite(site) {
      sites = sites.filter(s => s !== site);
      // Also revoke any active unlock
      chrome.runtime.sendMessage({ type: "REVOKE_UNLOCK", hostname: site });
      renderSites();
    }

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
        list.innerHTML = '<div class="empty-list">No sites blocked yet</div>';
        return;
      }

      list.innerHTML = sites.map(site => {
        const unlocked = isUnlocked(site);
        return `
          <div class="site-item${unlocked ? ' unlocked-now' : ''}">
            <div class="site-info">
              <span class="site-name">${site}</span>
              ${unlocked ? '<span class="unlocked-badge">unlocked</span>' : ''}
            </div>
            <button class="remove-btn" data-site="${site}" title="Remove">✕</button>
          </div>
        `;
      }).join('');

      list.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', () => removeSite(btn.dataset.site));
      });
    }

    function renderHardSites() {
      const section = document.getElementById("hardSection");
      const list = document.getElementById("hardList");
      section.style.display = hardSites.length ? "block" : "none";
      list.textContent = "";

      hardSites.forEach(site => {
        const row = document.createElement("div");
        row.className = "site-item hard-item";

        const info = document.createElement("div");
        info.className = "site-info";
        const lock = document.createElement("span");
        lock.className = "lock";
        lock.textContent = "🔒";
        const name = document.createElement("span");
        name.className = "site-name";
        name.textContent = site;
        info.append(lock, name);

        const btn = document.createElement("button");
        btn.className = "hard-remove";
        btn.textContent = "Remove…";
        btn.title = "Five questions and a 5-minute wait";
        btn.addEventListener("click", () => {
          const url = chrome.runtime.getURL("pages/blocked.html") +
            "?mode=remove&entry=" + encodeURIComponent(site);
          chrome.tabs.create({ url });
        });

        row.append(info, btn);
        list.appendChild(row);
      });
    }

    // Save
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
