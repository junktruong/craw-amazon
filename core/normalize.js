function normalizeWhitespace(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function extractAsinFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i) || url.match(/\/gp\/product\/([A-Z0-9]{10})(?:[/?]|$)/i);
  return m ? m[1].toUpperCase() : null;
}

function toAbsoluteAmazonUrl(href) {
  if (!href) return null;
  try {
    const u = new URL(href, "https://www.amazon.com");
    // Keep only /dp/ASIN canonical if possible
    const asin = extractAsinFromUrl(u.href);
    if (asin) return `https://www.amazon.com/dp/${asin}`;
    return u.href;
  } catch {
    return null;
  }
}

function parsePriceToNumber(priceText) {
  if (!priceText) return null;
  // $19.99, 19.99, etc.
  const m = priceText.replace(/,/g, "").match(/([0-9]+(\.[0-9]{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
