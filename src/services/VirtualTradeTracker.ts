import { OHLCV } from '../providers/MarketProvider.js';
import { ATR } from 'technicalindicators';
import { DatabaseManager } from './DatabaseManager.js';

// ============================================================
// TRADE TRACKER — Manages active trade lifecycle
// Handles breakeven, trailing stop, MFE/MAE tracking,
// and persists state to SQLite for crash recovery.
// ============================================================

export interface VirtualTrade {
  id: string;
  symbol: string;
  exchange: string;
  type: 'LONG' | 'SHORT';
  entryPrice: number;
  hardSL: number;
  takeProfit: number;
  currentSL: number;
  status: 'ACTIVE' | 'BREAKEVEN' | 'TRAILING' | 'CLOSED';
  closePrice?: number;
  closeReason?: string;
  // Rich tracking
  openedAt?: number;
  maxFavorable?: number;   // Best unrealized PnL % during the trade
  maxAdverse?: number;     // Worst unrealized drawdown % during the trade
  metadata: any;           // SLC context, zone info, stochastic data
}

export class VirtualTradeTracker {
  private activeTrades: Map<string, VirtualTrade> = new Map();

  // Callbacks for external notifications
  public onBreakeven?: (trade: VirtualTrade) => void;
  public onTrailingUpdate?: (trade: VirtualTrade) => void;
  public onClosed?: (trade: VirtualTrade) => void;

  /**
   * Rehydrate trades from database on startup (crash recovery).
   */
  public rehydrate(trades: VirtualTrade[]) {
    for (const trade of trades) {
      if (trade.status !== 'CLOSED') {
        this.activeTrades.set(trade.symbol, trade);
      }
    }
  }

  public addTrade(trade: VirtualTrade) {
    if (this.activeTrades.has(trade.symbol)) return; // Only 1 active trade per symbol
    if (!trade.openedAt) trade.openedAt = Date.now();
    if (!trade.maxFavorable) trade.maxFavorable = 0;
    if (!trade.maxAdverse) trade.maxAdverse = 0;
    this.activeTrades.set(trade.symbol, trade);
  }

  public getActiveTrade(symbol: string): VirtualTrade | undefined {
    return this.activeTrades.get(symbol);
  }

  public getActiveTrades(): VirtualTrade[] {
    return Array.from(this.activeTrades.values());
  }

  public updateMarket(symbol: string, currentPrice: number, klines: OHLCV[]) {
    const trade = this.activeTrades.get(symbol);
    if (!trade || trade.status === 'CLOSED') return;

    // ── Track MFE/MAE (Max Favorable / Adverse Excursion) ──
    let unrealizedPnl = 0;
    if (trade.type === 'LONG') {
      unrealizedPnl = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
    } else {
      unrealizedPnl = ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100;
    }

    if (unrealizedPnl > (trade.maxFavorable || 0)) {
      trade.maxFavorable = unrealizedPnl;
    }
    if (unrealizedPnl < 0 && Math.abs(unrealizedPnl) > (trade.maxAdverse || 0)) {
      trade.maxAdverse = Math.abs(unrealizedPnl);
    }

    // ── 1. Check Hard Closure (Stop Loss or Take Profit) ──
    if (trade.type === 'LONG') {
      if (currentPrice <= trade.currentSL) {
        this.closeTrade(trade, currentPrice, 'Hit Stop Loss');
        return;
      }
      if (currentPrice >= trade.takeProfit) {
        this.closeTrade(trade, currentPrice, 'Hit Take Profit');
        return;
      }
    } else {
      // SHORT
      if (currentPrice >= trade.currentSL) {
        this.closeTrade(trade, currentPrice, 'Hit Stop Loss');
        return;
      }
      if (currentPrice <= trade.takeProfit) {
        this.closeTrade(trade, currentPrice, 'Hit Take Profit');
        return;
      }
    }

    // ── 2. Check for Breakeven (1:1 R:R reached) ──
    const risk = Math.abs(trade.entryPrice - trade.hardSL);
    
    if (trade.status === 'ACTIVE') {
      const oneTo1Target = trade.type === 'LONG' 
        ? trade.entryPrice + risk 
        : trade.entryPrice - risk;
      const isBreakeven = trade.type === 'LONG' 
        ? currentPrice >= oneTo1Target 
        : currentPrice <= oneTo1Target;

      if (isBreakeven) {
        trade.status = 'BREAKEVEN';
        trade.currentSL = trade.entryPrice;
        if (this.onBreakeven) this.onBreakeven(trade);
      }
    }

    // ── 3. ATR Trailing Logic ──
    if (trade.status === 'BREAKEVEN' || trade.status === 'TRAILING') {
      const high = klines.map(k => k.high);
      const low = klines.map(k => k.low);
      const close = klines.map(k => k.close);
      
      const atrValues = ATR.calculate({ high, low, close, period: 14 });
      if (atrValues.length > 0) {
        const currentATR = atrValues[atrValues.length - 1];
        const trailingDistance = currentATR * 1.5;

        let newSL = trade.currentSL;
        
        if (trade.type === 'LONG') {
          const potentialSL = currentPrice - trailingDistance;
          if (potentialSL > trade.currentSL) {
            newSL = potentialSL;
          }
        } else {
          const potentialSL = currentPrice + trailingDistance;
          if (potentialSL < trade.currentSL) {
            newSL = potentialSL;
          }
        }

        if (newSL !== trade.currentSL) {
          trade.currentSL = newSL;
          trade.status = 'TRAILING';
          if (this.onTrailingUpdate) this.onTrailingUpdate(trade);
        }
      }
    }
  }

  private closeTrade(trade: VirtualTrade, price: number, reason: string) {
    trade.status = 'CLOSED';
    trade.closePrice = price;
    trade.closeReason = reason;
    this.activeTrades.delete(trade.symbol);
    if (this.onClosed) this.onClosed(trade);
  }
}
