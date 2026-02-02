(() => {
  const products = [];
  document.querySelectorAll("div.s-result-item[data-asin]").forEach(card => {
    const asin = card.getAttribute("data-asin");
    if (!asin) return;

    const title = card.querySelector("h2 a span")?.innerText?.trim() || "";
    const link = card.querySelector("h2 a")?.href?.split("?")[0] || "";
    const imgs = card.querySelector("img")?.src || "";
    const priceTxt = card.querySelector(".a-price .a-offscreen")?.innerText || "";
    const price = parseFloat(priceTxt.replace(/[^\d.]/g,"")) || 0;
    const ratingTxt = card.querySelector(".a-icon-alt")?.innerText || "";
    const rating = parseFloat(ratingTxt.split(" ")[0]) || 0;
    const reviewTxt = card.querySelector("[aria-label*='stars'] ~ span")?.innerText || "";
    const reviewCount = parseInt(reviewTxt.replace(/[^0-9]/g,"")) || 0;
    const bsrBadge = card.querySelector(".zg-badge-text")?.innerText || "";
    const bsr = parseInt(bsrBadge.replace(/[^0-9]/g,"")) || null;

    const score = (rating/5)*0.3 + (reviewCount/500)*0.2 + ((100000 - (bsr||100000))/100000)*0.5;

    products.push({asin, title, link, imgs, price, rating, reviewCount, bsr, score});
  });

  chrome.runtime.sendMessage({ type:"RESULTS_COLLECTED", products });
})();
