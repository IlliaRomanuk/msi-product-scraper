/** Pure helpers: raw strings in, normalized values out. No browser APIs here. */

const cleanText = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
};

/** "$1,299.99" -> 1299.99, anything without digits -> null */
const parseNumber = (value) => {
  if (value === null || value === undefined) return null;
  const match = String(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
};

/** "4.7 (3)" -> { rating: 4.7, count: 3 }; anything else -> nulls. */
const parseRatingInfo = (value) => {
  const match = String(value ?? '').match(/(\d+(?:\.\d+)?)\s*\(\s*(\d[\d,]*)\s*\)/);
  return match
    ? { rating: parseNumber(match[1]), count: parseNumber(match[2]) }
    : { rating: null, count: null };
};

/** Maps schema.org URLs or visible button/status text to our 3 allowed values. */
const mapAvailability = (value) => {
  if (!value) return null;
  const s = String(value).toLowerCase();
  if (/out\s*of\s*stock|sold\s*out|notify me/.test(s)) return 'out_of_stock';
  if (/pre-?order|presale/.test(s)) return 'pre_order';
  if (/in\s*stock|add to cart/.test(s)) return 'in_stock';
  return null;
};

/**
 * Priority: explicit "WAS $old $new" text -> struck-through price in the DOM -> single visible price -> JSON-LD price.
 * domPrices: [{ text: "$259.99", struck: false }, ...] in DOM order.
 */
const resolvePrices = ({ was, prices, ldPrice }) => {
  if (was) return { price: parseNumber(was.regular), salePrice: parseNumber(was.sale) };

  const struck = prices.find((p) => p.struck);
  const current = prices.find((p) => !p.struck);
  if (struck && current) {
    return { price: parseNumber(struck.text), salePrice: parseNumber(current.text) };
  }
  if (current) return { price: parseNumber(current.text), salePrice: null };
  return { price: parseNumber(ldPrice), salePrice: null };
};

/** Same picture in different sizes ("-1-1024x1024.png" / "-1-400x400.png") shares one key. */
const imageKey = (url) => url.replace(/-\d+x\d+(?=\.\w+$)/, '');
const imageDir = (url) => url.slice(0, url.lastIndexOf('/'));

/**
 * Main image = first <img> whose alt matches the product title (fallback: og:image).
 * Additional images = images from the same folder as the main one, de-duplicated by size-less key.
 * Using the folder keeps logos, icons and "recommended products" out of the result.
 */
const pickImages = (images, title, ogImage) => {
  const wanted = (title || '').toLowerCase();
  const main =
    images.find((i) => i.src && wanted && cleanText(i.alt)?.toLowerCase() === wanted)?.src ||
    ogImage ||
    null;
  if (!main) return { imageUrl: null, additional: [] };

  const seen = new Set([imageKey(main)]);
  const additional = [];
  for (const { src } of images) {
    if (!src || imageDir(src) !== imageDir(main)) continue;
    const key = imageKey(src);
    if (seen.has(key)) continue;
    seen.add(key);
    additional.push(src);
  }
  return { imageUrl: main, additional };
};

/** Cleans specs, turns "-" into null and drops exact duplicates (the page may render a table twice). */
const normalizeSpecs = (rawSpecs) => {
  const seen = new Set();
  return rawSpecs
    .map(({ name, value }) => ({
      name: cleanText(name),
      value: value && value.trim() !== '-' ? cleanText(value) : null,
    }))
    .filter((spec) => {
      if (!spec.name) return false;
      const key = `${spec.name}\u0000${spec.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const findSpec = (specs, pattern) => specs.find((s) => pattern.test(s.name))?.value ?? null;

module.exports = {
  cleanText,
  parseNumber,
  parseRatingInfo,
  mapAvailability,
  resolvePrices,
  pickImages,
  normalizeSpecs,
  findSpec,
};
