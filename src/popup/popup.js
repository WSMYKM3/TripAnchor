import {
  addPlaces,
  clearTrip,
  getActiveTrip,
  removePlace,
} from "../lib/storage.js";
import { tripToKml, countExportable } from "../lib/kml.js";
import { tripToCsv } from "../lib/csv.js";
import { hasCoords } from "../lib/places.js";

const $ = (sel) => document.querySelector(sel);

const els = {
  tripName: $("#ta-trip-name"),
  candidates: $("#ta-candidates"),
  candidateActions: $("#ta-candidate-actions"),
  addSelected: $("#ta-add-selected"),
  addStatus: $("#ta-add-status"),
  rescan: $("#ta-rescan"),
  saved: $("#ta-saved"),
  savedCount: $("#ta-saved-count"),
  seeTrip: $("#ta-see-trip"),
  exportCsv: $("#ta-export-csv"),
  exportKml: $("#ta-export-kml"),
  exportHint: $("#ta-export-hint"),
  clear: $("#ta-clear"),
  manageTrips: $("#ta-manage-trips"),
};

let currentTrip = null;
let currentCandidates = [];
let currentSource = { sourceUrl: "", sourceTitle: "" };

function fmtCoord(p) {
  if (p.lat == null || p.lng == null) return "";
  return `${Number(p.lat).toFixed(4)}, ${Number(p.lng).toFixed(4)}`;
}

