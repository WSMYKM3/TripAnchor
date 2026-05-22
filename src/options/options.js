import {
  createTrip,
  deleteTrip,
  exportBackup,
  getState,
  importBackup,
  listTrips,
  renameTrip,
  switchTrip,
} from "../lib/storage.js";

const $ = (sel) => document.querySelector(sel);

const els = {
  tripList: $("#ta-trip-list"),
  newTripName: $("#ta-new-trip-name"),
  newTrip: $("#ta-new-trip"),
  exportJson: $("#ta-export-json"),
  importJson: $("#ta-import-json"),
  backupStatus: $("#ta-backup-status"),
  preview: $("#ta-storage-preview"),
};

function fmtDate(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
}

async function refresh() {
  const state = await getState();
  const trips = await listTrips();
  els.tripList.innerHTML = "";
  for (const trip of trips) {
    const row = document.createElement("div");
    row.className =
      "ta-trip-row" + (trip.id === state.activeTripId ? " ta-active" : "");
    row.innerHTML = `
      <div class="ta-trip-info">
        <strong></strong>
        <span>${trip.places.length} place(s) · updated ${escapeHtml(fmtDate(trip.updatedAt))}</span>
      </div>
      <button class="ta-link" data-act="rename" data-id="${escapeHtml(trip.id)}">Rename</button>
      ${
        trip.id === state.activeTripId
          ? '<span class="ta-tag">active</span>'
          : `<button class="ta-link" data-act="switch" data-id="${escapeHtml(trip.id)}">Activate</button>`
      }
      <button class="ta-link" data-act="delete" data-id="${escapeHtml(trip.id)}" style="color: var(--danger)">Delete</button>
    `;
    row.querySelector("strong").textContent = trip.name;
    els.tripList.appendChild(row);
  }
  els.preview.textContent = JSON.stringify(state, null, 2);
}

async function onTripListClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  try {
    if (act === "switch") {
      await switchTrip(id);
    } else if (act === "rename") {
      const next = prompt("Rename trip to:", btn.closest(".ta-trip-row").querySelector("strong").textContent);
      if (next && next.trim()) await renameTrip(id, next.trim());
    } else if (act === "delete") {
      const trips = await listTrips();
      const trip = trips.find((t) => t.id === id);
      if (!trip) return;
      if (
        !confirm(
          `Delete trip "${trip.name}" with ${trip.places.length} place(s)? This cannot be undone.`,
        )
      )
        return;
      await deleteTrip(id);
    }
    await refresh();
  } catch (err) {
    alert(`Error: ${err.message || err}`);
  }
}

async function onCreateTrip() {
  const name = els.newTripName.value.trim();
  if (!name) {
    els.newTripName.focus();
    return;
  }
  await createTrip(name);
  els.newTripName.value = "";
  await refresh();
}

function flashStatus(msg, kind = "") {
  els.backupStatus.textContent = msg;
  els.backupStatus.className = `ta-status${kind ? " ta-status-" + kind : ""}`;
  setTimeout(() => {
    if (els.backupStatus.textContent === msg) {
      els.backupStatus.textContent = "";
      els.backupStatus.className = "ta-status";
    }
  }, 4000);
}

async function onExportJson() {
  const backup = await exportBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `TripAnchor-backup-${stamp}.json`;
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  flashStatus("Backup downloaded.", "ok");
}

async function onImportJson(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    if (
      !confirm(
        "Importing will REPLACE all current trips and places with the backup. Continue?",
      )
    ) {
      e.target.value = "";
      return;
    }
    await importBackup(backup);
    flashStatus("Backup restored.", "ok");
    await refresh();
  } catch (err) {
    flashStatus(`Restore failed: ${err.message || err}`, "warn");
  } finally {
    e.target.value = "";
  }
}

function bind() {
  els.tripList.addEventListener("click", onTripListClick);
  els.newTrip.addEventListener("click", onCreateTrip);
  els.newTripName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onCreateTrip();
  });
  els.exportJson.addEventListener("click", onExportJson);
  els.importJson.addEventListener("change", onImportJson);
}

bind();
refresh().catch((err) => {
  console.error("TripAnchor options error", err);
});
