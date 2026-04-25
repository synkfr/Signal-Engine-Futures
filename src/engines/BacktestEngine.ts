import axios from 'axios';
import { OHLCV } from '../providers/MarketProvider.js';
import { SLCStrategy, SLCResult } from '../strategies/SLCStrategy.js';
import { ATR } from 'technicalindicators';

// ============================================================
// BACKTESTING ENGINE
// Replays historical data through the SLC Strategy to validate
// performance before risking any capital.
// ============================================================

interface BacktestTrade {
  symbol: string;
  signal: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
  exitPrice?: number;
  exitTime?: number;
  exitReason?: string;
  pnlPercent?: number;
  outcome?: 'WIN' | 'LOSS' | 'BREAKEVEN';
}

interface BacktestResult {
  symbol: string;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;
  totalPnlPercent: number;
  avgWinPercent: number;
  avgLossPercent: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  maxConsecutiveLosses: number;
  trades: BacktestTrade[];
}

export class BacktestEngine {
  private baseURL = 'https://fapi.binance.com/fapi/v1';

  /**
   * Run a full backtest on a symbol using the SLC Strategy.
   * Fetches historical 4H + 15m klines and replays them chronologically.
   */
  async run(symbol: string, months: number = 3): Promise<BacktestResult> {
    console.log(`\n📊 [Backtest] Starting ${months}-month backtest for ${symbol}...`);
    
    const endTime = Date.now();
    const startTime = endTime - (months * 30 * 24 * 60 * 60 * 1000);

    // Fetch historical data
    console.log(`[Backtest] Fetching 4H klines...`);
    const klines4H = await this.fetchAllKlines(symbol, '4h', startTime, endTime);
    console.log(`[Backtest] Got ${klines4H.length} 4H candles.`);

    console.log(`[Backtest] Fetching 15m klines...`);
    const klines15m = await this.fetchAllKlines(symbol, '15m', startTime, endTime);
    console.log(`[Backtest] Got ${klines15m.length} 15m candles.`);

    if (klines4H.length < 100 || klines15m.length < 200) {
      console.error('[Backtest] Insufficient data for backtest.');
      return this.emptyResult(symbol);
    }

    // Replay candles through SLC Strategy
    const trades = this.replayStrategy(symbol, klines4H, klines15m);
    
    // Calculate statistics
    return this.calculateStats(symbol, trades);
  }

