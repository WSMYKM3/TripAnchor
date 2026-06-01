import {
  addPlaces,
  clearTrip,
  getActiveTrip,
  removePlace,
} from "../lib/storage.js";
import { tripToKml, countExportable } from "../lib/kml.js";
import { tripToCsv } from "../lib/csv.js";

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

function renderCandidates() {
  els.candidates.innerHTML = "";
  if (!currentCandidates.length) {
    els.candidates.innerHTML =
      '<div class="ta-empty">No places auto-detected on this page</div>';
    els.candidateActions.hidden = true;
    return;
  }
  for (const [i, c] of currentCandidates.entries()) {
    const id = `ta-cand-${i}`;
    const row = document.createElement("label");
    row.className = "ta-item ta-candidate";
    row.htmlFor = id;
    const coordTag =
      c.lat != null && c.lng != null
        ? `<span class="ta-tag ta-tag-coord">coords ${escapeHtml(fmtCoord(c))}</span>`
        : c.address
          ? '<span class="ta-tag ta-tag-nocoord">no coords (My Maps will geocode)</span>'
          : '<span class="ta-tag ta-tag-bad">no coords or address — won\'t map</span>';
    row.innerHTML = `
      <input type="checkbox" id="${id}" data-index="${i}" ${i === 0 ? "checked" : ""}/>
      <div class="ta-item-body">
        <div class="ta-item-name"></div>
        <div class="ta-item-meta"></div>
        <div class="ta-item-tags">
          <span class="ta-tag">${escapeHtml(c.category || "Place")}</span>
          ${coordTag}
          ${c.source ? `<span class="ta-tag">${escapeHtml(c.source)}</span>` : ""}
        </div>
      </div>`;
    row.querySelector(".ta-item-name").textContent = c.name || "Untitled";
    row.querySelector(".ta-item-meta").textContent =
      c.address || "(no address)";
    els.candidates.appendChild(row);
  }
  els.candidateActions.hidden = false;
}

function renderSaved() {
  const places = currentTrip?.places || [];
  els.savedCount.textContent = String(places.length);
  els.saved.innerHTML = "";
  if (!places.length) {
    els.saved.innerHTML =
      '<div class="ta-empty">No places yet. Add some from your tabs.</div>';
    return;
  }
  for (const p of places) {
    const row = document.createElement("div");
    row.className = "ta-item";
    row.innerHTML = `
      <div class="ta-item-body">
        <div class="ta-item-name"></div>
        <div class="ta-item-meta"></div>
        <div class="ta-item-tags">
          <span class="ta-tag">${escapeHtml(p.category || "Place")}</span>
          ${
            p.lat != null && p.lng != null
              ? `<span class="ta-tag ta-tag-coord">${escapeHtml(fmtCoord(p))}</span>`
              : '<span class="ta-tag ta-tag-nocoord">no coords</span>'
          }
        </div>
      </div>
      <div class="ta-item-actions">
        ${
          p.sourceUrl
            ? `<a class="ta-source-link" href="${escapeAttr(p.sourceUrl)}" target="_blank" rel="noreferrer noopener" title="${escapeAttr(safeHostname(p.sourceUrl))}">↗</a>`
            : ""
        }
        <button class="ta-icon-btn" data-delete="${escapeAttr(p.id)}" title="Remove">×</button>
      </div>`;
    row.querySelector(".ta-item-name").textContent = p.name || "Untitled";
    row.querySelector(".ta-item-meta").textContent =
      p.address || (p.sourceUrl ? safeHostname(p.sourceUrl) : "(no address)");
    els.saved.appendChild(row);
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

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );
}

function escapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setStatus(msg, kind = "") {
  els.addStatus.textContent = msg;
  els.addStatus.className = `ta-status${kind ? " ta-status-" + kind : ""}`;
  if (msg) {
    setTimeout(() => {
      if (els.addStatus.textContent === msg) {
        els.addStatus.textContent = "";
        els.addStatus.className = "ta-status";
      }
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
  els.candidates.innerHTML = '<div class="ta-empty">Scanning…</div>';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    els.candidates.innerHTML =
      '<div class="ta-empty">No active tab.</div>';
    return;
  }
  if (!/^https?:|^file:/i.test(tab.url || "")) {
    els.candidates.innerHTML =
      '<div class="ta-empty">Cannot scan this page (chrome:// or extension page).</div>';
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
      els.candidates.innerHTML =
        '<div class="ta-empty">No data returned from the page.</div>';
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
    els.candidates.innerHTML = `<div class="ta-empty">Couldn't scan this page: ${escapeHtml(err.message || err)}</div>`;
  }
}

function hasCoords(c) {
  return (
    c.lat != null &&
    c.lng != null &&
    c.lat !== "" &&
    c.lng !== "" &&
    Number.isFinite(Number(c.lat)) &&
    Number.isFinite(Number(c.lng))
  );
}

function hasAddress(c) {
  return typeof c.address === "string" && c.address.trim().length > 0;
}

async function addSelectedCandidates() {
  const boxes = els.candidates.querySelectorAll(
    'input[type="checkbox"][data-index]:checked',
  );
  if (!boxes.length) {
    setStatus("Pick at least one candidate.", "warn");
    return;
  }
  const picks = Array.from(boxes).map((b) =>
    currentCandidates[Number(b.dataset.index)],
  );
  const unmappable = picks.filter((c) => !hasCoords(c) && !hasAddress(c));
  if (unmappable.length) {
    const ok = confirm(
      "We can not add this to your trip: the coordinates for this location can't be detected.\nAdd anyway?",
    );
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
  chrome.downloads.download(
    {
      url,
      filename,
      saveAs: true,
    },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        console.warn("Download failed:", chrome.runtime.lastError);
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (downloadId == null) return;
    },
  );
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
  els.seeTrip.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TA_START_MY_MAPS_IMPORT",
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not start My Maps import.");
    }
  } catch (err) {
    alert(`TripAnchor could not open your trip: ${err.message || err}`);
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
  if (!confirm(`Remove all ${currentTrip.places.length} places from "${currentTrip.name}"?`))
    return;
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