function safeHostname(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "className") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k in node && typeof node[k] !== "object") {
      node[k] = v;
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

function tag(text, className = "") {
  return el("span", { className: `ta-tag ${className}`.trim(), text });
}

// Category tag stays text-only (no leading dot).
function plainTag(text) {
  return tag(text, "ta-tag-plain");
}

function coordTagFor(p) {
  if (hasCoords(p)) {
    return tag(`coords ${fmtCoord(p)}`, "ta-tag-coord");
  }
  if (p.address) {
    return tag("needs geocoding", "ta-tag-nocoord");
  }
  return tag("won't map", "ta-tag-bad");
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// Tiny inline SVGs used by empty states. Kept here so the popup ships zero
// extra files for icons.
const GLYPHS = {
  pin: '<path d="M14 11.5c0 4-6 10-6 10s-6-6-6-10a6 6 0 1112 0z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="11" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  briefcase:
    '<rect x="2.5" y="6" width="19" height="13" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 6V4.5A1.5 1.5 0 019.5 3h5A1.5 1.5 0 0116 4.5V6M2.5 12h19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  scan:
    '<path d="M5 3H3v2M19 3h2v2M5 21H3v-2M19 21h2v-2M7 8h10v8H7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
};

function svgGlyph(name, { width = 28, height = 28 } = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("ta-empty-glyph");
  svg.innerHTML = GLYPHS[name] || "";
  return svg;
}

function renderEmpty(container, { glyph, headline, sub }) {
  clearChildren(container);
  const children = [];
  if (glyph) children.push(svgGlyph(glyph));
  children.push(el("div", { className: "ta-empty-headline", text: headline }));
  if (sub) children.push(el("div", { className: "ta-empty-sub", text: sub }));
  container.append(el("div", { className: "ta-empty" }, children));
}

function renderCandidates() {
  if (!currentCandidates.length) {
    renderEmpty(els.candidates, {
      glyph: "pin",
      headline: "No places detected on this page",
      sub: "Try the right-click “Add selection” to resolve a place via Google Maps.",
    });
    els.candidateActions.hidden = true;
    return;
  }
  clearChildren(els.candidates);
  for (const [i, c] of currentCandidates.entries()) {
    const id = `ta-cand-${i}`;
    const checkbox = el("input", {
      type: "checkbox",
      id,
      checked: i === 0,
      dataset: { index: String(i) },
    });
    const tags = el("div", { className: "ta-item-tags" }, [
      plainTag(c.category || "Place"),
      coordTagFor(c),
      c.source ? plainTag(c.source) : null,
    ]);
    const body = el("div", { className: "ta-item-body" }, [
      el("div", { className: "ta-item-name", text: c.name || "Untitled" }),
      el("div", {
        className: "ta-item-meta",
        text: c.address || "(no address)",
      }),
      tags,
    ]);
    const row = el(
      "label",
      { className: "ta-item ta-candidate", htmlFor: id },
      [checkbox, body],
    );
    els.candidates.append(row);
  }
  els.candidateActions.hidden = false;
}

function renderSaved() {
  const places = currentTrip?.places || [];
  els.savedCount.textContent = String(places.length);
  if (!places.length) {
    renderEmpty(els.saved, {
      glyph: "briefcase",
      headline: "No places yet",
      sub: "Open a tab, click the TripAnchor icon, and pick a place from the candidates.",
    });
    updateExportHint();
    return;
  }
  clearChildren(els.saved);
  for (const p of places) {
    const tags = el("div", { className: "ta-item-tags" }, [
      plainTag(p.category || "Place"),
      hasCoords(p)
        ? tag(fmtCoord(p), "ta-tag-coord")
        : tag("needs geocoding", "ta-tag-nocoord"),
    ]);
    const body = el("div", { className: "ta-item-body" }, [
      el("div", { className: "ta-item-name", text: p.name || "Untitled" }),
      el("div", {
        className: "ta-item-meta",
        text:
          p.address || (p.sourceUrl ? safeHostname(p.sourceUrl) : "(no address)"),
      }),
      tags,
    ]);
    const actions = el("div", { className: "ta-item-actions" }, [
      p.sourceUrl
        ? el("a", {
            className: "ta-source-link",
            href: p.sourceUrl,
            target: "_blank",
            rel: "noreferrer noopener",
            title: `Open source: ${safeHostname(p.sourceUrl)}`,
            "aria-label": `Open source page (${safeHostname(p.sourceUrl)})`,
            text: "↗",
          })
        : null,
      el("button", {
        className: "ta-icon-btn",
        type: "button",
        title: "Remove from this trip",
        "aria-label": `Remove ${p.name || "place"} from this trip`,
        dataset: { delete: p.id },
        text: "×",
      }),
    ]);
    els.saved.append(el("div", { className: "ta-item" }, [body, actions]));
  }
  updateExportHint();
}

function updateExportHint() {
  const trip = currentTrip;
  if (!trip) return;
  const counts = countExportable(trip);
  if (counts.total === 0) {
    els.exportCsv.disabled = true;
    els.exportKml.disabled = true;
    els.exportHint.textContent = "Add some places to enable export.";
    els.seeTrip.disabled = true;
    return;
  }
  els.exportCsv.disabled = false;
  els.exportKml.disabled = counts.withCoords === 0;
  els.seeTrip.disabled = false;
  if (counts.withoutCoords > 0) {
    els.exportHint.textContent = `${counts.withoutCoords} of ${counts.total} place(s) lack coordinates. CSV lets My Maps geocode them.`;
  } else {
    els.exportHint.textContent = `All ${counts.total} place(s) have coordinates. Either format works; KML preserves exact pins.`;
  }
}

let statusToken = 0;
function setStatus(msg, kind = "") {
  statusToken += 1;
  const token = statusToken;
  els.addStatus.textContent = msg;
  els.addStatus.className = `ta-status${kind ? " ta-status-" + kind : ""}`;
  if (msg) {
    setTimeout(() => {
      if (statusToken !== token) return;
      els.addStatus.textContent = "";
      els.addStatus.className = "ta-status";
    }, 3500);
  }
}

async function refreshSaved() {
  currentTrip = await getActiveTrip();
  els.tripName.textContent = currentTrip.name;
  els.tripName.title = currentTrip.name;
  renderSaved();
}

async function scanActiveTab() {
  renderEmpty(els.candidates, {
    glyph: "scan",
    headline: "Scanning current tab…",
  });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    renderEmpty(els.candidates, {
      glyph: "pin",
      headline: "No active tab",
    });
    return;
  }
  if (!/^https?:|^file:/i.test(tab.url || "")) {
    renderEmpty(els.candidates, {
      glyph: "pin",
      headline: "Can't scan this page",
      sub: "Browser-internal pages (chrome://, extensions) aren't scannable.",
    });
    currentSource = { sourceUrl: tab.url || "", sourceTitle: tab.title || "" };
    return;
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/lib/extractors.js", "src/content/extract.js"],
    });
    const last = results[results.length - 1];
    const payload = last && last.result;
    if (!payload) {
      renderEmpty(els.candidates, {
        glyph: "pin",
        headline: "No data returned from the page",
      });
      return;
    }
    currentSource = {
      sourceUrl: payload.sourceUrl || tab.url || "",
      sourceTitle: payload.sourceTitle || tab.title || "",
    };
    currentCandidates = payload.candidates || [];
    renderCandidates();
  } catch (err) {
    console.error("TripAnchor scan failed", err);
    renderEmpty(els.candidates, {
      glyph: "pin",
      headline: "Couldn't scan this page",
      sub: String(err.message || err),
    });
  }
}

