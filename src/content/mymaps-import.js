// Best-effort Google My Maps UI automation for the "See my trip" flow.
// Google does not expose a public write API for My Maps, so this script keeps
// its selectors deliberately small and falls back to a manual CSV download.

(() => {
  if (globalThis.__tripAnchorMyMapsImport) {
    globalThis.__tripAnchorMyMapsImport.wake();
    return;
  }

  const RUN_TIMEOUT_MS = 45_000;
  const ACTION_PAUSE_MS = 500;
  const isTopFrame = window === window.top;
  const state = {
    pending: null,
    deadline: Date.now() + RUN_TIMEOUT_MS,
    lastActionAt: 0,
    uploadedAt: 0,
    locationChosen: false,
    locationAdvanced: false,
    titleChosen: false,
    finishing: false,
    finishClickedAt: 0,
    createStarted: false,
    createConfirmed: false,
    stopped: false,
    complete: false,
    pumping: false,
    clickedElements: new WeakSet(),
    lastReadyStep: "(none)",
  };

  let observer = null;
  let timer = null;
  let heartbeat = null;

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function normalize(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getClientRects().length > 0
    );
  }

  function isEnabled(element) {
    return (
      !element.disabled &&
      element.getAttribute("aria-disabled") !== "true" &&
      !element.closest('[aria-disabled="true"]')
    );
  }

  function getActionTexts(element) {
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.textContent,
    ]
      .map(normalize)
      .filter(Boolean);
  }

  function matchesAction(element, wanted) {
    return getActionTexts(element).some((text) => wanted.includes(text));
  }

  function findAction(labels) {
    const wanted = labels.map(normalize);
    const semanticElements = document.querySelectorAll(
      'button, a, input[type="button"], input[type="submit"], [role="button"], [role="link"], [tabindex]',
    );
    for (const element of semanticElements) {
      if (!isVisible(element) || !isEnabled(element)) continue;
      if (matchesAction(element, wanted)) return element;
    }

    // My Maps renders some controls, including the initial layer Import
    // action, as clickable div/span text without semantic button attributes.
    // Prefer the smallest exact visible match so a containing layer is never
    // clicked when its child action is available.
    const textElements = Array.from(document.querySelectorAll("div, span"))
      .filter(
        (element) =>
          isVisible(element) &&
          isEnabled(element) &&
          matchesAction(element, wanted),
      )
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.width * aRect.height - bRect.width * bRect.height;
      });
    return textElements[0] || null;
  }

  function panel() {
    if (!isTopFrame) return null;
    let host = document.getElementById("tripanchor-mymaps-status");
    if (host) return host.shadowRoot;

    host = document.createElement("div");
    host.id = "tripanchor-mymaps-status";
    host.style.position = "fixed";
    host.style.top = "16px";
    host.style.right = "16px";
    host.style.zIndex = "2147483647";
    document.documentElement.appendChild(host);

    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .box {
        position: relative;
        width: 300px;
        padding: 16px 16px 14px;
        border: 1px solid #e8dfce;
        border-radius: 12px;
        background: #ffffff;
        box-shadow: 0 8px 28px rgba(42, 36, 29, .2);
        color: #2a241d;
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .title {
        color: #c76847;
        font-weight: 700;
        margin-bottom: 6px;
        letter-spacing: -0.01em;
        padding-right: 22px;
      }
      .close {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        background: transparent;
        color: #a39787;
        cursor: pointer;
        font: inherit;
        font-size: 18px;
        line-height: 1;
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 120ms ease, color 120ms ease;
      }
      .close:hover { background: #f4ecdf; color: #2a241d; }
      .message { color: #4a4036; }
      .diag { color: #a39787; font-size: 11px; margin-top: 6px; }
      .manual-row {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px dashed #e8dfce;
        font-size: 12px;
        color: #7a6f5f;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .manual-link {
        background: none;
        border: none;
        padding: 0;
        color: #c76847;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .manual-link:hover { color: #a8533a; }
      .actions { display: none; gap: 8px; margin-top: 12px; }
      button {
        border: 1px solid #e8dfce;
        border-radius: 8px;
        background: #ffffff;
        color: #2a241d;
        cursor: pointer;
        font: inherit;
        font-weight: 600;
        padding: 7px 12px;
        transition: border-color 140ms ease, color 140ms ease;
      }
      .actions button:hover {
        border-color: #c76847;
        color: #c76847;
      }
      button:focus-visible {
        outline: 2px solid rgba(199, 104, 71, 0.45);
        outline-offset: 2px;
      }
    `;
    const box = document.createElement("div");
    box.className = "box";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.setAttribute("aria-label", "Dismiss TripAnchor");
    close.title = "Dismiss";
    close.textContent = "×";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "TripAnchor";
    const message = document.createElement("div");
    message.className = "message";
    message.textContent = "Preparing your trip...";
    const diag = document.createElement("div");
    diag.className = "diag";
    const manualRow = document.createElement("div");
    manualRow.className = "manual-row";
    const manualHint = document.createElement("span");
    manualHint.textContent = "Auto-import slow?";
    const manualLink = document.createElement("button");
    manualLink.type = "button";
    manualLink.className = "manual-link";
    manualLink.textContent = "Download CSV manually";
    manualRow.append(manualHint, manualLink);
    const actions = document.createElement("div");
    actions.className = "actions";
    const dl = document.createElement("button");
    dl.type = "button";
    dl.dataset.action = "download";
    dl.textContent = "Download CSV";
    actions.append(dl);
    box.append(close, title, message, diag, manualRow, actions);
    root.append(style, box);
    dl.addEventListener("click", downloadCsv);
    manualLink.addEventListener("click", downloadCsv);
    close.addEventListener("click", dismiss);
    return root;
  }

  function setPanel(message, { actions = false, diagnostic = null } = {}) {
    const root = panel();
    if (!root) return;
    root.querySelector(".message").textContent = message;
    root.querySelector(".actions").style.display = actions ? "flex" : "none";
    // When the prominent failure-state Download button is shown, the always-on
    // "Auto-import slow?" row would be redundant — hide it.
    root.querySelector(".manual-row").style.display = actions ? "none" : "flex";
    const diag = root.querySelector(".diag");
    diag.textContent = diagnostic || "";
  }

  function removePanel() {
    const host = document.getElementById("tripanchor-mymaps-status");
    if (host) host.remove();
  }

  async function dismiss() {
    if (state.complete) {
      removePanel();
      return;
    }
    state.stopped = true;
    observer?.disconnect();
    clearTimeout(timer);
    clearInterval(heartbeat);
    // Clear the pending entry in the service worker so a future tab update
    // doesn't re-inject the panel.
    await sendMessage({ type: "TA_COMPLETE_MY_MAPS_IMPORT" }).catch(() => {});
    removePanel();
  }

  function skippedMessage() {
    const count = state.pending?.skippedCount || 0;
    return count
      ? ` ${count} saved place${count === 1 ? "" : "s"} without a location ${count === 1 ? "was" : "were"} skipped.`
      : "";
  }

  function schedule(delay = 0) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      pump().catch((err) => fail(err.message || err));
    }, delay);
  }

  function wakeImportFrames() {
    for (const delay of [0, 500, 1500]) {
      setTimeout(() => {
        sendMessage({ type: "TA_WAKE_MY_MAPS_IMPORT_FRAMES" }).catch(() => {});
      }, delay);
    }
  }

  function clickOnce(element, message) {
    if (!element || state.clickedElements.has(element)) return false;
    if (Date.now() - state.lastActionAt < ACTION_PAUSE_MS) return false;
    state.clickedElements.add(element);
    state.lastActionAt = Date.now();
    setPanel(message);
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const EventClass =
        type.startsWith("pointer") && typeof PointerEvent === "function"
          ? PointerEvent
          : MouseEvent;
      element.dispatchEvent(
        new EventClass(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          button: 0,
          buttons: type.endsWith("down") ? 1 : 0,
        }),
      );
    }
    element.click();
    schedule(ACTION_PAUSE_MS);
    return true;
  }

  function getChoice(labelText) {
    const wanted = normalize(labelText);
    const inputs = document.querySelectorAll(
      'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"]',
    );
    for (const input of inputs) {
      if (!isVisible(input)) continue;
      const id = input.id;
      const label = id
        ? document.querySelector(`label[for="${CSS.escape(id)}"]`)
        : input.closest("label");
      const text = normalize(
        input.getAttribute("aria-label") ||
          label?.textContent ||
          input.parentElement?.textContent,
      );
      if (text === wanted || text.startsWith(`${wanted} `)) return input;
    }
    return null;
  }

  function choose(input, message) {
    if (!input) return false;
    const checked =
      input.checked === true || input.getAttribute("aria-checked") === "true";
    if (!checked) {
      input.click();
    }
    state.lastActionAt = Date.now();
    setPanel(message);
    schedule(ACTION_PAUSE_MS);
    return true;
  }

  function uploadCsv(input) {
    if (!input || state.uploadedAt) return false;
    const file = new File([state.pending.csv], state.pending.filename, {
      type: "text/csv;charset=utf-8",
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    state.uploadedAt = Date.now();
    state.lastActionAt = Date.now();
    setPanel("Uploading your saved places...");
    schedule(ACTION_PAUSE_MS);
    return true;
  }

  async function finish() {
    if (state.complete) return;
    state.complete = true;
    state.stopped = true;
    observer?.disconnect();
    clearTimeout(timer);
    clearInterval(heartbeat);
    await sendMessage({ type: "TA_COMPLETE_MY_MAPS_IMPORT" }).catch(() => {});
    setPanel(
      `Your map is ready with ${state.pending.importedCount} place${state.pending.importedCount === 1 ? "" : "s"}.${skippedMessage()}`,
    );
  }

  async function fail(error, { diagnostic } = {}) {
    if (state.complete || state.stopped) return;
    state.stopped = true;
    const message = String(error || "My Maps automation stopped.");
    const diagText = diagnostic || `Last completed step: ${state.lastReadyStep}`;
    console.warn(`TripAnchor My Maps import failed: ${message} (${diagText})`);
    await sendMessage({
      type: "TA_FAIL_MY_MAPS_IMPORT",
      error: `${message} (${diagText})`,
    }).catch(() => {});
    setPanel("Download and import CSV/KML file", {
      actions: true,
      diagnostic: diagText,
    });
  }

  function downloadCsv() {
    if (!state.pending?.csv) return;
    const url = URL.createObjectURL(
      new Blob([state.pending.csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = state.pending.filename;
    link.style.display = "none";
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  // Each step's `ready()` returns truthy when the matching DOM is visible AND
  // the action hasn't already been taken. `act()` performs the click/upload
  // and returns true when work was done this tick. Order matters: earlier
  // steps short-circuit, mirroring the original pump() flow.
  const STEPS = [
    {
      id: "create-map",
      ready: () => !state.createStarted && !state.uploadedAt,
      act: () => {
        const btn = findAction([
          "Create a new map",
          "Create a map",
          "Create map",
        ]);
        if (clickOnce(btn, "Creating a fresh map...")) {
          state.createStarted = true;
          return true;
        }
        return false;
      },
    },
    {
      id: "confirm-create",
      ready: () => state.createStarted && !state.createConfirmed,
      act: () => {
        const btn = findAction(["Create"]);
        if (clickOnce(btn, "Creating a fresh map...")) {
          state.createConfirmed = true;
          return true;
        }
        return false;
      },
    },
    {
      id: "open-import",
      ready: () => !state.uploadedAt,
      act: () => {
        const btn = findAction(["Import", "Import data"]);
        if (clickOnce(btn, "Opening the My Maps importer...")) {
          wakeImportFrames();
          return true;
        }
        return false;
      },
    },
    {
      id: "upload-csv",
      ready: () => !state.uploadedAt && !!document.querySelector('input[type="file"]'),
      act: () => uploadCsv(document.querySelector('input[type="file"]')),
    },
    {
      id: "pick-location",
      ready: () =>
        state.uploadedAt &&
        !state.locationChosen &&
        !state.locationAdvanced &&
        !!getChoice("Location"),
      act: () => {
        state.locationChosen = choose(
          getChoice("Location"),
          "Selecting the map location column...",
        );
        return state.locationChosen;
      },
    },
    {
      id: "continue-after-location",
      ready: () =>
        state.locationChosen &&
        !state.locationAdvanced &&
        !!findAction(["Continue", "Next"]),
      act: () => {
        if (
          clickOnce(
            findAction(["Continue", "Next"]),
            "Confirming the map location column...",
          )
        ) {
          state.locationAdvanced = true;
          return true;
        }
        return false;
      },
    },
    {
      id: "pick-title",
      ready: () => {
        // Some flows skip the Continue step and jump straight to the
        // title/finish screen; recognize that and advance bookkeeping.
        const name = getChoice("Name");
        const finishBtn = findAction(["Finish"]);
        if (name && finishBtn && !state.locationAdvanced) {
          state.locationAdvanced = true;
        }
        return !!(name && finishBtn) && !state.titleChosen;
      },
      act: () => {
        state.titleChosen = choose(
          getChoice("Name"),
          "Selecting marker titles...",
        );
        return state.titleChosen;
      },
    },
    {
      id: "click-finish",
      ready: () => state.titleChosen && !state.finishing,
      act: () => {
        const btn = findAction(["Finish"]);
        if (clickOnce(btn, "Finishing your map...")) {
          state.finishing = true;
          state.finishClickedAt = Date.now();
          return true;
        }
        return false;
      },
    },
  ];

  async function pump() {
    if (state.pumping || state.stopped || state.complete) return;
    state.pumping = true;
    try {
      if (!isTopFrame) {
        const fileInput = document.querySelector('input[type="file"]');
        if (fileInput) uploadCsv(fileInput);
        return;
      }
      if (Date.now() > state.deadline) {
        await fail("Google My Maps did not reach the next expected step.");
        return;
      }
      const lang = document.documentElement.lang;
      if (lang && !/^en(?:-|$)/i.test(lang)) {
        await fail(
          "Automatic import currently supports the English My Maps interface.",
          { diagnostic: `Detected page language: ${lang}` },
        );
        return;
      }

      // Finishing has its own completion condition (finish button vanishes
      // and any progressbar clears) — once we've clicked Finish we stop
      // driving new steps and just wait.
      if (state.finishing) {
        const finishStillVisible = findAction(["Finish"]);
        const progressStillVisible = Array.from(
          document.querySelectorAll('[role="progressbar"]'),
        ).some(isVisible);
        if (
          !finishStillVisible &&
          !progressStillVisible &&
          Date.now() - state.finishClickedAt >= 1000
        ) {
          await finish();
        }
        return;
      }

      for (const step of STEPS) {
        if (!step.ready()) continue;
        state.lastReadyStep = step.id;
        if (step.act()) return;
      }
    } finally {
      state.pumping = false;
    }
  }

  async function start() {
    const response = await sendMessage({ type: "TA_GET_MY_MAPS_IMPORT" });
    if (!response?.ok || !response.pending) return;
    state.pending = response.pending;
    setPanel("Preparing your trip...");
    observer = new MutationObserver(() => schedule(100));
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    heartbeat = setInterval(() => schedule(), 1000);
    schedule();
  }

  globalThis.__tripAnchorMyMapsImport = {
    wake() {
      if (!state.complete && !state.stopped) schedule();
    },
  };

  start().catch((err) => fail(err.message || err));
})();
