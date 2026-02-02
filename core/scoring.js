function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function scoreCandidateQuick(c, { days, minPrice }) {
  let score = 0;

  const priceNum = parsePriceToNumber(c.priceText);
  if (priceNum != null && minPrice != null && priceNum < minPrice) score -= 25;
  if (priceNum != null && minPrice != null && priceNum >= minPrice) score += 5;

  const rating = Number(c.rating || 0);
  const reviews = Number(c.reviewsCount || 0);

  if (rating >= 4.3) score += 25;
  else if (rating >= 4.0) score += 15;
  else if (rating >= 3.7) score += 5;
  else score -= 10;

  // log-like boost for reviews, cap 20
  const revBoost = clamp(Math.log10(reviews + 1) * 8, 0, 20);
  score += revBoost;

  if (c.isPrime) score += 8;
  if (c.isBestSeller) score += 14;
  if (c.isAmazonsChoice) score += 10;

  // “days” currently just biases toward “newest source”: handled by search mix; keep small effect
  if (days && days <= 7) score += 2;

  return Math.round(score);
}

function scoreProductFinal(p, { days, minPrice }) {
  let score = scoreCandidateQuick(p, { days, minPrice });

  const title = (p.title || "").toLowerCase();
  if (title.length < 20) score -= 8;

  const bullets = p.bullets || [];
  if (bullets.length >= 4) score += 10;
  if (bullets.length >= 6) score += 3;

  // Longer bullets => usually richer listing
  const richBullets = bullets.filter((b) => (b || "").length >= 40).length;
  score += clamp(richBullets * 2, 0, 10);

  const images = p.images || [];
  if (images.length >= 5) score += 10;
  else if (images.length >= 3) score += 5;
  else score -= 8;

  const descLen = (p.description || "").length;
  if (descLen >= 200) score += 5;

  if (p.error) score -= 30;

  return clamp(Math.round(score), 0, 100);
}
