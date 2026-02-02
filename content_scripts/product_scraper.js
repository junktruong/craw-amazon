// Runs on https://www.amazon.com/dp/ASIN...

function text(el) {
  return el ? (el.textContent || "").trim() : "";
}

function normalizeBullets(arr) {
  return arr.map((s) => normalizeWhitespace(s)).filter(Boolean);
}

function scrapeTitle() {
  const el = document.querySelector("#productTitle") || document.querySelector("h1#title");
  return normalizeWhitespace(text(el));
}

function scrapeBullets() {
  const items = Array.from(
    document.querySelectorAll("#feature-bullets ul li span.a-list-item")
  ).map((el) => text(el));

  // fallback (some pages)
  const items2 = items.length
    ? items
    : Array.from(document.querySelectorAll("ul.a-unordered-list.a-vertical li")).map((el) => text(el));

  return normalizeBullets(items2).slice(0, 12);
}

function scrapeDescription() {
  // productDescription
  const pd = document.querySelector("#productDescription");
  let t = pd ? normalizeWhitespace(pd.innerText || pd.textContent || "") : "";

  // fallback: aplus
  if (!t) {
    const ap = document.querySelector("#aplus");
    t = ap ? normalizeWhitespace(ap.innerText || ap.textContent || "") : "";
  }

  // fallback: detail bullets
  if (!t) {
    const det = document.querySelector("#detailBullets_feature_div");
    t = det ? normalizeWhitespace(det.innerText || det.textContent || "") : "";
  }

  return t;
}

function scrapeImages() {
  // Common: thumbnails in img tags
  const imgs = new Set();

  // main image block
  for (const img of document.querySelectorAll("#altImages img")) {
    const src = img.getAttribute("src") || img.getAttribute("data-src");
    if (src) imgs.add(src.replace(/_SS\d+_/, "_SL1200_"));
  }

  // fallback: main img
  const main = document.querySelector("#landingImage") || document.querySelector("#imgTagWrapperId img");
  const mainSrc = main?.getAttribute("src") || main?.getAttribute("data-old-hires");
  if (mainSrc) imgs.add(mainSrc);

  // Remove tiny sprite-like
  const out = Array.from(imgs).filter((u) => u.startsWith("http") && !u.includes("sprite"));
  return out.slice(0, 12);
}

function scrapePriceText() {
  const el =
    document.querySelector("#corePriceDisplay_desktop_feature_div .a-offscreen") ||
    document.querySelector("#corePrice_feature_div .a-offscreen") ||
    document.querySelector("span.a-price.a-text-price span.a-offscreen") ||
    document.querySelector("#priceblock_ourprice") ||
    document.querySelector("#priceblock_dealprice");

  return normalizeWhitespace(text(el));
}

function scrapeRatingAndReviews() {
  // rating
  const ratingEl =
    document.querySelector("#acrPopover span.a-icon-alt") ||
    document.querySelector("span[data-hook='rating-out-of-text']") ||
    document.querySelector("i.a-icon-star span.a-icon-alt");

  const ratingText = text(ratingEl);
  const rm = ratingText.match(/([0-9.]+)\s*out of/i);
  const rating = rm ? Number(rm[1]) : null;

  // reviews count
  const reviewsEl =
    document.querySelector("#acrCustomerReviewText") ||
    document.querySelector("span[data-hook='total-review-count']");

  const reviewsText = text(reviewsEl).replace(/,/g, "");
  const cm = reviewsText.match(/([0-9]+)/);
  const reviewsCount = cm ? Number(cm[1]) : null;

  return { rating, reviewsCount };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type !== "SCRAPE_PRODUCT_PAGE") {
        sendResponse({ ok: false, error: "Unsupported message" });
        return;
      }

      // page may still be hydrating
      await new Promise((r) => setTimeout(r, 600));

      const title = scrapeTitle();
      const bullets = scrapeBullets();
      const description = scrapeDescription();
      const images = scrapeImages();
      const priceText = scrapePriceText();
      const { rating, reviewsCount } = scrapeRatingAndReviews();

      // Basic bot-check detection
      const pageText = (document.body?.innerText || "").toLowerCase();
      if (pageText.includes("enter the characters you see below") || pageText.includes("robot check")) {
        sendResponse({ ok: false, error: "Blocked / CAPTCHA detected on product page" });
        return;
      }

      sendResponse({
        ok: true,
        product: {
          title,
          bullets,
          description,
          images,
          priceText,
          rating,
          reviewsCount
        }
      });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;
});
