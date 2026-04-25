# 🚀 SignalEngine — Autonomous Crypto Futures Trading Bot

An autonomous crypto futures trading bot powered by the **SLC Execution Blueprint** (Structure → Level → Confirmation). Dual-engine architecture monitors both **Binance Futures** (via WebSocket) and **CoinSwitch Pro Futures** (via Polling) simultaneously, delivering real-time signals to Discord.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   index.ts                       │
│         (Dual Engine Bootstrapper)               │
├─────────────────┬───────────────────────────────┤
│  CoinSwitch Engine (Polling)  │  Binance Engine (WebSocket)  │
│  ↓ Every 15m poll cycle       │  ↓ Zero-delay candle close   │
├─────────────────┴───────────────────────────────┤
│                 SignalEngine                      │
│  ┌──────────────────────────────────────────┐    │
│  │  1. SLC Strategy (Primary)               │    │
│  │     ├─ Stage 1: 4H Structure (EMA 21/50) │    │
│  │     ├─ Stage 2: 15m Supply/Demand Zones  │    │
│  │     └─ Stage 3: Stochastic (5,3,3)       │    │
│  ├──────────────────────────────────────────┤    │
│  │  2. Price Action Analyzer (Fallback)      │    │
│  │     ├─ Engulfing, Pin Bars, Marubozu     │    │
│  │     └─ 4H Structure gate (anti-conflict) │    │
│  ├──────────────────────────────────────────┤    │
│  │  3. ML Filter (Self-Improvement Brain)    │    │
│  │     └─ SQLite pattern win-rate tracking   │    │
│  └──────────────────────────────────────────┘    │
│            ↓                                     │
│  VirtualTradeTracker (SL/TP/Trailing Management) │
│            ↓                                     │
│  Discord Notifier (Signals / Trades / Results)   │
└─────────────────────────────────────────────────┘
```

## Features

- **SLC Blueprint Strategy** — 3-stage mechanical system based on "Structure → Level → Confirmation"
- **Dual-Engine** — CoinSwitch (polling) + Binance (WebSocket) running simultaneously with separate learning brains
- **Multi-Timeframe Analysis** — 4H macro trend + 15m precision entries
- **Volume-Weighted Zones** — Supply/Demand zones scored by volume (institutional footprint detection)
- **Backtesting Engine** — Replay 3-6 months of historical data through SLC before risking capital
- **Demo Trading** — Place real orders on Binance Testnet using fake USDT (zero risk)
- **Self-Improving ML Filter** — Tracks every virtual trade in SQLite; auto-blacklists setups below 50% win rate after 20 samples
- **Virtual Trade Tracker** — Full lifecycle management: Entry → Breakeven SL → ATR Trailing → Close
- **Risk Management** — Max 3 concurrent trades, zone-based SL, strict 1:2 R:R
- **Rich Discord Embeds** — Professional signals with emoji indicators, section dividers, and trade lifecycle tracking
- **Binance Futures Data** — Open Interest, Funding Rate, real-time WebSocket klines

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript (ESNext) |
| Runtime | Node.js 20+ |
| Database | SQLite (via `sqlite3`) |
| Indicators | `technicalindicators` (EMA, ADX, ATR, Stochastic) |
| WebSocket | `ws` library |
| HTTP | `axios` |
| Crypto Auth | `tweetnacl` (CoinSwitch Ed25519 signing) |
| Notifications | Discord Webhooks |

## Project Structure

```
src/
├── index.ts                    # Entry point — dual engine bootup
├── backtest.ts                 # CLI backtesting entry point
├── engines/
│   ├── SignalEngine.ts         # Core analysis loop + SLC orchestration
│   └── BacktestEngine.ts       # Historical data replay + statistics
├── strategies/
│   └── SLCStrategy.ts          # SLC Blueprint (Structure/Level/Confirmation)
├── providers/
│   ├── MarketProvider.ts       # OHLCV interface contract
│   ├── BinanceProvider.ts      # Binance Futures WebSocket + REST
│   └── CoinSwitchProvider.ts   # CoinSwitch Pro Futures (Ed25519 auth)
├── services/
│   ├── PriceActionAnalyzer.ts  # Candlestick pattern recognition (fallback)
│   ├── MarketAnalyzer.ts       # ADX/ATR regime detection (fallback only)
│   ├── MLAnalyzer.ts           # Win-rate based pattern filter
│   ├── DatabaseManager.ts      # SQLite trade history logging
│   ├── VirtualTradeTracker.ts  # SL/TP/Trailing trade management
│   ├── OrderExecutor.ts        # Binance Futures testnet order placement
│   ├── SymbolService.ts        # Top volume symbol discovery
│   ├── CurrencyService.ts      # USDT formatting
│   └── DiscordNotifier.ts      # Discord webhook sender
```

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your keys:

```env
# CoinSwitch Pro API (Required)
COINSWITCH_API_KEY=your_key
COINSWITCH_SECRET_KEY=your_secret_hex

