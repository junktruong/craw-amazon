// Runs on https://www.amazon.com/s?...
// Requires core/normalize.js loaded BEFORE this file (manifest order).

function _text(el) {
  return el ? (el.textContent || "").trim() : "";
}

function pickFirstText(root, selectors) {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    const t = _text(el);
    if (t) return t;
  }
  return "";
}

function pickFirstAttr(root, selectors, attr) {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    const v = el?.getAttribute(attr);
    if (v) return v;
  }
  return "";
}

function parseRatingFromText(s) {
  // ex: "4.5 out of 5 stars"
  const m = (s || "").match(/([0-9.]+)\s*out of/i);
  return m ? Number(m[1]) : null;
}

function parseRating(card) {
  const alt = pickFirstText(card, [
    "i.a-icon-star-small span.a-icon-alt",
    "i.a-icon-star span.a-icon-alt",
    "span.a-icon-alt"
  ]);
  return parseRatingFromText(alt);
}

function parseReviewsCount(card) {
  // Layout mới có thể để số review ở span a-size-base s-underline-text
  const t = pickFirstText(card, [
    "span.a-size-base.s-underline-text",
    "a[href*='customerReviews'] span",
    "span[data-csa-c-func-deps*='reviews']",
    "span.a-size-base"
  ]);

  const m = (t || "").replace(/,/g, "").match(/([0-9]+)/);
  return m ? Number(m[1]) : null;
}

function parsePriceText(card) {
  // Ổn nhất là .a-price .a-offscreen
  const t = pickFirstText(card, [
    ".a-price .a-offscreen",
    "span.a-price-whole",
    "span.a-color-base"
  ]);
  return t || "";
}

const TSHIRT_REGEX = /(t[-\s]?shirt|tshirt|tee)\b/i;
const EXCLUDE_REGEX = /(hoodie|sweatshirt|tank\s*top|long\s*sleeve|pullover|crewneck|sweater|raglan|jersey|mug|poster|sticker|phone\s*case)\b/i;

function isTshirtCandidate(title, cardText) {
  const combined = normalizeWhitespace(`${title || ""} ${cardText || ""}`);
  if (EXCLUDE_REGEX.test(combined)) {
    return { isMatch: false, confidence: 0 };
  }
  if (!TSHIRT_REGEX.test(combined)) {
    return { isMatch: false, confidence: 0 };
  }
  const titleMatch = TSHIRT_REGEX.test(title || "");
  return { isMatch: true, confidence: titleMatch ? 1 : 0.7 };
}

function detectBadges(card) {
  const badgeText = (card.textContent || "").toLowerCase();
  return {
    isPrime: !!card.querySelector("i.a-icon-prime") || badgeText.includes("prime"),
    isBestSeller: badgeText.includes("best seller") || badgeText.includes("bestseller"),
    isAmazonsChoice: badgeText.includes("amazon's choice") || badgeText.includes("amazons choice")
  };
}

function findProductLink(card) {
  // Dựa theo DOM bạn đưa:
  // - link ảnh: a.a-link-normal.s-no-outline href="/dp/ASIN/..."
  // - link title: a.a-link-normal.s-line-clamp-2 ... href="/dp/ASIN/..."
  const href = pickFirstAttr(card, [
    "a.a-link-normal.s-line-clamp-2",
    "a.a-link-normal.s-no-outline",
    "h2 a.a-link-normal",
    "a.a-link-normal"
  ], "href");
  return href || "";
}

function extractAsinFromCard(card) {
  // 1) ưu tiên data-asin nếu có
  const asinAttr = (card.getAttribute("data-asin") || "").trim();
  if (asinAttr) return asinAttr.toUpperCase();

  // 2) từ data-csa-c-item-id="B0...."
  const any = card.querySelector("[data-csa-c-item-id]");
  const itemId = (any?.getAttribute("data-csa-c-item-id") || "").trim();
  if (itemId && /^[A-Z0-9]{10}$/i.test(itemId)) return itemId.toUpperCase();

  // 3) từ href /dp/ASIN
  const href = findProductLink(card);
  const abs = toAbsoluteAmazonUrl(href);
  const asin = extractAsinFromUrl(abs);
  return asin || null;
}

function getCanonicalUrl(card) {
  const href = findProductLink(card);
  const abs = toAbsoluteAmazonUrl(href);
  const asin = extractAsinFromUrl(abs);
  if (asin) return `https://www.amazon.com/dp/${asin}`;
  return abs;
}

function scrapeCards() {
  // Layout cũ:
  const v1 = Array.from(document.querySelectorAll("div.s-result-item[data-asin]"));

  // Layout mới "puis-card-container..." thường nằm trong result item wrapper.
  // Dựa theo DOM bạn gửi: div.puis-card-container ... data-cy="asin-faceout-container"
  const v2 = Array.from(document.querySelectorAll("div[data-cy='asin-faceout-container']"));

  // Một số trang dùng:
  const v3 = Array.from(document.querySelectorAll("div[data-component-type='s-search-result']"));

  // Merge unique by element reference
  const set = new Set([...v1, ...v2, ...v3]);
  // Filter bớt những khối không chứa /dp/
  return Array.from(set).filter((el) => {
    const href = findProductLink(el);
    return href && href.includes("/dp/");
  });
}

function computeNextPageUrlSmart(page) {
  // 1) thử selector Next
  const next =
    document.querySelector("a.s-pagination-next") ||
    document.querySelector("a[aria-label='Go to next page']") ||
    document.querySelector("a[aria-label='Next']") ||
    document.querySelector("a.s-pagination-item.s-pagination-next");

  const href = next?.getAttribute("href");
  if (href) return new URL(href, location.origin).href;

  // 2) fallback: tự build bằng param page
  // Amazon thường dùng param: &page=2
  const u = new URL(location.href);
  u.searchParams.set("page", String(page + 1));
  return u.href;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type !== "SCRAPE_SEARCH_PAGE") {
        sendResponse({ ok: false, error: "Unsupported message" });
        return;
      }

      // Wait for hydration
      await new Promise((r) => setTimeout(r, 800));

      // Nếu bị bot check/captcha
      const bodyText = (document.body?.innerText || "").toLowerCase();
      if (bodyText.includes("robot check") || bodyText.includes("enter the characters you see below")) {
        sendResponse({ ok: false, status: "blocked", error: "Blocked / CAPTCHA detected on search page" });
        return;
      }

      const cards = scrapeCards();

      const candidates = [];
      for (const card of cards) {
        const asin = extractAsinFromCard(card);
        const url = getCanonicalUrl(card);
        if (!asin || !url) continue;

        const title = normalizeWhitespace(
          pickFirstText(card, [
            "a.a-link-normal.s-line-clamp-2 span",
            "h2 a span",
            "h2 span",
            "a.a-link-normal span"
          ])
        );
        const cardText = normalizeWhitespace(card.textContent || "");
        const tshirtCheck = isTshirtCandidate(title, cardText);
        if (!tshirtCheck.isMatch) continue;

        const priceText = parsePriceText(card);
        const rating = parseRating(card);
        const reviewsCount = parseReviewsCount(card);
        const badges = detectBadges(card);

        candidates.push({
          asin,
          url,
          title,
          priceText,
          rating,
          reviewsCount,
          productKind: "tshirt",
          kindConfidence: tshirtCheck.confidence,
          ...badges
        });
      }

      const page = Number(msg?.payload?.page || 1);
      const nextPageUrl = computeNextPageUrlSmart(page);

      sendResponse({
        ok: true,
        candidates,
        nextPageUrl
      });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;
});
