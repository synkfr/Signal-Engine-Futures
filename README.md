# 🚀 SignalEngine v2 — SLC-Only Crypto Futures Trading Bot

An autonomous crypto futures trading bot powered by the **SLC Execution Blueprint** (Structure → Level → Confirmation). Monitors **Binance Futures** via WebSocket, delivering real-time signals to Discord with self-improving ML filtering.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                   index.ts                        │
│         (Binance Engine Bootstrap)                │
├──────────────────────────────────────────────────┤
│              BinanceProvider (WebSocket)           │
│              ↓ Zero-delay candle close             │
├──────────────────────────────────────────────────┤
│                 SignalEngine v2                    │
│  ┌──────────────────────────────────────────┐    │
│  │  SLC Strategy (ONLY strategy)            │    │
│  │     ├─ Stage 1: 4H Structure (EMA 21/50) │    │
│  │     ├─ Stage 2: 15m Supply/Demand Zones  │    │
│  │     └─ Stage 3: Stochastic (5,3,3)       │    │
│  ├──────────────────────────────────────────┤    │
│  │  ML Filter (Multi-Dimensional Brain)      │    │
│  │     ├─ Pattern win-rate (base)            │    │
│  │     ├─ Volume confidence (+/- bonus)      │    │
│  │     ├─ Session performance (time-of-day)  │    │
│  │     └─ Loss streak protection             │    │
│  └──────────────────────────────────────────┘    │
│            ↓                                      │
│  TradeTracker (SL/TP/Breakeven/Trailing/MFE/MAE)  │
│            ↓                                      │
│  ┌─ DatabaseManager (SQLite) ─────────────────┐  │
│  │  active_trades → crash recovery             │  │
│  │  virtual_trades → ML learning data          │  │
│  └─────────────────────────────────────────────┘  │
│            ↓                                      │
│  Discord Notifier (Signals / Trades / Results)    │
│            ↓                                      │
│  OrderExecutor (Binance Testnet Demo Trading)     │
└──────────────────────────────────────────────────┘
```

## Features

- **SLC-Only Strategy** — 3-stage mechanical system (Structure → Level → Confirmation). No fallback strategies.
- **50 Symbols** — Monitors top 50 Binance Futures pairs by volume
- **Multi-Timeframe** — 4H macro trend + 15m precision entries
- **Volume-Weighted Zones** — Supply/Demand scored by institutional volume (🔥 = 1.5x+ avg)
- **Crash Recovery** — Active trades persist in SQLite; recovers on restart
- **Self-Improving ML** — 4-factor scoring: pattern win rate, volume confidence, session performance, streak protection
- **MFE/MAE Tracking** — Records best and worst unrealized PnL per trade (answers "should I take partial profits?")
- **Demo Trading** — Real orders on Binance Testnet (fake USDT, zero risk)
- **ATR Trailing Stops** — Auto-tightens SL using 1.5x ATR after breakeven
- **Graceful Shutdown** — SIGINT/SIGTERM saves state before exit
- **Exponential Reconnect** — WebSocket reconnection with backoff (5s → 60s max)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript (ESNext) |
| Runtime | Node.js 20+ |
| Database | SQLite (WAL mode) |
| Indicators | `technicalindicators` (EMA, ADX, ATR, Stochastic) |
| WebSocket | `ws` library |
| HTTP | `axios` |
| Notifications | Discord Webhooks |

## Project Structure

```
src/
├── index.ts                    # Entry point — Binance-only bootstrap
├── backtest.ts                 # CLI backtesting entry point
├── engines/
│   ├── SignalEngine.ts         # Core SLC orchestration + trade lifecycle
│   └── BacktestEngine.ts       # Historical data replay + statistics
├── strategies/
│   └── SLCStrategy.ts          # SLC Blueprint (Structure/Level/Confirmation)
├── providers/
│   ├── MarketProvider.ts       # OHLCV interface
│   └── BinanceProvider.ts      # Binance Futures WebSocket + REST
├── services/
│   ├── MLAnalyzer.ts           # Multi-dimensional ML signal filter
│   ├── DatabaseManager.ts      # SQLite (trade history + crash recovery)
│   ├── VirtualTradeTracker.ts  # SL/TP/Trailing/MFE/MAE management
│   ├── OrderExecutor.ts        # Binance testnet order placement
│   ├── SymbolService.ts        # Top-50 volume symbol discovery
│   ├── CurrencyService.ts      # USDT formatting
│   └── DiscordNotifier.ts      # Discord webhook sender
```

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create a `.env` file:

```env
# Binance Futures API
BINANCE_API_KEY=your_testnet_api_key
BINANCE_SECRET_KEY=your_testnet_secret_key
BINANCE_TESTNET=true                  # Use testnet (demo)

