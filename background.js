let openedTabIds = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildSearchUrls(keyword, days) {
  const pages = Math.ceil(days / 7); // proxy days→pages
  const urls = [];
  for (let p = 1; p <= pages; p++) {
    urls.push(`https://www.amazon.com/s?k=${encodeURIComponent(keyword)}&page=${p}`);
  }
  return urls;
}

async function openGroupTabs(urls, delayMs) {
  openedTabIds = [];
  for (const u of urls) {
    const t = await chrome.tabs.create({url: u, active:false});
    openedTabIds.push(t.id);
    await sleep(delayMs);
  }
  try {
    const gid = await chrome.tabs.group({tabIds: openedTabIds});
    await chrome.tabGroups.update(gid, {title:"AMZ Research", collapsed:false});
  } catch (e) {}
  return openedTabIds;
}

async function clearAll() {
  try { await chrome.tabs.remove(openedTabIds); } catch {}
  openedTabIds = [];
  chrome.storage.local.remove(["searchProducts","productDetails"]);
  chrome.runtime.sendMessage({ type:"CLEAR_ALL" });
}

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
  await chrome.sidePanel.setOptions({ tabId: tab.id, path:"sidepanel.html", enabled:true });
});

chrome.runtime.onMessage.addListener(async (msg) => {

  if (msg.type === "START_SEARCH") {
    await chrome.storage.local.set({searchProducts: [], productDetails: []});
    chrome.runtime.sendMessage({ type:"CLEAR_ALL" });

    const {keyword, days, delayMs, maxTabs} = msg.payload;
    const urls = buildSearchUrls(keyword, days).slice(0, maxTabs);
    await openGroupTabs(urls, delayMs);

    // then search results content script runs automatically
  }

  if (msg.type === "RESULTS_COLLECTED") {
    const products = msg.products;
    const top20 = products
      .sort((a,b)=>b.score - a.score)
      .slice(0,20);

    for (const p of top20) {
      await chrome.tabs.create({ url: p.link, active:false });
      await sleep(300);
    }
  }

  if (msg.type === "PRODUCT_DETAIL") {
    const detail = msg.data;
    const stored = (await chrome.storage.local.get("productDetails")).productDetails || [];
    stored.push(detail);
    await chrome.storage.local.set({productDetails: stored});
    chrome.runtime.sendMessage({ type:"UPDATE_DETAILS", details: stored });
  }

  if (msg.type === "CLEAR_TABS") clearAll();

});
