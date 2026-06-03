// Storage layer for TripAnchor. ES module — used by popup, options, and the
// service worker. The on-disk shape lives in chrome.storage.local under a
// single root key so all reads/writes are atomic on the JSON blob.

import { GEO_MATCH_EPS } from "./places.js";

const ROOT_KEY = "tripanchor.v1";

const DEFAULT_TRIP_ID = "trip_default";
const DEFAULT_TRIP_NAME = "My Trip";

const CATEGORY_VALUES = new Set([
  "Event",
  "Place",
  "Restaurant",
  "Hotel",
  "Attraction",
  "Manual",
]);

function newId(prefix) {
  const rand = Math.random().toString(36).slice(2, 9);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

function emptyTrip(name = DEFAULT_TRIP_NAME) {
  const now = Date.now();
  return {
    id: newId("trip"),
    name,
    createdAt: now,
    updatedAt: now,
    places: [],
  };
}

function emptyRoot() {
  const trip = { ...emptyTrip(DEFAULT_TRIP_NAME), id: DEFAULT_TRIP_ID };
  return {
    activeTripId: trip.id,
    trips: { [trip.id]: trip },
  };
}

async function readRoot() {
  const result = await chrome.storage.local.get(ROOT_KEY);
  const root = result[ROOT_KEY];
  if (!root || typeof root !== "object" || !root.trips) {
    const fresh = emptyRoot();
    await writeRoot(fresh);
    return fresh;
  }
  return root;
}

async function writeRoot(root) {
  await chrome.storage.local.set({ [ROOT_KEY]: root });
}

// Serialize all root mutations. chrome.storage.local.set is per-key atomic, but
// our pattern is read-modify-write across that key, so two concurrent callers
// (popup + context menu, for example) can race and one side's edits get lost.
// A single-slot promise chain is enough — these ops are tiny.
let mutationChain = Promise.resolve();
function withRoot(task) {
  const next = mutationChain.then(async () => {
    const root = await readRoot();
    const result = await task(root);
    await writeRoot(root);
    return result;
  });
  // Keep the chain alive even if `task` throws, so one bad write doesn't
  // wedge every subsequent caller.
  mutationChain = next.catch(() => {});
  return next;
}

export async function getState() {
  return readRoot();
}

export async function getActiveTrip() {
  return withRoot((root) => {
    const trip = root.trips[root.activeTripId];
    if (trip) return trip;
    const first = Object.values(root.trips)[0];
    if (first) {
      root.activeTripId = first.id;
      return first;
    }
    const created = emptyTrip();
    root.trips[created.id] = created;
    root.activeTripId = created.id;
    return created;
  });
}

export async function listTrips() {
  const root = await readRoot();
  return Object.values(root.trips).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createTrip(name) {
  return withRoot((root) => {
    const trip = emptyTrip(name?.trim() || DEFAULT_TRIP_NAME);
    root.trips[trip.id] = trip;
    root.activeTripId = trip.id;
    return trip;
  });
}

export async function switchTrip(tripId) {
  return withRoot((root) => {
    if (!root.trips[tripId]) throw new Error(`Trip ${tripId} not found`);
    root.activeTripId = tripId;
    return root.trips[tripId];
  });
}

export async function renameTrip(tripId, name) {
  return withRoot((root) => {
    const trip = root.trips[tripId];
    if (!trip) throw new Error(`Trip ${tripId} not found`);
    trip.name = name?.trim() || trip.name;
    trip.updatedAt = Date.now();
    return trip;
  });
}

export async function deleteTrip(tripId) {
  return withRoot((root) => {
    if (!root.trips[tripId]) return;
    delete root.trips[tripId];
    const remaining = Object.values(root.trips);
    if (remaining.length === 0) {
      const fresh = emptyTrip();
      root.trips[fresh.id] = fresh;
      root.activeTripId = fresh.id;
    } else if (root.activeTripId === tripId) {
      root.activeTripId = remaining[0].id;
    }
  });
}

export async function clearTrip(tripId) {
  return withRoot((root) => {
    const trip = root.trips[tripId];
    if (!trip) return;
    trip.places = [];
    trip.updatedAt = Date.now();
  });
}

function normalizeKey(value) {
  return (value || "").toString().trim().toLowerCase();
}

function isDuplicate(existing, candidate) {
  const nameKey = normalizeKey(candidate.name);
  const addrKey = normalizeKey(candidate.address);
  const urlKey = normalizeKey(candidate.sourceUrl);
  return existing.some((p) => {
    const sameName = nameKey && normalizeKey(p.name) === nameKey;
    const sameAddr = addrKey && normalizeKey(p.address) === addrKey;
    const sameUrl = urlKey && normalizeKey(p.sourceUrl) === urlKey;
    if (sameUrl && (sameName || sameAddr)) return true;
    if (sameName && sameAddr) return true;
    if (
      candidate.lat != null &&
      candidate.lng != null &&
      p.lat != null &&
      p.lng != null
    ) {
      const dLat = Math.abs(Number(p.lat) - Number(candidate.lat));
      const dLng = Math.abs(Number(p.lng) - Number(candidate.lng));
      if (dLat < GEO_MATCH_EPS && dLng < GEO_MATCH_EPS) return true;
    }
    return false;
  });
}

function sanitizePlace(input) {
  const lat = input.lat == null || input.lat === "" ? null : Number(input.lat);
  const lng = input.lng == null || input.lng === "" ? null : Number(input.lng);
  const category = CATEGORY_VALUES.has(input.category)
    ? input.category
    : "Place";
  return {
    name: (input.name || "").toString().trim() || "Untitled place",
    address: (input.address || "").toString().trim(),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    sourceUrl: (input.sourceUrl || "").toString().trim(),
    sourceTitle: (input.sourceTitle || "").toString().trim(),
    category,
    notes: (input.notes || "").toString(),
  };
}

function resolveTrip(root, tripId) {
  if (tripId) return root.trips[tripId] || null;
  return root.trips[root.activeTripId] || Object.values(root.trips)[0] || null;
}

function addOne(trip, input) {
  const clean = sanitizePlace(input);
  if (isDuplicate(trip.places, clean)) {
    return { added: false, reason: "duplicate", trip };
  }
  const place = {
    id: newId("p"),
    ...clean,
    addedAt: Date.now(),
  };
  trip.places.unshift(place);
  return { added: true, place, trip };
}

export async function addPlace(input, { tripId } = {}) {
  return withRoot((root) => {
    const trip = resolveTrip(root, tripId);
    if (!trip) throw new Error("No trip to add to");
    const result = addOne(trip, input);
    if (result.added) trip.updatedAt = Date.now();
    return result;
  });
}

export async function addPlaces(inputs, { tripId } = {}) {
  return withRoot((root) => {
    const trip = resolveTrip(root, tripId);
    if (!trip) throw new Error("No trip to add to");
    const results = [];
    let anyAdded = false;
    for (const input of inputs) {
      const result = addOne(trip, input);
      if (result.added) anyAdded = true;
      results.push(result);
    }
    if (anyAdded) trip.updatedAt = Date.now();
    return results;
  });
}

export async function removePlace(placeId, { tripId } = {}) {
  return withRoot((root) => {
    const trip = tripId ? root.trips[tripId] : root.trips[root.activeTripId];
    if (!trip) return;
    const before = trip.places.length;
    trip.places = trip.places.filter((p) => p.id !== placeId);
    if (trip.places.length !== before) {
      trip.updatedAt = Date.now();
    }
  });
}

export async function updatePlace(placeId, patch, { tripId } = {}) {
  return withRoot((root) => {
    const trip = tripId ? root.trips[tripId] : root.trips[root.activeTripId];
    if (!trip) return null;
    const place = trip.places.find((p) => p.id === placeId);
    if (!place) return null;
    const merged = sanitizePlace({ ...place, ...patch });
    Object.assign(place, merged);
    trip.updatedAt = Date.now();
    return place;
  });
}

export async function exportBackup() {
  const root = await readRoot();
  return { version: 1, exportedAt: Date.now(), data: root };
}

function sanitizeTrip(rawTrip) {
  if (!rawTrip || typeof rawTrip !== "object") return null;
  const id = typeof rawTrip.id === "string" && rawTrip.id ? rawTrip.id : null;
  if (!id) return null;
  const name =
    typeof rawTrip.name === "string" && rawTrip.name.trim()
      ? rawTrip.name.trim()
      : DEFAULT_TRIP_NAME;
  const now = Date.now();
  const createdAt = Number.isFinite(rawTrip.createdAt)
    ? rawTrip.createdAt
    : now;
  const updatedAt = Number.isFinite(rawTrip.updatedAt)
    ? rawTrip.updatedAt
    : createdAt;
  const places = Array.isArray(rawTrip.places)
    ? rawTrip.places
        .filter((p) => p && typeof p === "object")
        .map((p) => ({
          id: typeof p.id === "string" && p.id ? p.id : newId("p"),
          ...sanitizePlace(p),
          addedAt: Number.isFinite(p.addedAt) ? p.addedAt : now,
        }))
    : [];
  return { id, name, createdAt, updatedAt, places };
}

export async function importBackup(backup, { merge = false } = {}) {
  if (!backup || !backup.data || !backup.data.trips) {
    throw new Error("Invalid backup file");
  }

  const cleanTrips = {};
  for (const rawTrip of Object.values(backup.data.trips)) {
    const trip = sanitizeTrip(rawTrip);
    if (trip) cleanTrips[trip.id] = trip;
  }
  if (!Object.keys(cleanTrips).length) {
    throw new Error("Backup contained no valid trips");
  }
  const requestedActive = backup.data.activeTripId;
  const cleanActive =
    typeof requestedActive === "string" && cleanTrips[requestedActive]
      ? requestedActive
      : Object.keys(cleanTrips)[0];

  return withRoot((root) => {
    if (!merge) {
      root.trips = cleanTrips;
      root.activeTripId = cleanActive;
      return;
    }
    for (const [id, trip] of Object.entries(cleanTrips)) {
      if (root.trips[id]) {
        const existing = root.trips[id];
        for (const p of trip.places) {
          if (!isDuplicate(existing.places, p)) {
            existing.places.push({ ...p, id: newId("p") });
          }
        }
        existing.updatedAt = Date.now();
      } else {
        root.trips[id] = trip;
      }
    }
  });
}

export { ROOT_KEY };
