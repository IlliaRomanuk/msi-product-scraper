# MSI Product Page Scraper

Scrapes one MSI US Store product page (MAG Z890 TOMAHAWK WIFI) with Playwright and saves a normalized JSON object to `output/product.json`.

## Run

```bash
npm install
npx playwright install chromium
npm run scrape
```

Requires Node.js 18+. The browser runs headless.

If the Chromium download is blocked or too slow, use an already installed browser instead:

```bash
# Windows cmd
set BROWSER_CHANNEL=msedge
npm run scrape

# macOS / Linux
BROWSER_CHANNEL=chrome npm run scrape
```

If the site answers with HTTP 403, run once with a visible window to see what the browser gets (`HEADED=1`, e.g. `set HEADED=1` on Windows). The default stays headless.

## Structure

```
src/
  scrape.js     # orchestration: open page -> extract -> normalize -> save
  extract.js    # runs in the browser, collects raw values
  normalize.js  # pure helpers: prices, availability, images, specs
output/
  product.json  # result
```

## How data is extracted

Each field uses the most reliable source available, in this order:
JSON-LD structured data -> semantic DOM (breadcrumb list, spec table, `itemprop`, rating element) -> visible text.

- **Title**: the page has several `<h1>` (marketing sections use them too), so the title is the heading whose text equals the last breadcrumb item. That heading is also the anchor for the main product block.
- **Brand**: JSON-LD if present, otherwise the prefix of the page `<title>` before the product name (`MSI MAG Z890 ...` -> `MSI`).
- **Rating**: `#average-rating-info` (e.g. `4.7 (3)`) gives `star_rating` and `review_count`; the script waits for it because it is rendered after load.
- **Prices**: only leaf elements containing just a price are read, inside the main product block. Bundle add-on prices (`+$319.00`), shipping thresholds and "recommended products" prices are ignored. A struck-through price is the regular price, the other one is the sale price. Prices become numbers (`"$259.99"` -> `259.99`).
- **Availability**: mapped to `in_stock` / `out_of_stock` / `pre_order` from schema.org values or the visible button (`Add to cart` / `Notify Me`).
- **Images**: main image is the one whose `alt` equals the title; additional images come from the same folder, de-duplicated across sizes (`1024x1024` vs `400x400`).
- **Description**: taken from the page body. The `<meta name="description">` is not used because it describes a different product on this page.
- **Specs**: all two-column rows of the specification tables. `-` becomes `null`.
- **mpn**: read from the "Manufacturer Number" spec row as shown on the page.
- **Missing data**: fields that are not on the page (e.g. `gtin`, `sale_price` when there is no discount) are `null`, list fields are `[]`. A warning is printed if a key field (title, brand, price, availability, image, specs) comes back empty.

## Error handling

The browser is always closed (`finally`), the page load is retried once, a non-2xx HTTP status is treated as an error, the process exits with code 1 on failure, and the scraper fails loudly if the title cannot be found instead of writing an empty file.
