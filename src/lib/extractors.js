// Place extractors for TripAnchor.
//
// This file is injected into web pages via chrome.scripting.executeScript and
// therefore must NOT use ES module syntax. It exposes its API on
// globalThis.TripAnchorExtractors. The companion content script
// src/content/extract.js calls extract() and returns the result.

(function () {
  if (globalThis.TripAnchorExtractors) return;

  const PLACE_TYPES = new Set([
    "Event",
    "Place",
    "LocalBusiness",
    "Restaurant",
    "FoodEstablishment",
    "Hotel",
    "LodgingBusiness",
    "Resort",
    "BedAndBreakfast",
    "Hostel",
    "Motel",
    "TouristAttraction",
    "TouristDestination",
    "Museum",
    "LandmarksOrHistoricalBuildings",
    "MusicVenue",
    "EventVenue",
    "PerformingArtsTheater",
    "MovieTheater",
    "StadiumOrArena",
    "Park",
    "Beach",
    "AmusementPark",
    "Zoo",
    "Aquarium",
    "ShoppingCenter",
    "Store",
    "BarOrPub",
    "NightClub",
    "CafeOrCoffeeShop",
    "Bakery",
    "IceCreamShop",
    "Winery",
    "Brewery",
  ]);

  function asArray(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
  }

  function typesOf(node) {
    const t = node && node["@type"];
    if (!t) return [];
    return asArray(t).map((x) => String(x));
  }

  function isPlaceLike(node) {
    return typesOf(node).some((t) => PLACE_TYPES.has(t));
  }

  function categoryFor(types) {
    if (!types || !types.length) return "Place";
    if (types.includes("Event")) return "Event";
    if (
      types.includes("Restaurant") ||
      types.includes("FoodEstablishment") ||
      types.includes("BarOrPub") ||
      types.includes("CafeOrCoffeeShop") ||
      types.includes("Bakery") ||
      types.includes("Winery") ||
      types.includes("Brewery") ||
      types.includes("NightClub")
    ) {
      return "Restaurant";
    }
    if (
      types.includes("Hotel") ||
      types.includes("LodgingBusiness") ||
      types.includes("Resort") ||
      types.includes("BedAndBreakfast") ||
      types.includes("Hostel") ||
      types.includes("Motel")
    ) {
      return "Hotel";
    }
    if (
      types.includes("TouristAttraction") ||
      types.includes("TouristDestination") ||
      types.includes("Museum") ||
      types.includes("Park") ||
      types.includes("Beach") ||
      types.includes("AmusementPark") ||
      types.includes("Zoo") ||
      types.includes("Aquarium") ||
      types.includes("LandmarksOrHistoricalBuildings")
    ) {
      return "Attraction";
    }
    return "Place";
  }

  function formatAddress(addr) {
    if (!addr) return "";
    if (typeof addr === "string") return addr.trim();
    if (Array.isArray(addr)) {
      for (const a of addr) {
        const f = formatAddress(a);
        if (f) return f;
      }
      return "";
    }
    const parts = [
      addr.streetAddress,
      addr.addressLocality,
      addr.addressRegion,
      addr.postalCode,
      addr.addressCountry &&
        (typeof addr.addressCountry === "string"
          ? addr.addressCountry
          : addr.addressCountry.name),
    ];
    return parts
      .filter((p) => p && typeof p === "string" && p.trim())
      .map((p) => p.trim())
      .join(", ");
  }

  function readGeo(geo) {
    if (!geo) return { lat: null, lng: null };
    if (Array.isArray(geo)) {
      for (const g of geo) {
        const r = readGeo(g);
        if (r.lat != null && r.lng != null) return r;
      }
      return { lat: null, lng: null };
    }
    const lat = Number(geo.latitude);
    const lng = Number(geo.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    return { lat: null, lng: null };
  }

  function walkJsonLd(root, visit) {
    const seen = new WeakSet();
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      visit(node);
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") walk(value);
      }
    }
    walk(root);
  }

  function readJsonLdNodes() {
    const out = [];
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]',
    );
    for (const script of scripts) {
      const raw = script.textContent && script.textContent.trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        out.push(parsed);
      } catch (err) {
        try {
          const fixed = raw.replace(/,\s*([}\]])/g, "$1");
          out.push(JSON.parse(fixed));
        } catch (_) {
          // ignore unparsable JSON-LD blocks
        }
      }
    }
    return out;
  }

  function candidateFromJsonLdNode(node) {
    const types = typesOf(node);
    const isEvent = types.includes("Event");
    const placeSource = isEvent
      ? node.location || node.eventVenue || node
      : node;
    const placeTypes = isEvent
      ? typesOf(placeSource).concat(types)
      : types;

    let name = "";
    let address = "";
    let lat = null;
    let lng = null;

    if (placeSource && typeof placeSource === "object") {
      name =
        (placeSource.name && String(placeSource.name).trim()) ||
        (node.name && String(node.name).trim()) ||
        "";
      address = formatAddress(placeSource.address || node.address);
      const geo = readGeo(placeSource.geo || node.geo);
      lat = geo.lat;
      lng = geo.lng;
    }

    if (!name && node.name) name = String(node.name).trim();

    if (!name && !address && lat == null) return null;

    return {
      name: name || "Untitled place",
      address,
      lat,
      lng,
      category: categoryFor(placeTypes.length ? placeTypes : types),
      source: "json-ld",
    };
  }

  function collectFromJsonLd() {
    const candidates = [];
    for (const root of readJsonLdNodes()) {
      walkJsonLd(root, (node) => {
        if (!isPlaceLike(node)) return;
        const cand = candidateFromJsonLdNode(node);
        if (cand) candidates.push(cand);
      });
    }
    return candidates;
  }

  function meta(name) {
    const el =
      document.querySelector(`meta[property="${name}"]`) ||
      document.querySelector(`meta[name="${name}"]`);
    return el ? (el.getAttribute("content") || "").trim() : "";
  }

  function pickFirstNumber() {
    for (const value of arguments) {
      if (value == null || value === "") continue;
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function collectFromMeta() {
    const geoPos = (meta("geo.position") || "").split(/[,;]/);
    const icbm = (meta("ICBM") || "").split(/[,;\s]+/).filter(Boolean);
    const lat = pickFirstNumber(
      meta("place:location:latitude"),
      geoPos[0],
      icbm[0],
    );
    const lng = pickFirstNumber(
      meta("place:location:longitude"),
      geoPos[1],
      icbm[1],
    );
    const name = meta("og:title") || document.title || "";
    const address = meta("og:street-address") || meta("geo.placename") || "";
    const hasCoords = lat != null && lng != null;
    if (!hasCoords && !address) return [];
    return [
      {
        name: (name || "Untitled place").trim(),
        address: address.trim(),
        lat: hasCoords ? lat : null,
        lng: hasCoords ? lng : null,
        category: "Place",
        source: "meta",
      },
    ];
  }

  function parseCoordsFromMapsUrl(url) {
    if (!url) return null;
    let m;
    m = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
    m = url.match(/!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/);
    if (m) return { lat: Number(m[2]), lng: Number(m[1]) };
    m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
    m = url.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
    m = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)(?:&|$)/);
    if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
    return null;
  }

  function collectFromMaps() {
    const out = [];
    const seen = new Set();
    const iframes = document.querySelectorAll(
      'iframe[src*="google.com/maps"], iframe[src*="maps.google."]',
    );
    iframes.forEach((iframe) => {
      const coords = parseCoordsFromMapsUrl(iframe.getAttribute("src") || "");
      if (!coords) return;
      const key = `${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        name: meta("og:title") || document.title || "Place from map",
        address: "",
        lat: coords.lat,
        lng: coords.lng,
        category: "Place",
        source: "maps-embed",
      });
    });

    const anchors = document.querySelectorAll(
      'a[href*="google.com/maps"], a[href*="maps.app.goo.gl"], a[href*="goo.gl/maps"]',
    );
    anchors.forEach((a) => {
      const coords = parseCoordsFromMapsUrl(a.getAttribute("href") || "");
      if (!coords) return;
      const key = `${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        name:
          (a.textContent || "").trim() ||
          meta("og:title") ||
          document.title ||
          "Place from map link",
        address: "",
        lat: coords.lat,
        lng: coords.lng,
        category: "Place",
        source: "maps-link",
      });
    });

    return out;
  }

  function dedupe(candidates) {
    const out = [];
    const seen = new Set();
    for (const c of candidates) {
      const key = [
        (c.name || "").trim().toLowerCase(),
        (c.address || "").trim().toLowerCase(),
        c.lat != null ? Number(c.lat).toFixed(5) : "",
        c.lng != null ? Number(c.lng).toFixed(5) : "",
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }

  function rank(candidates) {
    return candidates
      .map((c) => ({
        ...c,
        _score:
          (c.lat != null && c.lng != null ? 4 : 0) +
          (c.address ? 2 : 0) +
          (c.source === "json-ld" ? 2 : 0) +
          (c.source === "maps-embed" ? 1 : 0),
      }))
      .sort((a, b) => b._score - a._score)
      .map(({ _score, ...rest }) => rest);
  }

  function extract() {
    const all = [
      ...collectFromJsonLd(),
      ...collectFromMaps(),
      ...collectFromMeta(),
    ];
    const ranked = rank(dedupe(all));
    return {
      sourceUrl: location.href,
      sourceTitle: document.title || "",
      candidates: ranked,
    };
  }

  globalThis.TripAnchorExtractors = {
    extract,
    _internal: {
      collectFromJsonLd,
      collectFromMeta,
      collectFromMaps,
      formatAddress,
      readGeo,
      parseCoordsFromMapsUrl,
      dedupe,
      rank,
    },
  };
})();
