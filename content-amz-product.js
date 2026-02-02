(() => {
  function text(sel) { return document.querySelector(sel)?.innerText.trim()||""; }
  function listText(sel) { return [...document.querySelectorAll(sel)].map(el=>el.innerText.trim()); }

  const data = {
    url: location.href,
    title: text("span#productTitle"),
    images: [...document.querySelectorAll("#altImages img")].map(i=>i.src),
    bulletPoints: listText("#feature-bullets ul li"),
    description: text("#productDescription"),
    price: text(".a-price .a-offscreen"),
    rating: text("i.a-icon-star span"),
    reviewCount: text("#acrCustomerReviewText"),
    bsrDetail: text("#productDetails_detailBullets_sections1 th:contains('Best Sellers Rank') + td")
  };

  chrome.runtime.sendMessage({ type:"PRODUCT_DETAIL", data });
})();
