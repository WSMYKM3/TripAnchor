// Entry point injected after src/lib/extractors.js by the popup.
//
// This file is injected as a classic script via chrome.scripting.executeScript
// from src/popup/popup.js. The last evaluated expression becomes the
// InjectionResult returned to the popup, which is why the IIFE returns the
// extraction payload.

(function () {
  if (!globalThis.TripAnchorExtractors) {
    return {
      sourceUrl: location.href,
      sourceTitle: document.title || "",
      candidates: [],
      error: "TripAnchorExtractors not loaded",
    };
  }
  try {
    return globalThis.TripAnchorExtractors.extract();
  } catch (err) {
    return {
      sourceUrl: location.href,
      sourceTitle: document.title || "",
      candidates: [],
      error: String((err && err.message) || err),
    };
  }
})();
