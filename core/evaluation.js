function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function safeNumber(n) {
  return Number.isFinite(Number(n)) ? Number(n) : null;
}

function average(nums) {
  if (!nums.length) return null;
  const sum = nums.reduce((acc, n) => acc + n, 0);
  return sum / nums.length;
}

function normalizeBrandToken(token) {
  return (token || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function extractBrandToken(title) {
  const cleaned = normalizeWhitespace(title || "");
  if (!cleaned) return null;
  const tokens = cleaned.split(/\s+/);
  const stop = new Set([
    "mens",
    "men",
    "women",
    "womens",
    "kids",
    "youth",
    "unisex",
    "tshirt",
    "t-shirt",
    "tee",
    "shirt"
  ]);
  for (const token of tokens.slice(0, 3)) {
    const normalized = normalizeBrandToken(token);
    if (!normalized || stop.has(normalized)) continue;
    return normalized;
  }
  return null;
}

function buildMarketContext(candidates) {
  const sorted = (candidates || [])
    .slice()
    .sort((a, b) => (Number(b.reviewsCount || 0) || 0) - (Number(a.reviewsCount || 0) || 0));
  const top10 = sorted.slice(0, 10);

  const prices = top10.map((c) => parsePriceToNumber(c.priceText)).filter((n) => n != null);
  const reviews = top10.map((c) => safeNumber(c.reviewsCount)).filter((n) => n != null);

  const brands = top10
    .map((c) => extractBrandToken(c.title))
    .filter(Boolean);
  const brandCounts = brands.reduce((acc, b) => {
    acc[b] = (acc[b] || 0) + 1;
    return acc;
  }, {});
  const topBrandCount = Object.values(brandCounts).sort((a, b) => b - a)[0] || 0;
  const topBrandShare = brands.length ? topBrandCount / brands.length : 0;

  const primeShare = top10.length ? top10.filter((c) => c.isPrime).length / top10.length : 0;
  const bestSellerShare = top10.length ? top10.filter((c) => c.isBestSeller).length / top10.length : 0;
  const amazonsChoiceShare = top10.length ? top10.filter((c) => c.isAmazonsChoice).length / top10.length : 0;

  return {
    top10: {
      avg_price: average(prices),
      avg_review_count: average(reviews),
      max_review_count: reviews.length ? Math.max(...reviews) : null
    },
    brand_dominance: {
      top_brand_share: Number(topBrandShare.toFixed(2))
    },
    listing_quality: {
      prime_share: Number(primeShare.toFixed(2)),
      best_seller_share: Number(bestSellerShare.toFixed(2)),
      amazons_choice_share: Number(amazonsChoiceShare.toFixed(2))
    }
  };
}

function scoreDemand({ rating, reviewsCount, isBestSeller, isAmazonsChoice }) {
  let score = 4;
  if (rating >= 4.6) score += 3;
  else if (rating >= 4.3) score += 2;
  else if (rating >= 4.0) score += 1;
  else if (rating && rating < 3.8) score -= 2;

  const reviews = safeNumber(reviewsCount) || 0;
  const reviewBoost = clamp(Math.log10(reviews + 1) * 2, 0, 4);
  score += reviewBoost;

  if (isBestSeller) score += 1;
  if (isAmazonsChoice) score += 1;

  return clamp(Math.round(score), 0, 10);
}

function scoreCompetition(marketContext) {
  let score = 7;
  const maxReviews = marketContext?.top10?.max_review_count || 0;
  if (maxReviews > 10000) score -= 4;
  else if (maxReviews > 5000) score -= 3;
  else if (maxReviews > 2000) score -= 2;
  else if (maxReviews > 1000) score -= 1;

  const dominance = marketContext?.brand_dominance?.top_brand_share || 0;
  if (dominance >= 0.4) score -= 2;
  else if (dominance >= 0.25) score -= 1;

  return clamp(score, 0, 10);
}

function scoreMargin(price, cfg) {
  let score = 5;
  const minPrice = safeNumber(cfg?.minPrice);
  if (price != null && minPrice != null) {
    if (price >= minPrice) score += 2;
    else score -= 3;
  }
  if (price != null) {
    if (price >= 18 && price <= 28) score += 2;
    else if (price >= 29 && price <= 35) score += 1;
    else if (price < 15) score -= 2;
  }
  return clamp(score, 0, 10);
}

function scoreDifferentiation(product) {
  const bullets = product.bullets || [];
  const richBullets = bullets.filter((b) => (b || "").length >= 40).length;
  let score = 4 + clamp(richBullets, 0, 4);

  const descriptionLen = (product.description || "").length;
  if (descriptionLen >= 200) score += 1;

  const complaintSignals = /(runs small|fades|shrinks|poor quality|thin material|cheap|low quality|holes|peels)/i;
  const text = [product.title, ...bullets, product.description].join(" ");
  if (complaintSignals.test(text)) score += 2;

  return clamp(score, 0, 10);
}

function scoreRisk(product) {
  let score = 7;
  const ipRisk = /(disney|marvel|nike|adidas|star wars|pokemon|hello kitty|minecraft|lego|harry potter|dc comics|nba|nfl|mlb)/i;
  const text = [product.title, ...(product.bullets || []), product.description || ""].join(" ");
  if (ipRisk.test(text)) score -= 5;

  const nonReturnable = /(non-?returnable|no returns|final sale)/i;
  if (nonReturnable.test(text)) score -= 2;

  if (product.rating != null && product.rating < 3.6) score -= 1;

  return clamp(score, 0, 10);
}

function evaluateProductOpportunity(product, marketContext, cfg) {
  const price = parsePriceToNumber(product.priceText);
  const rating = safeNumber(product.rating);
  const reviewsCount = safeNumber(product.reviewsCount);

  const demand = scoreDemand({
    rating,
    reviewsCount,
    isBestSeller: product.isBestSeller,
    isAmazonsChoice: product.isAmazonsChoice
  });
  const competition = scoreCompetition(marketContext);
  const margin = scoreMargin(price, cfg);
  const differentiation = scoreDifferentiation(product);
  const risk = scoreRisk(product);

  const totalScore = demand + competition + margin + differentiation + risk;

  let verdict = "avoid";
  if (totalScore >= 38 && risk >= 6) verdict = "very_promising";
  else if (totalScore >= 26) verdict = "consider";

  const hasMarket = marketContext?.top10?.avg_price != null || marketContext?.top10?.avg_review_count != null;
  let confidence = "low";
  if (price != null && rating != null && reviewsCount != null && hasMarket) confidence = "high";
  else if (price != null || rating != null || reviewsCount != null) confidence = "medium";

  const key_reasons = [];
  if (demand >= 8) key_reasons.push("Strong demand signals (ratings/reviews/badges).");
  if (competition <= 4) key_reasons.push("Crowded market with high review leaders.");
  if (margin <= 4) key_reasons.push("Price band may limit margins.");
  if (differentiation >= 7) key_reasons.push("Listing hints at differentiation opportunities.");
  if (risk <= 4) key_reasons.push("Potential IP/policy risk detected.");
  if (!key_reasons.length) key_reasons.push("Balanced signals with no strong extremes.");

  const recommended_actions = [];
  if (risk <= 4) recommended_actions.push("Avoid IP-sensitive themes; focus on generic niches.");
  if (differentiation <= 5) recommended_actions.push("Improve design uniqueness and listing content depth.");
  if (margin <= 4) recommended_actions.push("Target price band $18-$28 for healthier margins.");
  if (competition <= 4) recommended_actions.push("Consider sub-niches with lower review leaders.");
  if (!recommended_actions.length) recommended_actions.push("Proceed with validation and sample testing.");

  const tags = [];
  if (product.isBestSeller) tags.push("best_seller");
  if (product.isAmazonsChoice) tags.push("amazons_choice");
  if (marketContext?.brand_dominance?.top_brand_share >= 0.4) tags.push("brand_dominance_high");
  if (risk <= 4) tags.push("risk_flag");
  if (demand >= 8) tags.push("high_demand");

  return {
    asin: product.asin,
    verdict,
    fit: product.productKind || "unknown",
    scores: {
      demand,
      competition,
      margin,
      differentiation,
      risk
    },
    total_score: totalScore,
    confidence,
    key_reasons,
    recommended_actions,
    tags
  };
}
