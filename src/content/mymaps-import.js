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
        width: 292px;
        padding: 14px;
        border: 1px solid #d9e2ef;
        border-radius: 10px;
        background: #fff;
        box-shadow: 0 6px 22px rgba(20, 38, 66, .2);
        color: #1b2434;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .title { color: #1863af; font-weight: 700; margin-bottom: 5px; }
      .message { color: #4f5d73; }
      .actions { display: none; gap: 8px; margin-top: 12px; }
      button {
        border: 1px solid #d9e2ef;
        border-radius: 6px;
        background: #fff;
        color: #1b2434;
        cursor: pointer;
        font: inherit;
        font-weight: 600;
        padding: 6px 9px;
      }
    `;
    const box = document.createElement("div");
    box.className = "box";
    box.innerHTML = `
      <div class="title">TripAnchor</div>
      <div class="message">Preparing your trip...</div>
      <div class="actions">
        <button type="button" data-action="download">Download CSV</button>
      </div>
    `;
    root.append(style, box);
    root
      .querySelector('[data-action="download"]')
      .addEventListener("click", downloadCsv);
    return root;
  }

  function setPanel(message, { actions = false } = {}) {
    const root = panel();
    if (!root) return;
    root.querySelector(".message").textContent = message;
    root.querySelector(".actions").style.display = actions ? "flex" : "none";
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

  async function fail(error) {
    if (state.complete || state.stopped) return;
    state.stopped = true;
    const message = String(error || "My Maps automation stopped.");
    await sendMessage({
      type: "TA_FAIL_MY_MAPS_IMPORT",
      error: message,
    }).catch(() => {});
    setPanel("Download and import CSV/KML file", { actions: true });
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
        await fail("Automatic import currently supports the English My Maps interface.");
        return;
      }
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

      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput && uploadCsv(fileInput)) return;

      const locationChoice = getChoice("Location");
      if (locationChoice && !state.locationChosen && !state.locationAdvanced) {
        state.locationChosen = choose(
          locationChoice,
          "Selecting the map location column...",
        );
        return;
      }
      if (state.locationChosen && !state.locationAdvanced) {
        const continueButton = findAction(["Continue", "Next"]);
        if (
          clickOnce(continueButton, "Confirming the map location column...")
        ) {
          state.locationAdvanced = true;
          return;
        }
      }

      const nameChoice = getChoice("Name");
      const finishButton = findAction(["Finish"]);
      if (nameChoice && finishButton && !state.locationAdvanced) {
        state.locationAdvanced = true;
      }
      if (nameChoice && finishButton && !state.titleChosen) {
        state.titleChosen = choose(nameChoice, "Selecting marker titles...");
        return;
      }
      if (state.titleChosen) {
        if (clickOnce(finishButton, "Finishing your map...")) {
          state.finishing = true;
          state.finishClickedAt = Date.now();
          return;
        }
      }

      const importButton = findAction(["Import", "Import data"]);
      if (clickOnce(importButton, "Opening the My Maps importer...")) {
        wakeImportFrames();
        return;
      }

      if (state.createStarted && !state.createConfirmed) {
        const createConfirm = findAction(["Create"]);
        if (
          createConfirm &&
          clickOnce(createConfirm, "Creating a fresh map...")
        ) {
          state.createConfirmed = true;
          return;
        }
      }

      const createMap = findAction([
        "Create a new map",
        "Create a map",
        "Create map",
      ]);
      if (clickOnce(createMap, "Creating a fresh map...")) {
        state.createStarted = true;
        return;
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
