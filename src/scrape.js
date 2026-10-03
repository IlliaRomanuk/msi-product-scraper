const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const { extractRawProduct } = require('./extract');
const {
  cleanText,
  parseNumber,
  parseRatingInfo,
  mapAvailability,
  resolvePrices,
  pickImages,
  normalizeSpecs,
  findSpec,
} = require('./normalize');

const TARGET_URL =
  'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';
const OUTPUT_FILE = path.join(__dirname, '..', 'output', 'product.json');
// Optional: use an installed browser instead of Playwright's Chromium, e.g. BROWSER_CHANNEL=msedge or chrome.
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL?.trim() || undefined;
// Debug option: HEADED=1 shows the browser window. The default is headless, as required.
const HEADLESS = process.env.HEADED !== '1';

/**
 * Headless browsers announce themselves as "HeadlessChrome" in the User-Agent and some
 * stores answer that with HTTP 403. Reuse the browser's own UA string without that marker.
 */
async function getRegularUserAgent(browser) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const userAgent = await page.evaluate(() => navigator.userAgent);
    return userAgent.replace('HeadlessChrome', 'Chrome');
  } finally {
    await context.close();
  }
}

/** Best effort: close the cookie consent banner if it shows up; never fails the run. */
async function dismissCookieBanner(page) {
  try {
    await page
      .locator('button, a, [role="button"]')
      .filter({ hasText: /^\s*Accept\s*$/i })
      .first()
      .click({ timeout: 3_000 });
  } catch {
    /* no banner - nothing to do */
  }
}

async function openProduct(page) {
  const response = await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (response && !response.ok()) {
    const hint = response.status() === 403 ? ' (the site may be blocking automated browsers)' : '';
    throw new Error(`Unexpected HTTP status ${response.status()} for ${TARGET_URL}${hint}`);
  }
  await page.waitForSelector('h1', { timeout: 15_000 });
  await dismissCookieBanner(page);
  // The rating is rendered by a script after load; wait for it, but a product without reviews is fine.
  await page
    .waitForFunction(
      () => /\d/.test(document.querySelector('#average-rating-info')?.textContent || ''),
      null,
      { timeout: 5_000 }
    )
    .catch(() => {});
  // Best effort: let lazy content settle, but don't fail if the site keeps polling.
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

/** Breadcrumb without "Home" and without the current product (the last, non-linked item). */
function buildCategoryTree(crumbs, title) {
  return crumbs
    .map(({ name, url }) => ({ name: cleanText(name), url: url || null }))
    .filter((c) => c.name && !/^home$/i.test(c.name) && c.name !== title);
}

function buildProduct(raw, finalUrl) {
  const title = cleanText(raw.title);
  const specs = normalizeSpecs(raw.specs);
  const categoryTree = buildCategoryTree(raw.crumbs, title);
  const { price, salePrice } = resolvePrices(raw);
  const { imageUrl, additional } = pickImages(raw.images, title, raw.ogImage);
  const ratingInfo = parseRatingInfo(raw.ratingInfo);

  // Brand fallback: <title> is "<brand> <product title>", so the prefix is the brand.
  const brandFromTitle = title && raw.documentTitle?.includes(title)
    ? cleanText(raw.documentTitle.split(title)[0])
    : null;

  return {
    url: finalUrl,
    item_id: cleanText(raw.itemId),
    title,
    brand: cleanText(raw.brand) || brandFromTitle,
    product_category: categoryTree.length ? categoryTree.map((c) => c.name).join(' > ') : null,
    category_tree: categoryTree,
    description: cleanText(raw.description),
    price,
    sale_price: salePrice,
    availability: mapAvailability(raw.availabilityRaw) ?? mapAvailability(raw.rootText),
    image_url: imageUrl,
    additional_image_urls: additional,
    specs,
    star_rating: parseNumber(raw.starRating) ?? ratingInfo.rating,
    review_count: parseNumber(raw.reviewCount) ?? ratingInfo.count,
    gtin: cleanText(raw.gtin) || findSpec(specs, /\b(gtin|upc|ean)\b/i),
    mpn: cleanText(raw.mpn) || findSpec(specs, /manufacturer\s*(part\s*)?(number|no)|\bmpn\b|part\s*number/i),
    scraped_at: new Date().toISOString(),
  };
}

/** Retries once on transient failures (network hiccup, slow load). */
async function withRetry(task, attempts = 2) {
  for (let i = 1; ; i++) {
    try {
      return await task();
    } catch (error) {
      if (i >= attempts) throw error;
      console.warn(`Attempt ${i} failed (${error.message}), retrying...`);
    }
  }
}

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS, channel: BROWSER_CHANNEL });
  try {
    const userAgent = await getRegularUserAgent(browser);
    const context = await browser.newContext({ locale: 'en-US', userAgent });
    const page = await context.newPage();

    await withRetry(() => openProduct(page));
    const raw = await page.evaluate(extractRawProduct);
    const product = buildProduct(raw, page.url());

    if (!product.title) throw new Error('Title not found - page layout may have changed');

    await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(product, null, 2) + '\n', 'utf8');
    console.log(`Saved ${OUTPUT_FILE}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('Scrape failed:', error.message);
  process.exitCode = 1;
});
