// Background service worker for TripAnchor.
//
// Responsibilities:
//   1. Register and handle the right-click context menus.
//   2. Drive the "resolve a place via Google Maps" flow:
//        - "Add selection to TripAnchor" opens a Google Maps tab pre-loaded
//          with the selected text as a search query, then injects an overlay
//          banner. The user navigates to the right place and confirms; the
//          overlay reports back the actual coordinates parsed from the Maps
//          URL so we save a real geocoded place instead of raw text.
//   3. Maintain "pending" state in chrome.storage.session keyed by tabId so
//          multiple confirmations can run in parallel and survive Maps' SPA
//          navigations.

import { addPlace, getActiveTrip } from "../lib/storage.js";
import { tripToMyMapsAutoImportCsv } from "../lib/csv.js";

const MENU_ID_SELECTION = "tripanchor-add-selection";
const MENU_ID_PAGE = "tripanchor-add-page";
const PENDING_KEY = "pendings";
const MY_MAPS_IMPORTS_KEY = "myMapsImports";
const MY_MAPS_IMPORT_TTL_MS = 30 * 60 * 1000;
const MAPS_HOST_RE = /^https?:\/\/(?:www\.)?google\.[^/]+\/maps(?:\/|$|\?)/i;
const MY_MAPS_HOST_RE =
  /^https?:\/\/(?:www\.)?google\.[^/]+\/maps\/d(?:\/|$|\?)/i;

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
    });
  } catch (err) {
    console.warn("TripAnchor notify failed", err);
  }
}

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID_SELECTION,
      title: "Add selection to TripAnchor (resolve via Google Maps)",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: MENU_ID_PAGE,
      title: "Add this page to TripAnchor",
      contexts: ["page"],
    });
  });
}

chrome.runtime.onInstalled.addListener(setupMenus);
chrome.runtime.onStartup.addListener(setupMenus);

async function readPendings() {
  const result = await chrome.storage.session.get(PENDING_KEY);
  return result[PENDING_KEY] || {};
}

async function writePendings(pendings) {
  await chrome.storage.session.set({ [PENDING_KEY]: pendings });
}

async function setPending(tabId, pending) {
  const all = await readPendings();
  all[String(tabId)] = pending;
  await writePendings(all);
}

async function getPending(tabId) {
  if (tabId == null) return null;
  const all = await readPendings();
  return all[String(tabId)] || null;
}

async function clearPending(tabId) {
  if (tabId == null) return;
  const all = await readPendings();
  if (all[String(tabId)]) {
    delete all[String(tabId)];
    await writePendings(all);
  }
}

async function readMyMapsImports() {
  const result = await chrome.storage.session.get(MY_MAPS_IMPORTS_KEY);
  const imports = result[MY_MAPS_IMPORTS_KEY] || {};
  const now = Date.now();
  let changed = false;
  for (const [tabId, pending] of Object.entries(imports)) {
    if (!pending?.createdAt || now - pending.createdAt > MY_MAPS_IMPORT_TTL_MS) {
      delete imports[tabId];
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.session.set({ [MY_MAPS_IMPORTS_KEY]: imports });
  }
  return imports;
}

async function writeMyMapsImports(imports) {
  await chrome.storage.session.set({ [MY_MAPS_IMPORTS_KEY]: imports });
}

async function setMyMapsImport(tabId, pending) {
  const imports = await readMyMapsImports();
  imports[String(tabId)] = pending;
  await writeMyMapsImports(imports);
}

async function getMyMapsImport(tabId) {
  if (tabId == null) return null;
  const imports = await readMyMapsImports();
  return imports[String(tabId)] || null;
}

async function clearMyMapsImport(tabId) {
  if (tabId == null) return;
  const imports = await readMyMapsImports();
  if (!imports[String(tabId)]) return;
  delete imports[String(tabId)];
  await writeMyMapsImports(imports);
}

function slugify(value) {
  return (
    (value || "tripanchor")
      .toString()
      .replace(/[^\w\-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "tripanchor"
  );
}

async function injectMyMapsImport(tabId) {
  const pending = await getMyMapsImport(tabId);
  if (!pending) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["src/content/mymaps-import.js"],
    });
  } catch (err) {
    console.warn("TripAnchor My Maps injection failed", err);
  }
}

async function handoffMyMapsImport(tab) {
  if (tab.id == null) return null;
  const existing = await getMyMapsImport(tab.id);
  if (existing || tab.openerTabId == null) return existing;
  const parentPending = await getMyMapsImport(tab.openerTabId);
  if (!parentPending) return null;
  const pending = { ...parentPending, updatedAt: Date.now() };
  await setMyMapsImport(tab.id, pending);
  await clearMyMapsImport(tab.openerTabId);
  return pending;
}

