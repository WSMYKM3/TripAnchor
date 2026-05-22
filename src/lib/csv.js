// CSV generator targeting Google My Maps' import flow.
//
// My Maps lets users pick which column positions placemarks (the "Address"
// column) and which titles them (the "Name" column). When lat/lng are
// present we still include them so users can choose to position by
// coordinates instead.

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
