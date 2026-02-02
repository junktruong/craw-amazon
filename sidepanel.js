const $ = (id) => document.getElementById(id);

const state = {
  candidates: [],
  products: [],
};

function setStatus(text) {
  $("status").textContent = text;
}

function disableButtons(disabled) {
  $("btnSearch").disabled = disabled;
  $("btnFetch").disabled = disabled;
  $("btnCopy").disabled = disabled;
  $("btnClear").disabled = disabled;
}

function renderTable(items) {
  const tbody = $("resultsBody");
  tbody.innerHTML = "";

  items.forEach((p, idx) => {
    const tr = document.createElement("tr");

    const bullets = (p.bullets || []).slice(0, 6).join(" • ");
    const images = (p.images || []).slice(0, 6).join("\n");
    const scores = p.eval?.scores || {};
    const scoreValues = [
      scores.demand,
      scores.competition,
      scores.margin,
      scores.differentiation,
      scores.risk
    ];
    const scoreLine = scoreValues.every((v) => v == null)
      ? ""
      : scoreValues.map((v) => (v ?? "")).join("/");

    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${p.score ?? ""}</td>
      <td>${escapeHtml(p.verdict || p.eval?.verdict || "")}</td>
      <td>${escapeHtml(scoreLine)}</td>
      <td>${escapeHtml(p.asin || "")}</td>
      <td><pre>${escapeHtml(p.title || "")}</pre></td>
      <td>${p.priceText ? escapeHtml(p.priceText) : ""}</td>
      <td>${p.rating ?? ""}</td>
      <td>${p.reviewsCount ?? ""}</td>
      <td><pre>${escapeHtml(bullets)}</pre></td>
      <td><pre>${escapeHtml(p.description || "")}</pre></td>
      <td><pre class="small">${escapeHtml(images)}</pre></td>
      <td>${p.url ? `<a href="${p.url}" target="_blank">open</a>` : ""}</td>
    `;
    tbody.appendChild(tr);
  });
}

function escapeHtml(s) {
  return (s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function toTSV(items) {
  const headers = [
    "total_score",
    "verdict",
    "demand",
    "competition",
    "margin",
    "differentiation",
    "risk",
    "asin",
    "title",
    "bullet1",
    "bullet2",
    "bullet3",
    "bullet4",
    "description",
    "price",
    "rating",
    "reviews",
    "url",
    "image1",
    "image2",
    "image3",
    "image4",
    "image5",
  ];

  const lines = [headers.join("\t")];

  for (const p of items) {
    const bullets = (p.bullets || []);
    const images = (p.images || []);
    const scores = p.eval?.scores || {};
    const row = [
      p.score ?? "",
      p.verdict ?? p.eval?.verdict ?? "",
      scores.demand ?? "",
      scores.competition ?? "",
      scores.margin ?? "",
      scores.differentiation ?? "",
      scores.risk ?? "",
      p.asin ?? "",
      cleanCell(p.title),
      cleanCell(bullets[0]),
      cleanCell(bullets[1]),
      cleanCell(bullets[2]),
      cleanCell(bullets[3]),
      cleanCell(p.description),
      p.priceText ?? "",
      p.rating ?? "",
      p.reviewsCount ?? "",
      p.url ?? "",
      images[0] ?? "",
      images[1] ?? "",
      images[2] ?? "",
      images[3] ?? "",
      images[4] ?? "",
    ];
    lines.push(row.join("\t"));
  }
  return lines.join("\n");
}

function cleanCell(s) {
  return (s || "").replaceAll("\t", " ").replaceAll("\n", " ").trim();
}

async function loadSavedConfig() {
  const cfg = await chrome.storage.local.get(["cfg"]);
  if (cfg.cfg) {
    $("keyword").value = cfg.cfg.keyword ?? "";
    $("days").value = cfg.cfg.days ?? 14;
    $("minPrice").value = cfg.cfg.minPrice ?? 15;
    $("maxPages").value = cfg.cfg.maxPages ?? 3;
    $("fetchLimit").value = cfg.cfg.fetchLimit ?? 30;
    $("concurrency").value = cfg.cfg.concurrency ?? 5;
  }
}

async function saveConfig() {
  const cfg = {
    keyword: $("keyword").value.trim(),
    days: Number($("days").value || 14),
    minPrice: Number($("minPrice").value || 0),
    maxPages: Number($("maxPages").value || 3),
    fetchLimit: Number($("fetchLimit").value || 30),
    concurrency: Number($("concurrency").value || 5),
  };
  await chrome.storage.local.set({ cfg });
  return cfg;
}

$("btnSearch").addEventListener("click", async () => {
  const cfg = await saveConfig();
  if (!cfg.keyword) {
    setStatus("❌ Thiếu keyword.");
    return;
  }

  disableButtons(true);
  setStatus("Searching...");

  const resp = await chrome.runtime.sendMessage({
    type: "START_SEARCH",
    payload: cfg,
  });

  if (!resp?.ok) {
    setStatus(`❌ Search failed: ${resp?.error || "unknown"}`);
    disableButtons(false);
    return;
  }

  state.candidates = resp.candidates || [];
  state.products = []; // reset

  setStatus(`✅ Candidates: ${state.candidates.length}\nBấm Fetch details để lấy title/bullets/desc/images.`);
  renderTable(state.candidates.slice(0, 50));
  disableButtons(false);
});

$("btnFetch").addEventListener("click", async () => {
  const cfg = await saveConfig();
  if (!state.candidates.length) {
    setStatus("❌ Chưa có candidates. Bấm Search trước.");
    return;
  }

  disableButtons(true);
  setStatus("Fetching product details...");

  const resp = await chrome.runtime.sendMessage({
    type: "FETCH_DETAILS",
    payload: {
      days: cfg.days,
      minPrice: cfg.minPrice,
      limit: cfg.fetchLimit,
      concurrency: cfg.concurrency,
    },
  });

  if (!resp?.ok) {
    setStatus(`❌ Fetch failed: ${resp?.error || "unknown"}`);
    disableButtons(false);
    return;
  }

  state.products = resp.products || [];
  setStatus(`✅ Done. Products: ${state.products.length}`);
  renderTable(state.products);
  disableButtons(false);
});

$("btnCopy").addEventListener("click", async () => {
  const items = state.products.length ? state.products : state.candidates;
  if (!items.length) {
    setStatus("❌ Không có dữ liệu để copy.");
    return;
  }
  const tsv = toTSV(items);
  await navigator.clipboard.writeText(tsv);
  setStatus(`✅ Copied TSV (${items.length} rows). Paste vào Google Sheet.`);
});

$("btnClear").addEventListener("click", async () => {
  state.candidates = [];
  state.products = [];
  renderTable([]);
  setStatus("Idle");
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "PROGRESS") {
    setStatus(msg.text || "...");
  }
});

loadSavedConfig();
setStatus("Idle");
