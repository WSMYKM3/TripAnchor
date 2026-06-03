// Shared helpers for place geometry. Kept tiny on purpose — every module that
// touches lat/lng (csv, kml, storage, popup) should agree on what counts as a
// valid coordinate and what tolerance treats two pins as the same place.

// ~1.1 m at the equator. Used both for storage-time duplicate detection and
// for extraction-time dedupe keying.
export const GEO_MATCH_EPS = 1e-5;

export function hasCoords(place) {
  if (!place) return false;
  if (place.lat == null || place.lng == null) return false;
  if (place.lat === "" || place.lng === "") return false;
  const lat = Number(place.lat);
  const lng = Number(place.lng);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

export function coordKey(place) {
  if (!hasCoords(place)) return "";
  return `${Number(place.lat).toFixed(5)},${Number(place.lng).toFixed(5)}`;
}
