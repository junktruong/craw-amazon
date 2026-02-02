importScripts("core/normalize.js", "core/evaluation.js");

const AMAZON_ORIGIN = "https://www.amazon.com";

let lastCandidates = [];
let lastMarketContext = null;

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function progress(update) {
  const payload = typeof update === "string" ? { text: update } : update;
  chrome.runtime.sendMessage({ type: "PROGRESS", ...payload }).catch(() => {});
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return true;
    await sleep(250);
  }
  return false;
}

async function sendToTab(tabId, message, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, message);
      return resp;
    } catch (e) {
      await sleep(250);
    }
  }
  throw new Error("Timeout sending message to tab (content script not ready?)");
}

function buildSearchUrls({ keyword, minPrice }) {
  const q = encodeURIComponent(keyword);
  const low = Number.isFinite(minPrice) && minPrice > 0 ? `&low-price=${encodeURIComponent(String(minPrice))}` : "";
  const newest = `${AMAZON_ORIGIN}/s?k=${q}&s=date-desc-rank${low}`;
  const featured = `${AMAZON_ORIGIN}/s?k=${q}&s=featured-rank${low}`;
  return [newest, featured];
}

function isBlockedResponse(resp) {
  const errorText = (resp?.error || "").toLowerCase();
  return resp?.status === "blocked" || errorText.includes("captcha") || errorText.includes("robot check");
}

async function runWithTabPool(urls, concurrency, scrapeFn, options = {}) {
  const results = new Array(urls.length);
  const inflight = new Set();
  let index = 0;
  let done = 0;
  let currentConcurrency = clamp(concurrency, 1, 10);
  let blockedDetected = false;

  const jitter = options.jitter || { min: 150, max: 450 };
  const throttleJitter = options.throttleJitter || { min: 500, max: 1200 };

  async function launch(url, idx) {
    const delay = blockedDetected
      ? randomBetween(throttleJitter.min, throttleJitter.max)
      : randomBetween(jitter.min, jitter.max);
    await sleep(delay);

    let tabId = null;
    let response = null;
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
      const ok = await waitForTabComplete(tabId, options.timeoutMs || 35000);
      if (!ok) {
        response = { ok: false, error: "Tab load timeout" };
      } else {
        response = await scrapeFn({ url, tabId, index: idx });
      }
    } catch (e) {
      response = { ok: false, error: String(e?.message || e) };
    } finally {
      if (tabId != null) {
        try {
          await chrome.tabs.remove(tabId);
        } catch {}
      }
    }

    if (isBlockedResponse(response)) {
      blockedDetected = true;
      currentConcurrency = Math.max(1, Math.ceil(currentConcurrency / 2));
    }

    results[idx] = response;
    done += 1;
    if (options.onProgress) {
      options.onProgress({ done, total: urls.length, currentUrl: url });
    }
  }

  while (index < urls.length || inflight.size) {
    while (index < urls.length && inflight.size < currentConcurrency) {
      const url = urls[index];
      const task = launch(url, index);
      inflight.add(task);
      task.finally(() => inflight.delete(task));
      index += 1;
    }
    if (inflight.size) {
      await Promise.race(inflight);
    }
  }

  return results;
}