# Binance Futures API (Optional — public data works without keys)
BINANCE_API_KEY=your_key
BINANCE_SECRET_KEY=your_secret
BINANCE_TESTNET=true              # Set to 'true' for paper trading

# Discord Webhooks — CoinSwitch Channels
DISCORD_SIGNALS_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_TRADES_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_RESULTS_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Discord Webhooks — Binance Channels
BINANCE_SIGNALS_WEBHOOK_URL=https://discord.com/api/webhooks/...
BINANCE_TRADES_WEBHOOK_URL=https://discord.com/api/webhooks/...
BINANCE_RESULTS_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

### 3. Build & Run

```bash
# Compile TypeScript
npx tsc

# Run the bot (live signal monitoring)
node dist/index.js
```

## Backtesting

Before trusting the bot with real signals, validate the SLC strategy against historical data.

### Single Symbol Test

```bash
# Backtest BTCUSDT over 3 months
npx tsc && node dist/backtest.js BTCUSDT 3

# Backtest DOGEUSDT over 6 months  
node dist/backtest.js DOGEUSDT 6
```

### Multi-Symbol Batch Test

```bash
# Test 8 symbols at once (BTC, XRP, DOGE, ADA, BNB, SOL, AVAX, LINK)
node dist/backtest.js --multi 3
```

### Reading Results

```
=======================================================
  📊 BACKTEST REPORT: DOGEUSDT
=======================================================
  Total Trades:          3
  Wins / Losses / BE:    2 / 1 / 0
  Win Rate:              66.7%      ← Above 55% is good
  Total PnL:             +0.99%
  Avg Win:               +0.61%
  Avg Loss:              -0.23%
  Profit Factor:         5.35       ← Above 1.5 is profitable
  Max Drawdown:          -0.23%     ← How much you'd lose at worst
  Max Consec. Losses:    1
=======================================================
```

| Metric | Good | Bad |
|--------|------|-----|
| Win Rate | >55% | <45% |
| Profit Factor | >1.5 | <1.0 |
| Max Drawdown | <5% | >10% |
| Avg Win / Avg Loss | >1.5 | <1.0 |

> **Note:** The SLC strategy is very selective (2-5 trades per symbol per 3 months). This is by design — it only fires when all 3 stages align.

## Demo Trading (Testnet Orders)

Once backtesting looks good, enable demo trading to place real orders with **fake money** on Binance Testnet.

### 1. Get Testnet API Keys