function hasAddress(c) {
  return typeof c.address === "string" && c.address.trim().length > 0;
}

// In-popup confirmation row (replaces the browser confirm() dialog).
function inlineConfirm({
  anchor,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
}) {
  return new Promise((resolve) => {
    anchor.parentElement
      .querySelectorAll(".ta-confirm")
      .forEach((n) => n.remove());
    const box = el("div", { className: "ta-confirm", role: "alertdialog" }, [
      el("div", { className: "ta-confirm-msg", text: message }),
      el("div", { className: "ta-confirm-actions" }, [
        el("button", {
          className: "ta-secondary",
          type: "button",
          text: cancelLabel,
          onclick: () => done(false),
        }),
        el("button", {
          className: danger
            ? "ta-primary ta-primary-danger ta-confirm-yes"
            : "ta-primary ta-confirm-yes",
          type: "button",
          text: confirmLabel,
          onclick: () => done(true),
        }),
      ]),
    ]);
    function done(answer) {
      box.remove();
      resolve(answer);
    }
    anchor.parentElement.insertBefore(box, anchor.nextSibling);
    box.querySelector(".ta-confirm-yes")?.focus();
  });
}

async function addSelectedCandidates() {
  const boxes = els.candidates.querySelectorAll(
    'input[type="checkbox"][data-index]:checked',
  );
  if (!boxes.length) {
    setStatus("Pick at least one candidate.", "warn");
    return;
  }
  const picks = Array.from(boxes)
    .map((b) => currentCandidates[Number(b.dataset.index)])
    .filter(Boolean);
  const unmappable = picks.filter((c) => !hasCoords(c) && !hasAddress(c));
  if (unmappable.length) {
    const ok = await inlineConfirm({
      anchor: els.candidateActions,
      message: `${unmappable.length} of ${picks.length} selected place(s) have no coordinates or address — they can be saved but won't appear on the map. Add anyway?`,
      confirmLabel: "Add anyway",
    });
    if (!ok) {
      setStatus("Cancelled.", "warn");
      return;
    }
  }
  const inputs = picks.map((c) => ({
    name: c.name,
    address: c.address,
    lat: c.lat,
    lng: c.lng,
    category: c.category,
    sourceUrl: currentSource.sourceUrl,
    sourceTitle: currentSource.sourceTitle,
  }));
  els.addSelected.disabled = true;
  try {
    const results = await addPlaces(inputs);
    const added = results.filter((r) => r.added).length;
    const dup = results.length - added;
    const parts = [];
    if (added) parts.push(`Added ${added}`);
    if (dup) parts.push(`${dup} duplicate${dup > 1 ? "s" : ""} skipped`);
    if (unmappable.length && added) {
      parts.push(
        `${unmappable.length} without coords/address — won't show on map`,
      );
    }
    setStatus(parts.join("; ") || "Nothing to add.", added ? "ok" : "warn");
    await refreshSaved();
  } catch (err) {
    setStatus(`Error: ${err.message || err}`, "warn");
  } finally {
    els.addSelected.disabled = false;
  }
}

