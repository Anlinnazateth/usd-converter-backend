/**
 * USD Exchange Rate Converter Backend
 *
 * Scrapes USD exchange rates for BRL (Brazil) and ARS (Argentina)
 * from multiple financial sources and provides REST API endpoints.
 */

import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CONFIG = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
  CACHE_TTL_MS: parseInt(process.env.CACHE_TTL_MS || "60000", 10),
  FETCH_TIMEOUT_MS: parseInt(process.env.FETCH_TIMEOUT_MS || "12000", 10),
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000", 10),
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || "100", 10),
};

const VALID_REGIONS = ["br", "ar"];

const SOURCES = {
  ar: [
    "https://dolarhoy.com",
    "https://www.dolarhoy.com",
    "https://www.cronista.com/MercadosOnline/moneda.html?id=ARSB",
    "https://dolarhoy.com/cotizaciondolarblue",
  ],
  br: [
    "https://wise.com/es/currency-converter/brl-to-usd-rate",
    "https://nubank.com.br/taxas-conversao/",
    "https://www.nomadglobal.com",
  ],
};

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
app.use(cors({ origin: CONFIG.CORS_ORIGIN }));
app.use(express.json());
app.set("json spaces", 2);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// ---------------------------------------------------------------------------
// Region validation middleware
// ---------------------------------------------------------------------------
function validateRegion(req, res, next) {
  const region = (req.query.region || "").toLowerCase();
  if (!region) {
    return res.status(400).json({ error: "Missing required parameter: region (br or ar)" });
  }
  if (!VALID_REGIONS.includes(region)) {
    return res.status(400).json({ error: `Invalid region '${region}'. Must be 'br' or 'ar'` });
  }
  req.region = region;
  next();
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
let db;

/** Initialize SQLite database and create quotes table if needed. */
async function initDb() {
  db = await open({
    filename: path.join(__dirname, "quotes.db"),
    driver: sqlite3.Database,
  });
  await db.exec(`CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    buy_price REAL,
    sell_price REAL,
    region TEXT,
    retrieved_at INTEGER
  )`);
}
await initDb();

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
const cache = { region: null, ts: 0, data: null };

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Parse a currency string into a number.
 * Handles both comma-as-decimal (1.234,56) and dot-as-decimal (1,234.56) formats.
 * @param {string|number|null} s - The value to parse.
 * @returns {number|null} Parsed number or null if invalid.
 */
function parseCurrencyNumber(s) {
  if (s == null) return null;
  s = String(s).trim();
  s = s.replace(/[^\d.,\-]/g, "");

  if (s.includes(",") && s.includes(".")) {
    if (s.lastIndexOf(".") < s.lastIndexOf(",")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch an HTML page with browser-like headers.
 * @param {string} url - URL to fetch.
 * @returns {Promise<string|null>} HTML content or null on error.
 */
async function fetchPage(url) {
  try {
    const res = await axios.get(url, {
      timeout: CONFIG.FETCH_TIMEOUT_MS,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.google.com/",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
      },
    });
    return res.data;
  } catch (e) {
    console.warn(`Fetch error [${url}]: ${e.message}`);
    return null;
  }
}

/**
 * Extract buy/sell prices from HTML using CSS selectors and text patterns.
 * @param {string} html - The HTML to parse.
 * @param {string} preferCurrencyCode - Preferred currency code hint.
 * @returns {{buy: number|null, sell: number|null}}
 */
function extractFromHtml(html, preferCurrencyCode) {
  if (!html) return { buy: null, sell: null };

  const $ = cheerio.load(html);
  let buy = null;
  let sell = null;

  // Text pattern matching (Spanish keywords)
  $("*").each((i, el) => {
    if (buy && sell) return;
    const text = $(el).text().replace(/\s+/g, " ").trim().toLowerCase();
    if (!text) return;

    if (!buy && /compra/.test(text)) {
      const m = text.match(/compra[:\s]*([0-9.,]+)/i);
      if (m) buy = parseCurrencyNumber(m[1]);
    }
    if (!sell && /venta|venta:|venta /.test(text)) {
      const m = text.match(/venta[:\s]*([0-9.,]+)/i);
      if (m) sell = parseCurrencyNumber(m[1]);
    }
  });

  // CSS selector fallback
  const trySelectors = (arr) => {
    for (const sel of arr) {
      const t = $(sel).first().text();
      const n = parseCurrencyNumber(t);
      if (n) return n;
    }
    return null;
  };

  buy = buy || trySelectors([".compra", ".buy", ".valor-compra", ".price--buy", ".buy-price"]);
  sell = sell || trySelectors([".venta", ".sell", ".valor-venta", ".price--sell", ".sell-price"]);

  // Regex fallback: "1 USD = X.XX"
  if (!buy || !sell) {
    const bodyText = $("body").text();
    const rx1 = new RegExp(`1\\s*(USD|Dólar|Dolar)\\s*[=:\\-]\\s*([0-9.,]+)`, "i");
    const m1 = bodyText.match(rx1);
    if (m1) {
      const val = parseCurrencyNumber(m1[2]);
      if (!buy) buy = val;
      if (!sell) sell = val;
    }

    // Last resort: extract first numeric values from body
    if (!buy || !sell) {
      const matches = Array.from(
        new Set(bodyText.match(/[0-9]+(?:[.,][0-9]{1,4})?/g) || [])
      ).slice(0, 20);
      const candidates = matches
        .map(parseCurrencyNumber)
        .filter((n) => n && n > 1 && n < 10000);
      if (!buy && candidates.length) buy = candidates[0];
      if (!sell && candidates.length) sell = candidates[1] || candidates[0];
    }
  }

  return { buy, sell };
}

/**
 * Fetch a quote from a single source URL.
 * @param {string} url - Source URL.
 * @param {string} region - Region code.
 * @returns {Promise<{buy_price: number|null, sell_price: number|null, source: string}>}
 */
async function fetchQuoteFromSource(url, region) {
  const html = await fetchPage(url);
  const extracted = extractFromHtml(html, region === "br" ? "BRL" : "ARS");
  return {
    buy_price: extracted.buy,
    sell_price: extracted.sell,
    source: url,
  };
}

/**
 * Get quotes for a region (with caching and DB persistence).
 * @param {string} region - "br" or "ar".
 * @returns {Promise<Array>}
 */
async function getQuotes(region) {
  region = region.toLowerCase();

  const now = Date.now();
  if (cache.region === region && now - cache.ts < CONFIG.CACHE_TTL_MS && cache.data) {
    return cache.data;
  }

  const sources = SOURCES[region];
  const results = await Promise.all(sources.map((src) => fetchQuoteFromSource(src, region)));

  // Persist to database
  const t = Date.now();
  for (const q of results) {
    await db.run(
      `INSERT INTO quotes (source, buy_price, sell_price, region, retrieved_at) VALUES (?, ?, ?, ?, ?)`,
      [q.source, q.buy_price, q.sell_price, region, t]
    );
  }

  cache.region = region;
  cache.ts = now;
  cache.data = results;
  return results;
}

/**
 * Compute average buy and sell prices from a quotes array.
 * @param {Array} quotes - Array of quote objects.
 * @returns {{average_buy_price: number|null, average_sell_price: number|null}}
 */
function computeAverage(quotes) {
  const buys = quotes.map((q) => q.buy_price).filter((n) => Number.isFinite(n));
  const sells = quotes.map((q) => q.sell_price).filter((n) => Number.isFinite(n));
  const avgBuy = buys.length ? buys.reduce((a, b) => a + b, 0) / buys.length : null;
  const avgSell = sells.length ? sells.reduce((a, b) => a + b, 0) / sells.length : null;
  return {
    average_buy_price: avgBuy !== null ? Number(avgBuy.toFixed(6)) : null,
    average_sell_price: avgSell !== null ? Number(avgSell.toFixed(6)) : null,
  };
}

/**
 * Compute price slippage (deviation from average) for each quote.
 * @param {Array} quotes - Array of quote objects.
 * @param {{average_buy_price: number|null, average_sell_price: number|null}} avg
 * @returns {Array}
 */
function computeSlippage(quotes, avg) {
  return quotes.map((q) => {
    const buy_slip =
      q.buy_price !== null && avg.average_buy_price !== null
        ? Number(((q.buy_price - avg.average_buy_price) / avg.average_buy_price).toFixed(6))
        : null;
    const sell_slip =
      q.sell_price !== null && avg.average_sell_price !== null
        ? Number(((q.sell_price - avg.average_sell_price) / avg.average_sell_price).toFixed(6))
        : null;
    return { source: q.source, buy_price_slippage: buy_slip, sell_price_slippage: sell_slip };
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/quotes", validateRegion, async (req, res, next) => {
  try {
    const quotes = await getQuotes(req.region);
    res.json(
      quotes.map((q) => ({
        buy_price: q.buy_price,
        sell_price: q.sell_price,
        source: q.source,
      }))
    );
  } catch (err) {
    next(err);
  }
});

app.get("/average", validateRegion, async (req, res, next) => {
  try {
    const quotes = await getQuotes(req.region);
    res.json(computeAverage(quotes));
  } catch (err) {
    next(err);
  }
});

app.get("/slippage", validateRegion, async (req, res, next) => {
  try {
    const quotes = await getQuotes(req.region);
    const avg = computeAverage(quotes);
    res.json(computeSlippage(quotes, avg));
  } catch (err) {
    next(err);
  }
});

app.get("/summary", validateRegion, async (req, res, next) => {
  try {
    const quotes = await getQuotes(req.region);
    const avg = computeAverage(quotes);
    const slippage = computeSlippage(quotes, avg);
    res.json({ region: req.region, quotes, average: avg, slippage });
  } catch (err) {
    next(err);
  }
});

app.get("/health", async (req, res) => {
  try {
    await db.get("SELECT 1");
    res.json({ status: "ok", ts: Date.now(), db: "connected" });
  } catch {
    res.status(503).json({ status: "degraded", ts: Date.now(), db: "disconnected" });
  }
});

app.get("/", (req, res) => {
  res.send(`
    <h1>USD Converter Backend</h1>
    <p>Available endpoints:</p>
    <ul>
      <li><a href="/quotes?region=br">/quotes?region=br</a></li>
      <li><a href="/average?region=br">/average?region=br</a></li>
      <li><a href="/slippage?region=br">/slippage?region=br</a></li>
      <li><a href="/summary?region=br">/summary?region=br</a></li>
      <li><a href="/quotes?region=ar">/quotes?region=ar</a></li>
      <li><a href="/average?region=ar">/average?region=ar</a></li>
      <li><a href="/slippage?region=ar">/slippage?region=ar</a></li>
      <li><a href="/summary?region=ar">/summary?region=ar</a></li>
      <li><a href="/health">/health</a></li>
    </ul>
  `);
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.use((err, req, res, _next) => {
  console.error(`Error: ${err.message}`);
  res.status(500).json({ error: "Internal server error" });
});

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------
const server = app.listen(CONFIG.PORT, () => {
  console.log(`USD Converter Backend running on http://localhost:${CONFIG.PORT}`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`${signal} received. Shutting down gracefully...`);
  server.close(async () => {
    if (db) await db.close();
    console.log("Server closed.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------
export { parseCurrencyNumber, computeAverage, computeSlippage, app };