# Demo Trading
ENABLE_TESTNET_ORDERS=true            # Place real orders with fake money

# Symbol Count (default: 50)
SYMBOL_COUNT=50

# Discord Webhooks
BINANCE_SIGNALS_WEBHOOK_URL=https://discord.com/api/webhooks/...
BINANCE_TRADES_WEBHOOK_URL=https://discord.com/api/webhooks/...
BINANCE_RESULTS_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

### 3. Build & Run

```bash
npx tsc && node dist/index.js
```

## Backtesting

Validate the SLC strategy against historical data before trusting signals.

### Single Symbol

```bash
npx tsc && node dist/backtest.js BTCUSDT 3    # 3-month backtest
node dist/backtest.js ETHUSDT 6               # 6-month backtest
```

### Multi-Symbol Batch

```bash
node dist/backtest.js --multi 3    # Test 8 symbols over 3 months
```

### Reading Results

```
=======================================================
  📊 BACKTEST REPORT: BTCUSDT
=======================================================
  Total Trades:          12
  Wins / Losses / BE:    7 / 4 / 1
  Win Rate:              58.3%      ← Above 55% is good
  Total PnL:             +4.21%
  Avg Win:               +0.89%
  Avg Loss:              -0.42%
  Profit Factor:         3.71       ← Above 1.5 is profitable
  Max Drawdown:          -1.23%     ← How much you'd lose at worst
  Max Consec. Losses:    2
=======================================================
```

| Metric | Good | Bad |
|--------|------|-----|
| Win Rate | >55% | <45% |
| Profit Factor | >1.5 | <1.0 |
| Max Drawdown | <5% | >10% |
| Avg Win / Avg Loss | >1.5 | <1.0 |

> **Note:** SLC is a sniper strategy. Expect 0-3 signals per day across 50 symbols. This is by design — fewer trades = higher conviction.

## Demo Trading (Testnet)

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
# Output: 🚀 SignalEngine v2 Online
#         [Config] Orders: ✅ Demo Trading ENABLED
```

### Safety Architecture

```
ENABLE_TESTNET_ORDERS=true + BINANCE_TESTNET=true
→ ✅ Demo orders with fake USDT (safe)

ENABLE_TESTNET_ORDERS=true + BINANCE_TESTNET=false  
→ 🛑 BLOCKED (requires ENABLE_LIVE_ORDERS=true)

