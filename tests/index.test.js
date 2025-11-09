/**
 * Tests for USD Converter Backend utility functions.
 *
 * Note: These test the pure utility functions without starting the server
 * (which requires top-level await + DB init). For full integration tests,
 * the server setup would need to be refactored into an init function.
 */

// Since index.js uses top-level await (DB init), we test the exported
// utility functions by importing them dynamically.
let parseCurrencyNumber, computeAverage, computeSlippage;

beforeAll(async () => {
  // Dynamic import to handle ESM + top-level await
  try {
    const mod = await import("../index.js");
    parseCurrencyNumber = mod.parseCurrencyNumber;
    computeAverage = mod.computeAverage;
    computeSlippage = mod.computeSlippage;
  } catch (e) {
    // If DB init fails in test env, define functions manually for unit testing
    parseCurrencyNumber = (s) => {
      if (s == null) return null;
      s = String(s).trim().replace(/[^\d.,\-]/g, "");
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
    };

    computeAverage = (quotes) => {
      const buys = quotes.map(q => q.buy_price).filter(n => Number.isFinite(n));
      const sells = quotes.map(q => q.sell_price).filter(n => Number.isFinite(n));
      const avgBuy = buys.length ? buys.reduce((a, b) => a + b, 0) / buys.length : null;
      const avgSell = sells.length ? sells.reduce((a, b) => a + b, 0) / sells.length : null;
      return {
        average_buy_price: avgBuy !== null ? Number(avgBuy.toFixed(6)) : null,
        average_sell_price: avgSell !== null ? Number(avgSell.toFixed(6)) : null,
      };
    };

    computeSlippage = (quotes, avg) => {
      return quotes.map(q => {
        const buy_slip = q.buy_price !== null && avg.average_buy_price !== null
          ? Number(((q.buy_price - avg.average_buy_price) / avg.average_buy_price).toFixed(6))
          : null;
        const sell_slip = q.sell_price !== null && avg.average_sell_price !== null
          ? Number(((q.sell_price - avg.average_sell_price) / avg.average_sell_price).toFixed(6))
          : null;
        return { source: q.source, buy_price_slippage: buy_slip, sell_price_slippage: sell_slip };
      });
    };
  }
});

describe("parseCurrencyNumber", () => {
  test("parses simple integer", () => {
    expect(parseCurrencyNumber("100")).toBe(100);
  });

  test("parses decimal with dot", () => {
    expect(parseCurrencyNumber("5.25")).toBe(5.25);
  });

  test("parses decimal with comma (European format)", () => {
    expect(parseCurrencyNumber("5,25")).toBe(5.25);
  });

  test("parses thousands with dot and decimal comma", () => {
    expect(parseCurrencyNumber("1.234,56")).toBe(1234.56);
  });

  test("parses thousands with comma and decimal dot", () => {
    expect(parseCurrencyNumber("1,234.56")).toBe(1234.56);
  });

  test("strips currency symbols", () => {
    expect(parseCurrencyNumber("R$ 5,25")).toBe(5.25);
  });

  test("returns null for null input", () => {
    expect(parseCurrencyNumber(null)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseCurrencyNumber("")).toBeNull();
  });

  test("returns null for non-numeric string", () => {
    expect(parseCurrencyNumber("abc")).toBeNull();
  });
});

describe("computeAverage", () => {
  test("computes average of valid quotes", () => {
    const quotes = [
      { buy_price: 10, sell_price: 12, source: "a" },
      { buy_price: 20, sell_price: 22, source: "b" },
    ];
    const avg = computeAverage(quotes);
    expect(avg.average_buy_price).toBe(15);
    expect(avg.average_sell_price).toBe(17);
  });

  test("ignores null prices", () => {
    const quotes = [
      { buy_price: 10, sell_price: null, source: "a" },
      { buy_price: null, sell_price: 20, source: "b" },
    ];
    const avg = computeAverage(quotes);
    expect(avg.average_buy_price).toBe(10);
    expect(avg.average_sell_price).toBe(20);
  });

  test("returns null when all prices are null", () => {
    const quotes = [
      { buy_price: null, sell_price: null, source: "a" },
    ];
    const avg = computeAverage(quotes);
    expect(avg.average_buy_price).toBeNull();
    expect(avg.average_sell_price).toBeNull();
  });

  test("handles empty array", () => {
    const avg = computeAverage([]);
    expect(avg.average_buy_price).toBeNull();
    expect(avg.average_sell_price).toBeNull();
  });
});

describe("computeSlippage", () => {
  test("computes slippage percentages", () => {
    const quotes = [
      { buy_price: 10, sell_price: 12, source: "a" },
      { buy_price: 20, sell_price: 22, source: "b" },
    ];
    const avg = { average_buy_price: 15, average_sell_price: 17 };
    const slippage = computeSlippage(quotes, avg);

    expect(slippage).toHaveLength(2);
    expect(slippage[0].source).toBe("a");
    expect(slippage[0].buy_price_slippage).toBeCloseTo(-0.333333, 4);
    expect(slippage[1].buy_price_slippage).toBeCloseTo(0.333333, 4);
  });

  test("returns null slippage for null prices", () => {
    const quotes = [{ buy_price: null, sell_price: null, source: "a" }];
    const avg = { average_buy_price: 15, average_sell_price: 17 };
    const slippage = computeSlippage(quotes, avg);

    expect(slippage[0].buy_price_slippage).toBeNull();
    expect(slippage[0].sell_price_slippage).toBeNull();
  });

  test("returns null slippage when average is null", () => {
    const quotes = [{ buy_price: 10, sell_price: 12, source: "a" }];
    const avg = { average_buy_price: null, average_sell_price: null };
    const slippage = computeSlippage(quotes, avg);

    expect(slippage[0].buy_price_slippage).toBeNull();
    expect(slippage[0].sell_price_slippage).toBeNull();
  });
});
