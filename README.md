# USD Exchange Rate Converter API

[![Node.js](https://img.shields.io/badge/Node.js-20-green.svg)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-blue.svg)](https://expressjs.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

REST API backend that scrapes USD exchange rates for **BRL** (Brazilian Real) and **ARS** (Argentine Peso) from multiple financial sources. Provides quotes, averages, and price slippage analysis.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/quotes?region=br\|ar` | GET | Raw buy/sell prices from all sources |
| `/average?region=br\|ar` | GET | Average buy and sell prices |
| `/slippage?region=br\|ar` | GET | Price deviation from average per source |
| `/summary?region=br\|ar` | GET | Combined quotes + average + slippage |
| `/health` | GET | Health check with DB connectivity |
| `/` | GET | Homepage with endpoint links |

### Example Response — `/quotes?region=ar`

```json
[
  { "buy_price": 1150.5, "sell_price": 1200.0, "source": "https://dolarhoy.com" },
  { "buy_price": 1145.0, "sell_price": 1195.0, "source": "https://www.dolarhoy.com" }
]
```

## Data Sources

**Argentina (ARS):**
- dolarhoy.com
- cronista.com
- dolarhoy.com/cotizaciondolarblue

**Brazil (BRL):**
- wise.com
- nubank.com.br
- nomadglobal.com

## Tech Stack

- **Runtime:** Node.js 20
- **Framework:** Express.js
- **Scraping:** Axios + Cheerio
- **Database:** SQLite3 (quote history)
- **Caching:** In-memory with configurable TTL

## Installation

```bash
git clone https://github.com/Anlinnazateth/usd-converter-backend.git
cd usd-converter-backend
npm install
```

## Configuration

Copy `.env.example` to `.env` and adjust:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `CORS_ORIGIN` | * | Allowed CORS origins |
| `CACHE_TTL_MS` | 60000 | Cache time-to-live (ms) |
| `FETCH_TIMEOUT_MS` | 12000 | HTTP fetch timeout (ms) |
| `RATE_LIMIT_WINDOW_MS` | 900000 | Rate limit window (ms) |
| `RATE_LIMIT_MAX` | 100 | Max requests per window |

## Usage

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

## Docker

```bash
docker build -t usd-converter .
docker run -p 3000:3000 usd-converter
```

## Running Tests

```bash
npm test
```

## Architecture

```
Request → CORS → Region Validation → Route Handler
                                         ↓
                              Cache Check (60s TTL)
                                    ↓ (miss)
                        Parallel Source Scraping
                                    ↓
                          HTML → Price Extraction
                                    ↓
                          SQLite Persistence + Cache Update
                                    ↓
                              JSON Response
```

## Project Structure

```
usd-converter-backend/
├── index.js            # Main Express app
├── package.json        # Dependencies & scripts
├── .env.example        # Environment variable template
├── .gitignore
├── LICENSE
├── Dockerfile
├── .dockerignore
├── .github/
│   └── workflows/
│       └── ci.yml      # GitHub Actions CI
└── tests/
    └── index.test.js   # Jest tests
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Open a Pull Request

## License

MIT License. See [LICENSE](LICENSE) for details.
