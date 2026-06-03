// CSV generator targeting Google My Maps' import flow.
//
// My Maps lets users pick which column positions placemarks (the "Address"
// column) and which titles them (the "Name" column). When lat/lng are
// present we still include them so users can choose to position by
// coordinates instead.

import { hasCoords } from "./places.js";

const HEADERS = [
  "Name",
  "Address",
  "Lat",
  "Lng",
  "Category",
  "Notes",
  "SourceURL",
];

function escapeField(value) {
  if (value == null) return "";
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function tripToCsv(trip) {
  const rows = [HEADERS.join(",")];
  for (const place of trip.places || []) {
    rows.push(
      [
        place.name || "",
        place.address || "",
        place.lat == null ? "" : place.lat,
        place.lng == null ? "" : place.lng,
        place.category || "",
        place.notes || "",
        place.sourceUrl || "",
      ]
        .map(escapeField)
        .join(","),
    );
  }
  return rows.join("\r\n") + "\r\n";
}

export function tripToMyMapsAutoImportCsv(trip) {
  const rows = [["Name", "Location", "Category", "Notes", "SourceURL"]];
  let skippedCount = 0;

  for (const place of trip.places || []) {
    const coords = hasCoords(place);
    const address =
      typeof place.address === "string" ? place.address.trim() : "";
    if (!coords && !address) {
      skippedCount += 1;
      continue;
    }

    rows.push([
      place.name || "",
      coords ? `${Number(place.lat)},${Number(place.lng)}` : address,
      place.category || "",
      place.notes || "",
      place.sourceUrl || "",
    ]);
  }

  return {
    csv: rows.map((row) => row.map(escapeField).join(",")).join("\r\n") + "\r\n",
    importedCount: rows.length - 1,
    skippedCount,
  };
}
