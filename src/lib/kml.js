// KML 2.2 generator for Google My Maps import.
//
// My Maps' KML importer expects each <Placemark> to carry a <Point> with
// `<coordinates>lng,lat,0</coordinates>` — note the lon-before-lat ordering
// which is the KML standard.

import { hasCoords } from "./places.js";

const XML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function xmlEscape(value) {
  if (value == null) return "";
  return String(value).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

// CDATA can't contain the literal "]]>". The standard trick is to split the
// sequence across two adjacent CDATA blocks so a description containing the
// string survives without being XML-escaped (which would defeat the point of
// wrapping it in CDATA in the first place).
function cdataSafe(value) {
  return String(value).split("]]>").join("]]]]><![CDATA[>");
}

function placemark(place) {
  if (!hasCoords(place)) return "";
  const lat = Number(place.lat);
  const lng = Number(place.lng);

  const descriptionLines = [];
  if (place.address) descriptionLines.push(place.address);
  if (place.category) descriptionLines.push(`Category: ${place.category}`);
  if (place.sourceUrl) descriptionLines.push(`Source: ${place.sourceUrl}`);
  if (place.notes) descriptionLines.push(place.notes);

  const description = descriptionLines.join("\n");

  return [
    "    <Placemark>",
    `      <name>${xmlEscape(place.name || "Untitled place")}</name>`,
    description
      ? `      <description><![CDATA[${cdataSafe(description)}]]></description>`
      : "",
    "      <Point>",
    `        <coordinates>${lng},${lat},0</coordinates>`,
    "      </Point>",
    "    </Placemark>",
  ]
    .filter(Boolean)
    .join("\n");
}

export function tripToKml(trip) {
  const places = (trip.places || []).filter(hasCoords);
  const placemarks = places.map(placemark).filter(Boolean).join("\n");
  const tripName = xmlEscape(trip.name || "TripAnchor");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    "  <Document>",
    `    <name>${tripName}</name>`,
    `    <description>Exported from TripAnchor on ${new Date().toISOString()}</description>`,
    "    <Folder>",
    `      <name>${tripName}</name>`,
    placemarks,
    "    </Folder>",
    "  </Document>",
    "</kml>",
    "",
  ].join("\n");
}

export function countExportable(trip) {
  const total = (trip.places || []).length;
  const withCoordsCount = (trip.places || []).filter(hasCoords).length;
  return {
    total,
    withCoords: withCoordsCount,
    withoutCoords: total - withCoordsCount,
  };
}