1. Go to [Binance Futures Testnet](https://testnet.binancefuture.com/)
2. Log in with GitHub
3. Go to API Management → Create API key
4. Copy the API Key and Secret Key

### 2. Enable in `.env`

```env
BINANCE_API_KEY=your_testnet_api_key
BINANCE_SECRET_KEY=your_testnet_secret_key
BINANCE_TESTNET=true
ENABLE_TESTNET_ORDERS=true
```

### 3. Run

```bash
npx tsc && node dist/index.js
# Console will show: 🚀 Binance Engine Started. (Testnet Orders ENABLED)
```

### Safety Architecture

```
ENABLE_TESTNET_ORDERS=true + BINANCE_TESTNET=true
→ ✅ Demo orders with fake USDT (safe)

ENABLE_TESTNET_ORDERS=true + BINANCE_TESTNET=false  
→ 🛑 BLOCKED (requires hidden ENABLE_LIVE_ORDERS=true)

ENABLE_TESTNET_ORDERS not set
→ Signals only, no orders placed
```

## How to Train the Bot

The bot uses a **self-improving feedback loop**. Here's how to train it properly:

### Phase 1: Data Collection (First 1-3 Days)
When the bot first starts, it has no historical data. During this phase:
- The ML Filter **approves all signals** (it needs 20+ trades per pattern before filtering)
- Virtual trades are opened, tracked, and closed automatically
- Every trade outcome (WIN/LOSS/BREAKEVEN) is logged to `trade_history.db`
- **Do NOT intervene** — let it collect data naturally

### Phase 2: Pattern Learning (After ~100 Virtual Trades)
After accumulating enough data per pattern+exchange combination:
- The ML Filter starts checking win rates
- Patterns with <50% win rate are **auto-blacklisted**
- Each exchange has its own "brain" (Binance patterns don't pollute CoinSwitch stats)
- The bot gets progressively more selective over time

### Phase 3: Ongoing Self-Improvement
- The bot continuously logs every trade outcome
- As market conditions change, patterns that stop working get filtered out
- New patterns that start working get approved
- **The more it runs, the smarter it gets**

### Training Tips
1. **Run 24/7 for at least 1 week** before trusting signals for real money
2. **Don't restart the database** — `trade_history.db` is the bot's memory
3. **Monitor Discord** — check if SLC signals outperform PA fallback signals
4. **Adjust `MIN_TRADES_FOR_LEARNING`** in `MLAnalyzer.ts` (default: 20) if you want faster/slower filtering
5. **Adjust `MIN_WIN_RATE`** (default: 50%) to be more/less aggressive

## Hosting Requirements

### Recommended: VPS (Virtual Private Server)

The bot needs to run **24/7 with a stable internet connection** to not miss WebSocket candle closes. A VPS is the correct choice.

| Spec | Minimum | Recommended |
|------|---------|-------------|
| **CPU** | 1 vCPU | 2 vCPU |
| **RAM** | 512 MB | 1 GB |
| **Storage** | 1 GB SSD | 5 GB SSD |
| **OS** | Ubuntu 22.04+ | Ubuntu 24.04 LTS |
| **Node.js** | v20+ | v22 LTS |
| **Network** | Stable low-latency | <50ms to Binance |

### Recommended VPS Providers

| Provider | Plan | ~Cost/Month |
|----------|------|-------------|
| **Hetzner** (Best Value) | CX22 | ~€4/mo (~₹380) |
| **Contabo** | VPS S | ~€6/mo (~₹570) |
| **DigitalOcean** | Basic Droplet | $6/mo (~₹500) |
| **AWS Lightsail** | Nano | $5/mo (~₹420) |
| **Oracle Cloud** | Free Tier (ARM) | **Free forever** |

### VPS Setup

```bash
# 1. SSH into your VPS
ssh root@your-vps-ip

# 2. Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Clone your repo
git clone https://github.com/your-user/SignalEngine.git
cd SignalEngine

# 4. Install dependencies & build
npm install
npx tsc

# 5. Create your .env file
cp .env.example .env
nano .env  # Fill in your keys

# 6. Run with PM2 (auto-restart on crash)
npm install -g pm2
pm2 start dist/index.js --name signal-engine
pm2 save
pm2 startup  # Auto-start on VPS reboot
```

### Why NOT a Local PC?
- Your PC goes to sleep / restarts → missed signals
- Your WiFi drops → WebSocket disconnects
- Your IP changes → potential API issues
- A VPS runs 24/7 with 99.9% uptime in a data center

### Why NOT Serverless (Lambda/Vercel)?
- WebSocket connections need persistent processes
- Cold starts add latency to candle close events
- SQLite needs a filesystem (serverless is ephemeral)

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `COINSWITCH_API_KEY` | ✅ | CoinSwitch Pro API key |
| `COINSWITCH_SECRET_KEY` | ✅ | CoinSwitch Pro secret (hex) |
| `BINANCE_API_KEY` | ❌ | Binance Futures API key |
| `BINANCE_SECRET_KEY` | ❌ | Binance Futures secret |
| `BINANCE_TESTNET` | ❌ | `true` for paper trading |
| `ENABLE_TESTNET_ORDERS` | ❌ | `true` to place demo orders on testnet |
| `DISCORD_SIGNALS_WEBHOOK_URL` | ❌ | CoinSwitch signals channel |
| `DISCORD_TRADES_WEBHOOK_URL` | ❌ | CoinSwitch trades channel |
| `DISCORD_RESULTS_WEBHOOK_URL` | ❌ | CoinSwitch results channel |
| `BINANCE_SIGNALS_WEBHOOK_URL` | ❌ | Binance signals channel |
| `BINANCE_TRADES_WEBHOOK_URL` | ❌ | Binance trades channel |
| `BINANCE_RESULTS_WEBHOOK_URL` | ❌ | Binance results channel |

## Discord Channels

The bot uses 3 separate Discord channels per exchange:

| Channel | Purpose | Embed Examples |
|---------|---------|----------------|
| **#signals** | New trade signals | `🎯 SLC SIGNAL — BTC/USDT` with full setup details, SLC checklist, and market data |
| **#trades** | Trade lifecycle | `🎯 TRADE OPENED`, `🛡️ SL → BREAKEVEN`, `📈 TRAILING STOP UPDATED` |
| **#results** | Trade outcomes | `🏆 TRADE CLOSED — WIN (+1.82%)`, `🛑 TRADE CLOSED — LOSS (-0.45%)` |

## License

Private — All Rights Reserved.
