// Storage layer for TripAnchor. ES module — used by popup, options, and the
// service worker. The on-disk shape lives in chrome.storage.local under a
// single root key so all reads/writes are atomic on the JSON blob.

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

export async function getState() {
  return readRoot();
}

export async function getActiveTrip() {
  const root = await readRoot();
  const trip = root.trips[root.activeTripId];
  if (trip) return trip;
  const first = Object.values(root.trips)[0];
  if (first) {
    root.activeTripId = first.id;
    await writeRoot(root);
    return first;
  }
  const created = emptyTrip();
  root.trips[created.id] = created;
  root.activeTripId = created.id;
  await writeRoot(root);
  return created;
}

export async function listTrips() {
  const root = await readRoot();
  return Object.values(root.trips).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createTrip(name) {
  const root = await readRoot();
  const trip = emptyTrip(name?.trim() || DEFAULT_TRIP_NAME);
  root.trips[trip.id] = trip;
  root.activeTripId = trip.id;
  await writeRoot(root);
  return trip;
}

export async function switchTrip(tripId) {
  const root = await readRoot();
  if (!root.trips[tripId]) throw new Error(`Trip ${tripId} not found`);
  root.activeTripId = tripId;
  await writeRoot(root);
  return root.trips[tripId];
}

export async function renameTrip(tripId, name) {
  const root = await readRoot();
  const trip = root.trips[tripId];
  if (!trip) throw new Error(`Trip ${tripId} not found`);
  trip.name = name?.trim() || trip.name;
  trip.updatedAt = Date.now();
  await writeRoot(root);
  return trip;
}

export async function deleteTrip(tripId) {
  const root = await readRoot();
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
  await writeRoot(root);
}

export async function clearTrip(tripId) {
  const root = await readRoot();
  const trip = root.trips[tripId];
  if (!trip) return;
  trip.places = [];
  trip.updatedAt = Date.now();
  await writeRoot(root);
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
      if (dLat < 1e-5 && dLng < 1e-5) return true;
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

export async function addPlace(input, { tripId } = {}) {
  const root = await readRoot();
  const trip = tripId
    ? root.trips[tripId]
    : root.trips[root.activeTripId] || Object.values(root.trips)[0];
  if (!trip) throw new Error("No trip to add to");

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
  trip.updatedAt = Date.now();
  await writeRoot(root);
  return { added: true, place, trip };
}

export async function addPlaces(inputs, opts = {}) {
  const results = [];
  for (const input of inputs) {
    results.push(await addPlace(input, opts));
  }
  return results;
}

export async function removePlace(placeId, { tripId } = {}) {
  const root = await readRoot();
  const trip = tripId
    ? root.trips[tripId]
    : root.trips[root.activeTripId];
  if (!trip) return;
  const before = trip.places.length;
  trip.places = trip.places.filter((p) => p.id !== placeId);
  if (trip.places.length !== before) {
    trip.updatedAt = Date.now();
    await writeRoot(root);
  }
}

export async function updatePlace(placeId, patch, { tripId } = {}) {
  const root = await readRoot();
  const trip = tripId
    ? root.trips[tripId]
    : root.trips[root.activeTripId];
  if (!trip) return null;
  const place = trip.places.find((p) => p.id === placeId);
  if (!place) return null;
  const merged = sanitizePlace({ ...place, ...patch });
  Object.assign(place, merged);
  trip.updatedAt = Date.now();
  await writeRoot(root);
  return place;
}

export async function exportBackup() {
  const root = await readRoot();
  return { version: 1, exportedAt: Date.now(), data: root };
}

export async function importBackup(backup, { merge = false } = {}) {
  if (!backup || !backup.data || !backup.data.trips) {
    throw new Error("Invalid backup file");
  }
  if (!merge) {
    await writeRoot(backup.data);
    return;
  }
  const root = await readRoot();
  for (const [id, trip] of Object.entries(backup.data.trips)) {
    if (root.trips[id]) {
      const existing = root.trips[id];
      for (const p of trip.places || []) {
        if (!isDuplicate(existing.places, p)) {
          existing.places.push({ ...p, id: newId("p") });
        }
      }
      existing.updatedAt = Date.now();
    } else {
      root.trips[id] = trip;
    }
  }
  await writeRoot(root);
}

export { ROOT_KEY };