async function scrapeCandidatesFromSearch({ keyword, minPrice, maxPages, concurrency }) {
  const urls = buildSearchUrls({ keyword, minPrice });
  const all = new Map();
  const totalPages = urls.length * maxPages;
  let pagesDone = 0;

  const responses = await runWithTabPool(
    urls,
    concurrency,
    async ({ tabId }) => {
      const collected = [];
      let nextPageUrl = null;
      for (let page = 1; page <= maxPages; page++) {
        progress({
          text: `Scraping search page ${page}/${maxPages}...`,
          done: pagesDone,
          total: totalPages,
          phase: "search",
          currentUrl: nextPageUrl || "search"
        });

        const resp = await sendToTab(tabId, {
          type: "SCRAPE_SEARCH_PAGE",
          payload: { page }
        });

        if (!resp?.ok) {
          return { ok: false, status: resp?.status, error: resp?.error || "Search scrape failed" };
        }

        collected.push(...(resp.candidates || []));
        pagesDone += 1;

        if (!resp.nextPageUrl) break;
        nextPageUrl = resp.nextPageUrl;
        await chrome.tabs.update(tabId, { url: resp.nextPageUrl, active: false });
        await waitForTabComplete(tabId);
        await sleep(600);
      }
      return { ok: true, candidates: collected };
    },
    {
      onProgress: ({ done, total, currentUrl }) => {
        progress({
          text: `Search progress ${done}/${total}`,
          done,
          total,
          phase: "search",
          currentUrl
        });
      }
    }
  );

  for (const resp of responses) {
    if (!resp?.ok) continue;
    for (const c of resp.candidates || []) {
      if (!c?.asin) continue;
      if (!all.has(c.asin)) all.set(c.asin, c);
    }
  }

  return Array.from(all.values());
}

async function scrapeProductDetails({ candidates, limit, concurrency }) {
  const picked = candidates.slice(0, limit);
  const urls = picked.map((p) => p.url);
  const byUrl = new Map(picked.map((p) => [p.url, p]));

  const responses = await runWithTabPool(
    urls,
    concurrency,
    async ({ tabId, url }) => {
      progress({
        text: `Fetching product details...`,
        phase: "details",
        currentUrl: url
      });
      const resp = await sendToTab(tabId, { type: "SCRAPE_PRODUCT_PAGE" }, 25000);
      if (!resp?.ok) {
        return { ok: false, status: resp?.status, error: resp?.error || "product scrape failed" };
      }
      return { ok: true, product: resp.product };
    },
    {
      onProgress: ({ done, total, currentUrl }) => {
        progress({
          text: `Details progress ${done}/${total}`,
          done,
          total,
          phase: "details",
          currentUrl
        });
      }
    }
  );

  return responses.map((resp, idx) => {
    const url = urls[idx];
    const base = byUrl.get(url) || {};
    if (!resp?.ok) {
      return { ...base, error: resp?.error, status: resp?.status };
    }
    return { ...base, ...resp.product };
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "START_SEARCH") {
        const cfg = msg.payload;
        const concurrency = clamp(cfg.concurrency || 5, 1, 10);
        const searchConcurrency = Math.min(concurrency, 6);
        const candidates = await scrapeCandidatesFromSearch({
          keyword: cfg.keyword,
          minPrice: cfg.minPrice,
          maxPages: cfg.maxPages,
          concurrency: searchConcurrency
        });

        const marketContext = buildMarketContext(candidates);
        const scored = candidates
          .map((c) => {
            const evalResult = evaluateProductOpportunity(c, marketContext, cfg);
            return { ...c, eval: evalResult, score: evalResult.total_score, verdict: evalResult.verdict };
          })
          .sort((a, b) => (b.score || 0) - (a.score || 0));

        lastCandidates = scored;
        lastMarketContext = marketContext;

        sendResponse({ ok: true, candidates: scored, marketContext });
        return;
      }

      if (msg?.type === "FETCH_DETAILS") {
        if (!lastCandidates.length) throw new Error("No candidates. Run search first.");

        const { limit, concurrency, minPrice } = msg.payload;
        const effectiveConcurrency = clamp(concurrency || 5, 1, 10);

        const picked = lastCandidates
          .slice()
          .sort((a, b) => (b.score || 0) - (a.score || 0));

        const details = await scrapeProductDetails({
          candidates: picked,
          limit,
          concurrency: effectiveConcurrency
        });

        const merged = details
          .filter((p) => p.isTshirt)
          .map((p) => {
            const evalResult = evaluateProductOpportunity(p, lastMarketContext, { minPrice });
            return { ...p, eval: evalResult, score: evalResult.total_score, verdict: evalResult.verdict };
          })
          .sort((a, b) => (b.score || 0) - (a.score || 0));

        sendResponse({ ok: true, products: merged });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;
});