async function startMyMapsImport() {
  const trip = await getActiveTrip();
  const generated = tripToMyMapsAutoImportCsv(trip);
  if (generated.importedCount === 0) {
    throw new Error("None of the saved places has coordinates or an address.");
  }

  const newTab = await chrome.tabs.create({
    url: "https://www.google.com/maps/d/u/0/",
    active: true,
  });
  const pending = {
    id: `mymaps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
    tripName: trip.name || "My Trip",
    filename: `TripAnchor-${slugify(trip.name)}.csv`,
    csv: generated.csv,
    importedCount: generated.importedCount,
    skippedCount: generated.skippedCount,
    status: "pending",
    lastError: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await setMyMapsImport(newTab.id, pending);
  injectMyMapsImport(newTab.id).catch(() => {});
  return { tabId: newTab.id, ...generated };
}

async function startResolveFlow({ selection, sourceUrl, sourceTitle }) {
  const query = (selection.split(/\r?\n/)[0] || selection).trim() || selection;
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  const newTab = await chrome.tabs.create({ url: mapsUrl, active: true });
  await setPending(newTab.id, {
    query,
    selection,
    sourceUrl: sourceUrl || "",
    sourceTitle: sourceTitle || "",
    mapsTabId: newTab.id,
    createdAt: Date.now(),
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === MENU_ID_SELECTION) {
      const selection = (info.selectionText || "").trim();
      if (!selection) {
        notify("TripAnchor", "Nothing selected to add.");
        return;
      }
      await startResolveFlow({
        selection,
        sourceUrl: tab?.url || info.pageUrl || "",
        sourceTitle: tab?.title || "",
      });
    } else if (info.menuItemId === MENU_ID_PAGE) {
      const url = tab?.url || info.pageUrl || "";
      const title = tab?.title || "Untitled page";
      if (!url) {
        notify("TripAnchor", "No page URL to capture.");
        return;
      }
      const result = await addPlace({
        name: title,
        address: "",
        sourceUrl: url,
        sourceTitle: title,
        category: "Manual",
        notes: "Captured via right-click on page.",
      });
      notify(
        "TripAnchor",
        result.added ? `Saved "${title}"` : `Already saved: "${title}"`,
      );
    }
  } catch (err) {
    console.error("TripAnchor context-menu error", err);
    notify("TripAnchor", `Error: ${err.message || err}`);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status !== "complete") return;
  if (tab.url && MAPS_HOST_RE.test(tab.url)) {
    const pending = await getPending(tabId);
    if (pending) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["src/content/maps-overlay.js"],
        });
      } catch (err) {
        console.warn("TripAnchor overlay injection failed", err);
      }
    }
  }
  if (tab.url && MY_MAPS_HOST_RE.test(tab.url)) {
    await handoffMyMapsImport(tab);
    await injectMyMapsImport(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearPending(tabId).catch(() => {});
  clearMyMapsImport(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "TA_GET_PENDING") {
    const tabId = sender.tab?.id;
    getPending(tabId)
      .then((pending) => sendResponse({ ok: true, pending }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "TA_START_MY_MAPS_IMPORT") {
    startMyMapsImport()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (message.type === "TA_GET_MY_MAPS_IMPORT") {
    const tabId = sender.tab?.id;
    getMyMapsImport(tabId)
      .then((pending) => sendResponse({ ok: true, pending }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "TA_WAKE_MY_MAPS_IMPORT_FRAMES") {
    const tabId = sender.tab?.id;
    injectMyMapsImport(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "TA_COMPLETE_MY_MAPS_IMPORT") {
    const tabId = sender.tab?.id;
    clearMyMapsImport(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "TA_FAIL_MY_MAPS_IMPORT") {
    const tabId = sender.tab?.id;
    (async () => {
      const pending = await getMyMapsImport(tabId);
      if (!pending) return;
      await setMyMapsImport(tabId, {
        ...pending,
        status: "failed",
        lastError: String(message.error || "My Maps automation stopped."),
        updatedAt: Date.now(),
      });
    })()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "TA_RESOLVE_PENDING") {
    const tabId = sender.tab?.id;
    (async () => {
      const pending = await getPending(tabId);
      if (!pending) {
        sendResponse({ ok: false, error: "No pending place for this tab." });
        return;
      }
      const { lat, lng, name, mapsUrl, address } = message.place || {};
      if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
        sendResponse({ ok: false, error: "Place is missing coordinates." });
        return;
      }
      const result = await addPlace({
        name: name || pending.query || "Untitled place",
        address: address || "",
        lat: Number(lat),
        lng: Number(lng),
        sourceUrl: pending.sourceUrl,
        sourceTitle: pending.sourceTitle,
        category: "Manual",
        notes: [
          pending.selection && pending.selection !== pending.query
            ? `Selected text: "${pending.selection}"`
            : "",
          mapsUrl ? `Resolved via ${mapsUrl}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      await clearPending(tabId);
      sendResponse({ ok: true, result });
    })().catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "TA_CANCEL_PENDING") {
    const tabId = sender.tab?.id;
    clearPending(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "TA_ADD_PLACE") {
    addPlace(message.place || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "TA_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
