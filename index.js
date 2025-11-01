
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

const app = express();
app.use(cors());
app.use(express.json());
app.set("json spaces", 2);
const PORT = process.env.PORT || 3000;

let db;
async function initDb() {
  db = await open({
    filename: path.join(__dirname, "quotes.db"),
    driver: sqlite3.Database
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

const SOURCES = {
  ar: [
    "https://dolarhoy.com",
    "https://www.dolarhoy.com",
    "https://www.cronista.com/MercadosOnline/moneda.html?id=ARSB",
    "https://dolarhoy.com/cotizaciondolarblue" 
  ],
  br: [
    "https://wise.com/es/currency-converter/brl-to-usd-rate",
    "https://nubank.com.br/taxas-conversao/",
    "https://www.nomadglobal.com"
  ]
};

const cache = {
  region: null,
  ts: 0,
  data: null
};


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
async function fetchPage(url) {
  try {
    const res = await axios.get(url, {
      timeout: 12000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.google.com/",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1"
      },
    });
    return res.data;
  } catch (e) {
    console.warn("⚠️ fetch error:", url, e.message);
    return null;
  }
}


function extractFromHtml(html, preferCurrencyCode) {
  if (!html) return { buy: null, sell: null };

  const $ = cheerio.load(html);

  
  const selectors = [
    "span.compra", ".compra", ".buy", ".value--buy", ".valor-compra",
    "span.venta", ".venta", ".sell", ".value--sell", ".valor-venta",
    ".buy-price", ".sell-price", ".price--buy", ".price--sell"
  ];

  let buy = null, sell = null;


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

  
  if ((!buy || !sell)) {
    const bodyText = $("body").text();
   
    const rx1 = new RegExp(`1\\s*(USD|Dólar|Dolar)\\s*[=:\\-]\\s*([0-9.,]+)`, "i");
    const m1 = bodyText.match(rx1);
    if (m1) {
      const val = parseCurrencyNumber(m1[2]);
      if (!buy) buy = val;
      if (!sell) sell = val;
    }
    
    if ((!buy || !sell)) {
      const matches = Array.from(new Set(bodyText.match(/[0-9]+(?:[.,][0-9]{1,4})?/g) || [])).slice(0, 20);
      const candidates = matches.map(parseCurrencyNumber).filter(n => n && n > 1 && n < 10000);
      if (!buy && candidates.length) buy = candidates[0];
      if (!sell && candidates.length) sell = candidates[1] || candidates[0];
    }
  }

  return { buy, sell };
}


async function fetchQuoteFromSource(url, region) {
  const html = await fetchPage(url);
  const extracted = extractFromHtml(html, region === "br" ? "BRL" : "ARS");

  return {
    buy_price: extracted.buy,
    sell_price: extracted.sell,
    source: url
  };
}


async function getQuotes(region) {
  region = region.toLowerCase();
  if (!["br", "ar"].includes(region)) throw new Error("Invalid region");

 
  const now = Date.now();
  if (cache.region === region && (now - cache.ts) < 60 * 1000 && cache.data) {
    return cache.data;
  }

  const sources = SOURCES[region];
 
  const jobs = sources.map(src => fetchQuoteFromSource(src, region));
  const results = await Promise.all(jobs);

  
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

function computeAverage(quotes) {
  const buys = quotes.map(q => q.buy_price).filter(n => Number.isFinite(n));
  const sells = quotes.map(q => q.sell_price).filter(n => Number.isFinite(n));
  const avgBuy = buys.length ? (buys.reduce((a,b) => a+b,0) / buys.length) : null;
  const avgSell = sells.length ? (sells.reduce((a,b) => a+b,0) / sells.length) : null;
  return { average_buy_price: avgBuy !== null ? Number(avgBuy.toFixed(6)) : null,
           average_sell_price: avgSell !== null ? Number(avgSell.toFixed(6)) : null };
}

function computeSlippage(quotes, avg) {
  return quotes.map(q => {
    const buy_slip = (q.buy_price !== null && avg.average_buy_price !== null)
      ? Number(((q.buy_price - avg.average_buy_price)/avg.average_buy_price).toFixed(6))
      : null;
    const sell_slip = (q.sell_price !== null && avg.average_sell_price !== null)
      ? Number(((q.sell_price - avg.average_sell_price)/avg.average_sell_price).toFixed(6))
      : null;
    return { source: q.source, buy_price_slippage: buy_slip, sell_price_slippage: sell_slip };
  });
}

app.get("/quotes", async (req, res) => {
  try {
    const region = (req.query.region || "ar").toLowerCase();
    if (!["br","ar"].includes(region)) return res.status(400).json({ error: "region must be 'br' or 'ar'" });
    const quotes = await getQuotes(region);
    
    const out = quotes.map(q => ({
      buy_price: q.buy_price,
      sell_price: q.sell_price,
      source: q.source
    }));
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to fetch quotes" });
  }
});



app.get("/average", async (req, res) => {
  try {
    const region = (req.query.region || "ar").toLowerCase();
    if (!["br","ar"].includes(region)) return res.status(400).json({ error: "region must be 'br' or 'ar'" });
    const quotes = await getQuotes(region);
    const avg = computeAverage(quotes);
    res.json(avg);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to compute average" });
  }
});

app.get("/slippage", async (req, res) => {
  try {
    const region = (req.query.region || "ar").toLowerCase();
    if (!["br","ar"].includes(region)) return res.status(400).json({ error: "region must be 'br' or 'ar'" });
    const quotes = await getQuotes(region);
    const avg = computeAverage(quotes);
    const slippage = computeSlippage(quotes, avg);
    res.json(slippage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to compute slippage" });
  }
});

//combined endpoint for convenience 

app.get("/summary", async (req, res) => {
  try {
    const region = (req.query.region || "ar").toLowerCase();
    if (!["br","ar"].includes(region)) return res.status(400).json({ error: "region must be 'br' or 'ar'" });
    const quotes = await getQuotes(region);
    const avg = computeAverage(quotes);
    const slippage = computeSlippage(quotes, avg);
    res.json({ region, quotes, average: avg, slippage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to fetch summary" });
  }
});


app.get("/health", (req, res) => res.json({ status: "ok", ts: Date.now() }));

app.listen(PORT, () => {
  console.log(` USD Converter Backend running on http://localhost:${PORT}`);
  console.log("Available endpoints:");
  console.log(`  http://localhost:${PORT}/quotes?region=br`);
  console.log(`  http://localhost:${PORT}/average?region=br`);
  console.log(`  http://localhost:${PORT}/slippage?region=br`);
  console.log(`  http://localhost:${PORT}/summary?region=br`);

  console.log(`  http://localhost:${PORT}/quotes?region=ar`);
  console.log(`  http://localhost:${PORT}/average?region=ar`);
  console.log(`  http://localhost:${PORT}/slippage?region=ar`);
  console.log(`  http://localhost:${PORT}/summary?region=ar`);
});