function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (chrome.runtime.lastError) {
      const msg = chrome.runtime.lastError.message || "unknown error";
      console.warn("Download failed:", msg);
      setStatus(`Download failed: ${msg}`, "warn");
      return;
    }
    if (downloadId == null) {
      setStatus("Download cancelled.", "warn");
    }
  });
}

function slugify(s) {
  return (
    (s || "tripanchor")
      .toString()
      .replace(/[^\w\-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "tripanchor"
  );
}

function exportCsv() {
  if (!currentTrip || !currentTrip.places.length) return;
  const filename = `TripAnchor-${slugify(currentTrip.name)}.csv`;
  downloadBlob(filename, tripToCsv(currentTrip), "text/csv;charset=utf-8");
}

function exportKml() {
  if (!currentTrip) return;
  const counts = countExportable(currentTrip);
  if (counts.withCoords === 0) return;
  const filename = `TripAnchor-${slugify(currentTrip.name)}.kml`;
  downloadBlob(
    filename,
    tripToKml(currentTrip),
    "application/vnd.google-earth.kml+xml",
  );
}

async function onSeeTripClick() {
  if (!currentTrip || !currentTrip.places.length) return;
  const counts = countExportable(currentTrip);
  if (counts.total === 0) return;
  // Warn early if the browser UI language isn't English — the automation
  // matches against English button labels and the My Maps tab would otherwise
  // open, sit there, and then drop back to manual download.
  const lang = (navigator.language || "").toLowerCase();
  if (lang && !lang.startsWith("en")) {
    const ok = await inlineConfirm({
      anchor: els.seeTrip,
      message:
        "Auto-import only drives the English Google My Maps UI. Open the map and fall back to a manual CSV download?",
      confirmLabel: "Open anyway",
    });
    if (!ok) return;
  }
  els.seeTrip.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TA_START_MY_MAPS_IMPORT",
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not start My Maps import.");
    }
  } catch (err) {
    setStatus(`Couldn't open trip: ${err.message || err}`, "warn");
    els.seeTrip.disabled = false;
  }
}

async function onDeleteClick(e) {
  const btn = e.target.closest("[data-delete]");
  if (!btn) return;
  await removePlace(btn.dataset.delete);
  await refreshSaved();
}

async function onClearClick() {
  if (!currentTrip) return;
  if (!currentTrip.places.length) return;
  const ok = await inlineConfirm({
    anchor: els.clear,
    message: `Remove all ${currentTrip.places.length} place(s) from "${currentTrip.name}"? This can't be undone.`,
    confirmLabel: "Clear trip",
    danger: true,
  });
  if (!ok) return;
  await clearTrip(currentTrip.id);
  await refreshSaved();
}

function onManageTripsClick() {
  chrome.runtime.openOptionsPage();
}

function bind() {
  els.rescan.addEventListener("click", scanActiveTab);
  els.addSelected.addEventListener("click", addSelectedCandidates);
  els.seeTrip.addEventListener("click", onSeeTripClick);
  els.exportCsv.addEventListener("click", exportCsv);
  els.exportKml.addEventListener("click", exportKml);
  els.clear.addEventListener("click", onClearClick);
  els.manageTrips.addEventListener("click", onManageTripsClick);
  els.saved.addEventListener("click", onDeleteClick);
}

async function main() {
  bind();
  await refreshSaved();
  await scanActiveTab();
}

main().catch((err) => {
  console.error("TripAnchor popup error", err);
});
