// Injected into a Google Maps tab opened by the "Add selection to TripAnchor"
// context menu flow. Shows a floating confirmation banner with the original
// selected text, watches the page URL for the user navigating to a specific
// `/maps/place/<Name>/@lat,lng,...` result, and posts the resolved coords
// back to the service worker for storage.

(function () {
  if (window.__TA_OVERLAY_INSTALLED) return;
  window.__TA_OVERLAY_INSTALLED = true;

  const HOST_ID = "tripanchor-overlay-host";
  let pending = null;
  let host = null;
  let shadow = null;
  let banner = null;
  let lastParsed = { lat: null, lng: null, name: "" };
  let pollTimer = null;

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response);
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  function decodePlaceSegment(segment) {
    if (!segment) return "";
    try {
      return decodeURIComponent(segment.replace(/\+/g, " "));
    } catch {
      return segment.replace(/\+/g, " ");
    }
  }

  function parseFromUrl() {
    const href = location.href;
    const path = location.pathname;

    let name = "";
    const placeMatch = path.match(/\/place\/([^/@]+)/);
    if (placeMatch) name = decodePlaceSegment(placeMatch[1]);

    let lat = null;
    let lng = null;

    const dMatch = href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (dMatch) {
      lat = Number(dMatch[1]);
      lng = Number(dMatch[2]);
    }

    if (lat == null || lng == null) {
      const atMatch = href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
      if (atMatch) {
        lat = Number(atMatch[1]);
        lng = Number(atMatch[2]);
      }
    }

    if (!Number.isFinite(lat)) lat = null;
    if (!Number.isFinite(lng)) lng = null;

    const isPlacePage = Boolean(placeMatch);
    return { lat, lng, name, isPlacePage };
  }

  function ensureBanner() {
    if (host) return;
    document.getElementById(HOST_ID)?.remove();

    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "all: initial; position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647;";
    document.documentElement.appendChild(host);

    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .ta-banner {
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #1b2434;
        background: #ffffff;
        border: 1px solid #c9d2e3;
        border-radius: 10px;
        box-shadow: 0 6px 20px rgba(20, 40, 80, 0.18);
        padding: 12px 14px;
        min-width: 340px;
        max-width: 520px;
      }
      .ta-title {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 700;
        color: #1863af;
        margin-bottom: 4px;
        font-size: 13px;
      }
      .ta-title .ta-tag {
        background: #eaf2fb;
        color: #1863af;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .ta-line {
        margin: 2px 0;
      }
      .ta-query {
        font-weight: 600;
        color: #1b2434;
      }
      .ta-source {
        color: #6b7689;
        font-size: 11px;
        margin: 4px 0 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ta-status {
        font-size: 12px;
        margin: 8px 0;
        color: #6b7689;
      }
      .ta-status.ta-ready {
        color: #28733f;
        font-weight: 600;
      }
      .ta-status.ta-error {
        color: #b53b3b;
      }
      .ta-actions {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
        margin-top: 6px;
      }
      button {
        font: inherit;
        padding: 6px 12px;
        border-radius: 6px;
        border: 1px solid transparent;
        cursor: pointer;
        font-weight: 600;
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .ta-save {
        background: #1863af;
        color: #ffffff;
      }
      .ta-save:hover:not(:disabled) {
        background: #14528c;
      }
      .ta-cancel {
        background: #ffffff;
        border-color: #c9d2e3;
        color: #1b2434;
      }
      .ta-cancel:hover {
        border-color: #1863af;
        color: #1863af;
      }
      .ta-close {
        background: none;
        border: none;
        color: #6b7689;
        cursor: pointer;
        font-size: 16px;
        padding: 0 4px;
        margin-left: auto;
      }
      .ta-close:hover {
        color: #1b2434;
      }
      .ta-toast {
        margin-top: 8px;
        padding: 6px 8px;
        background: #f0fbf3;
        border: 1px solid #cfe6d6;
        color: #28733f;
        border-radius: 6px;
        font-size: 12px;
        display: none;
      }
      .ta-toast.ta-toast-error {
        background: #fef0f0;
        border-color: #f0c8c8;
        color: #b53b3b;
      }
    `;
    shadow.appendChild(style);

    banner = document.createElement("div");
    banner.className = "ta-banner";
    banner.innerHTML = `
      <div class="ta-title">
        <span class="ta-tag">TripAnchor</span>
        <span>Confirm place</span>
        <button class="ta-close" type="button" title="Dismiss without saving">×</button>
      </div>
      <div class="ta-line">Pending: <span class="ta-query"></span></div>
      <div class="ta-source"></div>
      <div class="ta-status">Use the search bar above to find the place, click a result, then press Save.</div>
      <div class="ta-actions">
        <button class="ta-cancel" type="button">Cancel</button>
        <button class="ta-save" type="button" disabled>Save this place</button>
      </div>
      <div class="ta-toast"></div>
    `;
    shadow.appendChild(banner);

    shadow.querySelector(".ta-save").addEventListener("click", onSave);
    shadow.querySelector(".ta-cancel").addEventListener("click", onCancel);
    shadow.querySelector(".ta-close").addEventListener("click", onCancel);
  }

  function removeBanner() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (host) {
      host.remove();
      host = null;
      shadow = null;
      banner = null;
    }
  }

  function showToast(msg, isError = false) {
    if (!shadow) return;
    const t = shadow.querySelector(".ta-toast");
    if (!t) return;
    t.textContent = msg;
    t.style.display = "block";
    t.classList.toggle("ta-toast-error", Boolean(isError));
  }

  function renderState() {
    if (!shadow || !pending) return;
    shadow.querySelector(".ta-query").textContent = `"${pending.query}"`;
    const src = shadow.querySelector(".ta-source");
    src.textContent = pending.sourceUrl ? `From: ${pending.sourceUrl}` : "";
    src.title = pending.sourceUrl || "";

    const parsed = parseFromUrl();
    lastParsed = parsed;
    const status = shadow.querySelector(".ta-status");
    const saveBtn = shadow.querySelector(".ta-save");
    if (parsed.isPlacePage && parsed.lat != null && parsed.lng != null) {
      status.textContent = `Ready: ${parsed.name || "(unnamed)"} — ${parsed.lat.toFixed(5)}, ${parsed.lng.toFixed(5)}`;
      status.className = "ta-status ta-ready";
      saveBtn.disabled = false;
    } else if (parsed.lat != null && parsed.lng != null) {
      status.textContent =
        "Click a search result so Google Maps opens its place card, then press Save.";
      status.className = "ta-status";
      saveBtn.disabled = true;
    } else {
      status.textContent =
        "Use the search bar above to find the place, click a result, then press Save.";
      status.className = "ta-status";
      saveBtn.disabled = true;
    }
  }

  async function onSave() {
    if (!shadow) return;
    const saveBtn = shadow.querySelector(".ta-save");
    if (!lastParsed.lat || !lastParsed.lng) return;
    saveBtn.disabled = true;
    const response = await sendMessage({
      type: "TA_RESOLVE_PENDING",
      place: {
        name: lastParsed.name,
        lat: lastParsed.lat,
        lng: lastParsed.lng,
        mapsUrl: location.href,
      },
    });
    if (response?.ok) {
      const added = response.result?.added;
      showToast(
        added
          ? `Saved "${lastParsed.name || "place"}" to TripAnchor.`
          : "Already in your trip — nothing new to save.",
        !added && response.result?.reason !== "duplicate",
      );
      setTimeout(removeBanner, added ? 1500 : 2200);
    } else {
      showToast(`Save failed: ${response?.error || "unknown error"}`, true);
      saveBtn.disabled = false;
    }
  }

  async function onCancel() {
    await sendMessage({ type: "TA_CANCEL_PENDING" });
    removeBanner();
  }

  async function start() {
    const response = await sendMessage({ type: "TA_GET_PENDING" });
    pending = response?.pending || null;
    if (!pending) return;
    ensureBanner();
    renderState();
    pollTimer = setInterval(renderState, 400);
    window.addEventListener("popstate", renderState);
    window.addEventListener("hashchange", renderState);
  }

  start();
})();