  /**
   * Fetch all klines for a time range, paginating through Binance's 1500 limit.
   */
  private async fetchAllKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<OHLCV[]> {
    const allKlines: OHLCV[] = [];
    let currentStart = startTime;
    
    while (currentStart < endTime) {
      try {
        const response = await axios.get<any>(`${this.baseURL}/klines`, {
          params: { symbol, interval, startTime: currentStart, endTime, limit: 1500 }
        });
        
        if (!response.data || response.data.length === 0) break;

        const batch: OHLCV[] = response.data.map((k: any) => ({
          timestamp: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5])
        }));

        allKlines.push(...batch);
        
        // Move start to after last candle
        currentStart = batch[batch.length - 1].timestamp + 1;
        
        // Rate limit protection
        await new Promise(r => setTimeout(r, 200));
      } catch (e: any) {
        console.error(`[Backtest] Error fetching klines: ${e.message}`);
        break;
      }
    }

    return allKlines;
  }

  /**
   * Replay candles through SLC Strategy chronologically.
   * Simulates walking through the chart candle by candle.
   */
  private replayStrategy(symbol: string, klines4H: OHLCV[], klines15m: OHLCV[]): BacktestTrade[] {
    const trades: BacktestTrade[] = [];
    let activeTrade: BacktestTrade | null = null;

    // We need at least 50 candles of history before we can start analyzing
    const startIdx = 100; // Start after 100 15m candles (25 hours of history)

    for (let i = startIdx; i < klines15m.length; i++) {
      const currentCandle = klines15m[i];
      const currentPrice = currentCandle.close;

      // If there's an active trade, check for SL/TP hit
      if (activeTrade) {
        // Check using candle's high/low to simulate real price movement
        if (activeTrade.signal === 'LONG') {
          if (currentCandle.low <= activeTrade.stopLoss) {
            activeTrade.exitPrice = activeTrade.stopLoss;
            activeTrade.exitTime = currentCandle.timestamp;
            activeTrade.exitReason = 'Stop Loss';
            trades.push({ ...activeTrade });
            activeTrade = null;
            continue;
          }
          if (currentCandle.high >= activeTrade.takeProfit) {
            activeTrade.exitPrice = activeTrade.takeProfit;
            activeTrade.exitTime = currentCandle.timestamp;
            activeTrade.exitReason = 'Take Profit';
            trades.push({ ...activeTrade });
            activeTrade = null;
            continue;
          }
        } else {
          // SHORT
          if (currentCandle.high >= activeTrade.stopLoss) {
            activeTrade.exitPrice = activeTrade.stopLoss;
            activeTrade.exitTime = currentCandle.timestamp;
            activeTrade.exitReason = 'Stop Loss';
            trades.push({ ...activeTrade });
            activeTrade = null;
            continue;
          }
          if (currentCandle.low <= activeTrade.takeProfit) {
            activeTrade.exitPrice = activeTrade.takeProfit;
            activeTrade.exitTime = currentCandle.timestamp;
            activeTrade.exitReason = 'Take Profit';
            trades.push({ ...activeTrade });
            activeTrade = null;
            continue;
          }
        }
        continue; // Trade still active, skip new entry search
      }

      // No active trade — look for new SLC signal
      // Get the 4H candles up to the current 15m candle's time
      const current15mTime = currentCandle.timestamp;
      const relevant4H = klines4H.filter(k => k.timestamp <= current15mTime);
      const relevant15m = klines15m.slice(Math.max(0, i - 200), i); // Last 200 closed 15m candles

      if (relevant4H.length < 50 || relevant15m.length < 50) continue;

      const slcResult = SLCStrategy.analyze(relevant4H, relevant15m);
      if (!slcResult) continue;

      // SLC fired — open a virtual backtest trade
      activeTrade = {
        symbol,
        signal: slcResult.signal,
        entryPrice: slcResult.entry,
        stopLoss: slcResult.stopLoss,
        takeProfit: slcResult.takeProfit,
        entryTime: currentCandle.timestamp,
      };
    }

    // Close any remaining open trade at last price
    if (activeTrade) {
      const lastCandle = klines15m[klines15m.length - 1];
      activeTrade.exitPrice = lastCandle.close;
      activeTrade.exitTime = lastCandle.timestamp;
      activeTrade.exitReason = 'Backtest End';
      trades.push({ ...activeTrade });
    }

    return trades;
  }

  /**
   * Calculate comprehensive backtest statistics.
   */
  private calculateStats(symbol: string, trades: BacktestTrade[]): BacktestResult {
    // Calculate PnL for each trade
    for (const trade of trades) {
      if (!trade.exitPrice) continue;
      if (trade.signal === 'LONG') {
        trade.pnlPercent = ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
      } else {
        trade.pnlPercent = ((trade.entryPrice - trade.exitPrice) / trade.entryPrice) * 100;
      }
      
      if (trade.pnlPercent > 0.05) trade.outcome = 'WIN';
      else if (trade.pnlPercent < -0.05) trade.outcome = 'LOSS';
      else trade.outcome = 'BREAKEVEN';
    }

    const wins = trades.filter(t => t.outcome === 'WIN');
    const losses = trades.filter(t => t.outcome === 'LOSS');
    const breakevens = trades.filter(t => t.outcome === 'BREAKEVEN');

    const totalWinPnl = wins.reduce((sum, t) => sum + (t.pnlPercent || 0), 0);
    const totalLossPnl = losses.reduce((sum, t) => sum + Math.abs(t.pnlPercent || 0), 0);

    const profitFactor = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? Infinity : 0;

    // Max drawdown calculation
    let peak = 0;
    let cumPnl = 0;
    let maxDrawdown = 0;
    for (const trade of trades) {
      cumPnl += trade.pnlPercent || 0;
      if (cumPnl > peak) peak = cumPnl;
      const drawdown = peak - cumPnl;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    // Max consecutive losses
    let maxConsecLosses = 0;
    let currentStreak = 0;
    for (const trade of trades) {
      if (trade.outcome === 'LOSS') {
        currentStreak++;
        if (currentStreak > maxConsecLosses) maxConsecLosses = currentStreak;
      } else {
        currentStreak = 0;
      }
    }

    const result: BacktestResult = {
      symbol,
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      breakevens: breakevens.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      totalPnlPercent: trades.reduce((sum, t) => sum + (t.pnlPercent || 0), 0),
      avgWinPercent: wins.length > 0 ? totalWinPnl / wins.length : 0,
      avgLossPercent: losses.length > 0 ? totalLossPnl / losses.length : 0,
      profitFactor,
      maxDrawdownPercent: maxDrawdown,
      maxConsecutiveLosses: maxConsecLosses,
      trades,
    };

    this.printReport(result);
    return result;
  }

  private printReport(r: BacktestResult) {
    console.log(`\n${'='.repeat(55)}`);
    console.log(`  📊 BACKTEST REPORT: ${r.symbol}`);
    console.log(`${'='.repeat(55)}`);
    console.log(`  Total Trades:          ${r.totalTrades}`);
    console.log(`  Wins / Losses / BE:    ${r.wins} / ${r.losses} / ${r.breakevens}`);
    console.log(`  Win Rate:              ${r.winRate.toFixed(1)}%`);
    console.log(`  Total PnL:             ${r.totalPnlPercent > 0 ? '+' : ''}${r.totalPnlPercent.toFixed(2)}%`);
    console.log(`  Avg Win:               +${r.avgWinPercent.toFixed(2)}%`);
    console.log(`  Avg Loss:              -${r.avgLossPercent.toFixed(2)}%`);
    console.log(`  Profit Factor:         ${r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)}`);
    console.log(`  Max Drawdown:          -${r.maxDrawdownPercent.toFixed(2)}%`);
    console.log(`  Max Consec. Losses:    ${r.maxConsecutiveLosses}`);
    console.log(`${'='.repeat(55)}\n`);
  }

  private emptyResult(symbol: string): BacktestResult {
    return {
      symbol, totalTrades: 0, wins: 0, losses: 0, breakevens: 0,
      winRate: 0, totalPnlPercent: 0, avgWinPercent: 0, avgLossPercent: 0,
      profitFactor: 0, maxDrawdownPercent: 0, maxConsecutiveLosses: 0, trades: [],
    };
  }
}
