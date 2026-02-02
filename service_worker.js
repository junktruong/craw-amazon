importScripts("core/normalize.js", "core/scoring.js");

const AMAZON_ORIGIN = "https://www.amazon.com";

let lastCandidates = []; // store between calls

function progress(text) {
  chrome.runtime.sendMessage({ type: "PROGRESS", text }).catch(() => {});
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function openOrReuseTab(url) {
  // Reuse existing Amazon tab if possible
  const tabs = await chrome.tabs.query({ url: `${AMAZON_ORIGIN}/*` });
  if (tabs && tabs.length) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { url, active: true });
    return tab.id;
  }
  const tab = await chrome.tabs.create({ url, active: true });
  return tab.id;
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
      // content script not ready yet
      await sleep(250);
    }
  }
  throw new Error("Timeout sending message to tab (content script not ready?)");
}

function buildSearchUrls({ keyword, minPrice }) {
  const q = encodeURIComponent(keyword);
  const low = Number.isFinite(minPrice) && minPrice > 0 ? `&low-price=${encodeURIComponent(String(minPrice))}` : "";

  // Multi-source: newest + featured
  const newest = `${AMAZON_ORIGIN}/s?k=${q}&s=date-desc-rank${low}`;
  const featured = `${AMAZON_ORIGIN}/s?k=${q}&s=featured-rank${low}`;

  return [newest, featured];
}

async function scrapeCandidatesFromSearch({ keyword, minPrice, maxPages }) {
  const urls = buildSearchUrls({ keyword, minPrice });
  const all = new Map(); // asin -> candidate

  for (const baseUrl of urls) {
    progress(`Opening search: ${baseUrl}`);
    const tabId = await openOrReuseTab(baseUrl);
    const ok = await waitForTabComplete(tabId);
    if (!ok) throw new Error("Search page load timeout");

    for (let page = 1; page <= maxPages; page++) {
      progress(`Scraping search page ${page}/${maxPages}...`);
      const resp = await sendToTab(tabId, {
        type: "SCRAPE_SEARCH_PAGE",
        payload: { page },
      });

      if (!resp?.ok) {
        throw new Error(resp?.error || "Search scrape failed");
      }

      for (const c of resp.candidates || []) {
        if (!c?.asin) continue;
        if (!all.has(c.asin)) all.set(c.asin, c);
      }

      if (!resp.nextPageUrl) break;

      await chrome.tabs.update(tabId, { url: resp.nextPageUrl });
      await waitForTabComplete(tabId);
      await sleep(600);
    }
  }

  return Array.from(all.values());
}

async function scrapeProductDetails({ candidates, limit, concurrency }) {
  const picked = candidates.slice(0, limit);
  const results = [];

  // Create a pool of tabs? For simplicity: create N tabs and reuse each.
  const tabIds = [];
  for (let i = 0; i < concurrency; i++) {
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    tabIds.push(tab.id);
  }

  let idx = 0;

  async function worker(tabId, workerNo) {
    while (idx < picked.length) {
      const i = idx++;
      const item = picked[i];
      progress(`Fetching details ${i + 1}/${picked.length} (worker ${workerNo})...`);

      try {
        await chrome.tabs.update(tabId, { url: item.url, active: false });
        await waitForTabComplete(tabId, 35000);
        const resp = await sendToTab(tabId, { type: "SCRAPE_PRODUCT_PAGE" }, 25000);
        if (!resp?.ok) {
          results.push({ ...item, error: resp?.error || "product scrape failed" });
          continue;
        }
        results.push({ ...item, ...resp.product });
        await sleep(450);
      } catch (e) {
        results.push({ ...item, error: String(e?.message || e) });
      }
    }
  }

  await Promise.all(tabIds.map((tid, k) => worker(tid, k + 1)));

  // cleanup tabs
  for (const tid of tabIds) {
    try { await chrome.tabs.remove(tid); } catch {}
  }

  return results;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "START_SEARCH") {
        const cfg = msg.payload;
        const candidates = await scrapeCandidatesFromSearch(cfg);

        // Pre-score (quick) so UI có ranking sơ bộ
        const scored = candidates.map((c) => ({
          ...c,
          score: scoreCandidateQuick(c, { days: cfg.days, minPrice: cfg.minPrice }),
        })).sort((a, b) => (b.score || 0) - (a.score || 0));

        lastCandidates = scored;

        sendResponse({ ok: true, candidates: scored });
        return;
      }

      if (msg?.type === "FETCH_DETAILS") {
        if (!lastCandidates.length) throw new Error("No candidates. Run search first.");

        const { days, minPrice, limit, concurrency } = msg.payload;

        // Pick best quick-scored first
        const picked = lastCandidates
          .slice()
          .sort((a, b) => (b.score || 0) - (a.score || 0));

        const details = await scrapeProductDetails({
          candidates: picked,
          limit,
          concurrency: Math.max(1, Math.min(6, concurrency || 2)),
        });

        const merged = details.map((p) => {
          const finalScore = scoreProductFinal(p, { days, minPrice });
          return { ...p, score: finalScore };
        }).sort((a, b) => (b.score || 0) - (a.score || 0));

        sendResponse({ ok: true, products: merged });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true; // keep async
});