ENABLE_TESTNET_ORDERS not set
→ Signals only, no orders placed
```

## How the Bot Learns

The bot uses a **self-improving feedback loop** with 4-factor ML scoring:

### Phase 1: Data Collection (First 1-3 Days)
- ML Filter approves all signals (needs 20+ trades per pattern)
- Every trade is logged with rich metadata: zone strength, volume score, stochastic values, session, MFE/MAE
- **Let it run undisturbed** — it's building its knowledge base

### Phase 2: Pattern Learning (After ~100 Trades)
The ML brain starts making decisions based on:

| Factor | What It Does |
|--------|-------------|
| **Pattern Win Rate** | Base approval check (>50%) |
| **Volume Confidence** | Zones with 1.5x+ avg volume get a 5% threshold reduction (more permissive) |
| **Session Performance** | Auto-penalizes time-of-day windows with historically bad results |
| **Streak Protection** | After 3+ consecutive losses, temporarily raises approval threshold |

### Phase 3: Continuous Improvement
- Every trade result updates the ML brain
- Bad patterns get filtered out automatically
- Good sessions get rewarded
- The approval threshold dynamically adjusts per signal

### Training Tips
1. **Run 24/7 for at least 1 week** before trusting results
2. **Never delete `trade_history.db`** — it's the bot's memory
3. **Check `maxFavorable` column** — if trades consistently hit +1.5R before reverting, consider adding partial TP
4. Query the database to see ML insights:
   ```bash
   sqlite3 trade_history.db "SELECT timeOfDay, COUNT(*), 
     ROUND(AVG(CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END)*100,1) as win_rate 
     FROM virtual_trades GROUP BY timeOfDay"
   ```

## Crash Recovery

If the bot crashes or restarts while trades are active:

1. **Active trades are persisted to SQLite** (`active_trades` table)
2. On restart, the bot loads them back into memory
3. SL/TP/trailing management resumes immediately
4. Discord notification: "🔄 Recovered N active trades from last session"

> **Note:** If price blew through SL/TP while the bot was offline, the trade closes at the first available price. For demo trading, Binance testnet SL/TP orders handle this automatically.

## Hosting

### Recommended: VPS (Virtual Private Server)

The bot needs **24/7 uptime** with stable internet for WebSocket connections.

| Spec | Minimum | Recommended |
|------|---------|-------------|
| **CPU** | 1 vCPU | 2 vCPU |
| **RAM** | 512 MB | 1 GB |
| **Storage** | 1 GB SSD | 5 GB SSD |
| **OS** | Ubuntu 22.04+ | Ubuntu 24.04 LTS |
| **Node.js** | v20+ | v22 LTS |

### VPS Providers

| Provider | Plan | ~Cost/Month |
|----------|------|-------------|
| **Hetzner** (Best Value) | CX22 | ~€4/mo (~₹380) |
| **Oracle Cloud** | Free Tier (ARM) | **Free forever** |
| **Contabo** | VPS S | ~€6/mo (~₹570) |
| **DigitalOcean** | Basic Droplet | $6/mo (~₹500) |

### VPS Deploy

```bash
# 1. SSH into VPS
ssh root@your-vps-ip

# 2. Install Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Clone & Setup
git clone https://github.com/your-user/SignalEngine.git
cd SignalEngine && npm install && npx tsc

# 4. Configure
cp .env.example .env && nano .env

# 5. Run with PM2 (auto-restart)
npm install -g pm2
pm2 start dist/index.js --name signal-engine
pm2 save && pm2 startup
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BINANCE_API_KEY` | ✅ | Binance Futures API key (testnet or mainnet) |
| `BINANCE_SECRET_KEY` | ✅ | Binance Futures secret |
| `BINANCE_TESTNET` | ❌ | `true` for demo trading (default: false) |
| `ENABLE_TESTNET_ORDERS` | ❌ | `true` to place orders on testnet |
| `ENABLE_LIVE_ORDERS` | ❌ | `true` to unlock mainnet (DANGER) |
| `SYMBOL_COUNT` | ❌ | Number of top-volume symbols to monitor (default: 50) |
| `BINANCE_SIGNALS_WEBHOOK_URL` | ❌ | Discord signals channel |
| `BINANCE_TRADES_WEBHOOK_URL` | ❌ | Discord trades channel |
| `BINANCE_RESULTS_WEBHOOK_URL` | ❌ | Discord results channel |

## Discord Channels

| Channel | Purpose | Examples |
|---------|---------|---------|
| **#signals** | New SLC signals | `🎯 SLC SIGNAL — BTC/USDT` with checklist, market data |
| **#trades** | Trade lifecycle | `🎯 TRADE OPENED`, `🛡️ BREAKEVEN`, `📈 TRAILING` |
| **#results** | Outcomes | `🏆 WIN (+1.82%)`, `🛑 LOSS (-0.45%)`, `🔄 RECOVERED` |

## License

Private — All Rights Reserved.
