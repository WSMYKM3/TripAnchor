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

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

async function refresh() {
  const state = await getState();
  const trips = await listTrips();
  clearChildren(els.tripList);
  for (const trip of trips) {
    const isActive = trip.id === state.activeTripId;
    const info = el("div", { className: "ta-trip-info" }, [
      el("strong", { text: trip.name }),
      el("span", {
        text: `${trip.places.length} place(s) · updated ${fmtDate(trip.updatedAt)}`,
      }),
    ]);
    const actions = [
      el("button", {
        className: "ta-link",
        type: "button",
        text: "Rename",
        dataset: { act: "rename", id: trip.id },
      }),
      isActive
        ? el("span", { className: "ta-tag ta-tag-plain", text: "active" })
        : el("button", {
            className: "ta-link",
            type: "button",
            text: "Activate",
            dataset: { act: "switch", id: trip.id },
          }),
      el("button", {
        className: "ta-link ta-link-danger",
        type: "button",
        text: "Delete",
        dataset: { act: "delete", id: trip.id },
      }),
    ];
    const row = el(
      "div",
      { className: `ta-trip-row${isActive ? " ta-active" : ""}` },
      [info, ...actions],
    );
    els.tripList.append(row);
  }
  els.preview.textContent = JSON.stringify(state, null, 2);
}

function inlineConfirm(rowEl, { message, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    const existing = rowEl.querySelector(".ta-inline-confirm");
    if (existing) existing.remove();
    const box = el(
      "div",
      { className: "ta-inline-confirm", role: "alertdialog" },
      [
        el("span", { className: "ta-inline-msg", text: message }),
        el("button", {
          className: "ta-link",
          type: "button",
          text: "Cancel",
          onclick: () => done(false),
        }),
        el("button", {
          className: danger ? "ta-primary ta-primary-danger" : "ta-primary",
          type: "button",
          text: confirmLabel,
          onclick: () => done(true),
        }),
      ],
    );
    function done(answer) {
      box.remove();
      resolve(answer);
    }
    rowEl.append(box);
    box.querySelector(".ta-primary")?.focus();
  });
}

function inlineRename(rowEl, currentName) {
  return new Promise((resolve) => {
    const existing = rowEl.querySelector(".ta-inline-confirm");
    if (existing) existing.remove();
    const input = el("input", {
      type: "text",
      value: currentName,
      className: "ta-inline-input",
      "aria-label": "New trip name",
    });
    const box = el(
      "div",
      { className: "ta-inline-confirm", role: "dialog" },
      [
        input,
        el("button", {
          className: "ta-link",
          type: "button",
          text: "Cancel",
          onclick: () => done(null),
        }),
        el("button", {
          className: "ta-primary",
          type: "button",
          text: "Save",
          onclick: () => done(input.value.trim()),
        }),
      ],
    );
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(input.value.trim());
      else if (e.key === "Escape") done(null);
    });
    function done(answer) {
      box.remove();
      resolve(answer || null);
    }
    rowEl.append(box);
    input.focus();
    input.select();
  });
}

async function onTripListClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  const row = btn.closest(".ta-trip-row");
  try {
    if (act === "switch") {
      await switchTrip(id);
    } else if (act === "rename") {
      const currentName = row?.querySelector("strong")?.textContent || "";
      const next = await inlineRename(row, currentName);
      if (!next || next === currentName) return;
      await renameTrip(id, next);
    } else if (act === "delete") {
      const trips = await listTrips();
      const trip = trips.find((t) => t.id === id);
      if (!trip) return;
      const ok = await inlineConfirm(row, {
        message: `Delete "${trip.name}" with ${trip.places.length} place(s)?`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      await deleteTrip(id);
    }
    await refresh();
  } catch (err) {
    flashStatus(`Error: ${err.message || err}`, "warn");
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

let statusToken = 0;
function flashStatus(msg, kind = "") {
  statusToken += 1;
  const token = statusToken;
  els.backupStatus.textContent = msg;
  els.backupStatus.className = `ta-status${kind ? " ta-status-" + kind : ""}`;
  setTimeout(() => {
    if (statusToken !== token) return;
    els.backupStatus.textContent = "";
    els.backupStatus.className = "ta-status";
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
  chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (chrome.runtime.lastError) {
      flashStatus(
        `Download failed: ${chrome.runtime.lastError.message || "unknown"}`,
        "warn",
      );
      return;
    }
    if (downloadId == null) {
      flashStatus("Download cancelled.", "warn");
      return;
    }
    flashStatus("Backup downloaded.", "ok");
  });
}

async function onImportJson(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    // We can't easily inline-confirm against the file picker, so keep the
    // safety prompt here — but it's the one remaining native dialog in the
    // options surface and it's gating destructive replace-all.
    if (
      !confirm(
        "Importing will REPLACE all current trips and places with the backup. Continue?",
      )
    ) {
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
