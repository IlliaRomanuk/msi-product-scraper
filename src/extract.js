/**
 * Runs INSIDE the browser via page.evaluate(), so it must be self-contained
 * (no imports, no outer variables). It only collects raw values; all
 * normalization happens in normalize.js.
 *
 * Data source priority: JSON-LD (structured data) -> semantic DOM -> visible text.
 */
function extractRawProduct() {
  // textContent ignores CSS text-transform (innerText would return "INTEL Z890" for a CSS-uppercased "Intel Z890").
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const text = (el) => clean(el?.textContent);
  const isVisible = (el) => el.getClientRects().length > 0;
  const absolute = (url) => {
    try {
      return new URL(url, location.href).href;
    } catch {
      return null;
    }
  };
  const itemprop = (name) => {
    const el = document.querySelector(`[itemprop="${name}"]`);
    return el ? el.getAttribute('content') || text(el) || null : null;
  };
  const metaContent = (sel) => document.querySelector(sel)?.getAttribute('content') || null;

  // ---- 1. Structured data (JSON-LD) -------------------------------------
  const nodes = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      const data = JSON.parse(script.textContent);
      nodes.push(...(Array.isArray(data) ? data : data['@graph'] || [data]));
    } catch {
      /* ignore malformed JSON-LD */
    }
  });
  const ld = nodes.find((n) => [].concat(n['@type']).includes('Product')) || {};
  const offer = [].concat(ld.offers || [])[0] || {};
  const rating = ld.aggregateRating || {};
  const ldBrand = typeof ld.brand === 'string' ? ld.brand : ld.brand?.name;

  // ---- 2. Breadcrumbs ----------------------------------------------------
  const crumbs = [
    ...document.querySelectorAll(
      '[itemtype*="BreadcrumbList"] li, .breadcrumb li, nav[aria-label*="readcrumb" i] li'
    ),
  ].map((li) => ({ name: text(li), url: li.querySelector('a')?.href || null }));
  const lastCrumb = crumbs.length ? crumbs[crumbs.length - 1].name : '';

  // ---- 3. Product title element -----------------------------------------
  // The page has several <h1> (marketing sections use them too), so <h1> alone is not
  // reliable. The product name is the last breadcrumb item (or JSON-LD name):
  // find the heading with exactly that text and use it as the anchor of the main block.
  const wanted = [ld.name, lastCrumb].filter(Boolean).map((s) => clean(s).toLowerCase());
  const heading =
    [...document.querySelectorAll('h1, h2, h3')].find((h) => wanted.includes(text(h).toLowerCase())) || null;
  const title = heading ? text(heading) : lastCrumb || ld.name || text(document.querySelector('h1')) || null;

  // ---- 4. Main product block --------------------------------------------
  // Walk up from the title until the block also contains a price and a buy/notify control.
  let root = heading || document.querySelector('h1');
  while (root && root.parentElement && root !== document.body) {
    const t = root.innerText;
    if (/\$\s?\d/.test(t) && /add to cart|notify me|out of stock/i.test(t)) break;
    root = root.parentElement;
  }
  const scope = root || document;

  // Everything after the "RECOMMENDED FOR YOU" heading belongs to other products - ignore it.
  const recommendedEl = [...scope.querySelectorAll('*')].find(
    (el) => el.children.length === 0 && /^recommended for you$/i.test(clean(el.textContent))
  );
  const beforeRecommended = (el) =>
    !recommendedEl || Boolean(recommendedEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);

  const fullText = root ? root.innerText : '';
  const cut = fullText.search(/RECOMMENDED FOR YOU/i);
  const rootText = cut >= 0 ? fullText.slice(0, cut) : fullText;

  // Price: visible elements whose whole text is a price ("$259.99"), deepest only.
  // Bundle labels "(+$319.00)" and sentences like "over $25" never match.
  const isPrice = (el) => /^\$\s*[\d,]+(\.\d+)?$/.test(clean(el.innerText));
  const isStruck = (el) => {
    for (let n = el; n && n !== scope.parentElement; n = n.parentElement) {
      if (/^(DEL|S|STRIKE)$/.test(n.tagName)) return true;
      if (getComputedStyle(n).textDecorationLine.includes('line-through')) return true;
    }
    return false;
  };
  const prices = [...scope.querySelectorAll('*')]
    .filter((el) => isVisible(el) && beforeRecommended(el) && isPrice(el) && ![...el.children].some(isPrice))
    .map((el) => ({ text: clean(el.innerText), struck: isStruck(el) }));

  // Text fallback for "WAS $229.99 $179.00" when the old price is not visibly struck through.
  const was = rootText
    .replace(/\(\s*\+\s*\$[\d.,]+\s*\)/g, '')
    .match(/WAS\s*\$\s*([\d,]+(?:\.\d+)?)\s*\$\s*([\d,]+(?:\.\d+)?)/i);

  // Availability: buy/notify controls and stock labels inside the main block only.
  const controls = [
    ...scope.querySelectorAll(
      'button, input[type="submit"], input[type="button"], a.btn, [class*="stock" i], [class*="avail" i]'
    ),
  ]
    .filter((el) => isVisible(el) && beforeRecommended(el))
    .map((el) => clean(el.innerText || el.value))
    .join(' | ');

  // Description: first visible paragraph of the main block (hidden modals with shipping/return text are skipped).
  const paragraph = [...scope.querySelectorAll('p')]
    .filter((p) => isVisible(p) && beforeRecommended(p))
    .map((p) => clean(p.innerText))
    .find((t) => t.length > 60);

  const specs = [...document.querySelectorAll('table tr')]
    .map((tr) => {
      const cells = tr.querySelectorAll('th, td');
      if (cells.length !== 2) return null;
      const value = cells[1].innerText
        .split('\n')
        .map(clean)
        .filter(Boolean)
        .join('; ');
      return { name: text(cells[0]), value };
    })
    .filter(Boolean);

  // Visible rating, e.g. "4.7 (3)" = average rating and number of reviews.
  const ratingInfo = text(document.querySelector('#average-rating-info')) || null;

  // Lazy-loaded images keep the real URL in data-src and a data: placeholder in src.
  const images = [...document.images].map((img) => ({
    src: [img.dataset.src, img.currentSrc, img.src]
      .map((u) => (u && !u.startsWith('data:') ? absolute(u) : null))
      .find(Boolean) || null,
    alt: img.alt,
  }));

  return {
    itemId: ld.sku || ld.productID || document.querySelector('input[name="product_id"]')?.value || null,
    title,
    brand: ldBrand || itemprop('brand') || null,
    documentTitle: document.title,
    // NOTE: <meta name="description"> is intentionally not used - on this page it
    // describes a different board (Z890 GAMING PLUS WIFI).
    description: paragraph || itemprop('description') || ld.description || null,
    crumbs,
    prices,
    was: was ? { regular: was[1], sale: was[2] } : null,
    ldPrice: offer.price ?? offer.lowPrice ?? null,
    availabilityRaw: offer.availability || controls,
    rootText,
    ogImage: metaContent('meta[property="og:image"]'),
    images,
    specs,
    ratingInfo,
    starRating: rating.ratingValue ?? itemprop('ratingValue'),
    reviewCount: rating.reviewCount ?? rating.ratingCount ?? itemprop('reviewCount'),
    gtin: ld.gtin || ld.gtin13 || ld.gtin12 || ld.gtin14 || ld.gtin8 || null,
    mpn: ld.mpn || null,
  };
}

module.exports = { extractRawProduct };
