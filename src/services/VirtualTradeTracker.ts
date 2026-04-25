import { OHLCV } from '../providers/MarketProvider.js';
import { ATR } from 'technicalindicators';

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
  metadata: any; // Pattern, RSI, etc. for logging
}

export class VirtualTradeTracker {
  private activeTrades: Map<string, VirtualTrade> = new Map();
  // Callbacks for external notifications
  public onBreakeven?: (trade: VirtualTrade) => void;
  public onTrailingUpdate?: (trade: VirtualTrade) => void;
  public onClosed?: (trade: VirtualTrade) => void;

  public addTrade(trade: VirtualTrade) {
    if (this.activeTrades.has(trade.symbol)) return; // Only 1 active trade per symbol
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

    // 1. Check for Hard Closure (Stop Loss or Take Profit)
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

    // 2. Check for Breakeven (1:1 R:R)
    const risk = Math.abs(trade.entryPrice - trade.hardSL);
    
    if (trade.status === 'ACTIVE') {
      const oneTo1Target = trade.type === 'LONG' ? trade.entryPrice + risk : trade.entryPrice - risk;
      const isBreakeven = trade.type === 'LONG' ? currentPrice >= oneTo1Target : currentPrice <= oneTo1Target;

      if (isBreakeven) {
        trade.status = 'BREAKEVEN';
        trade.currentSL = trade.entryPrice;
        if (this.onBreakeven) this.onBreakeven(trade);
      }
    }

    // 3. ATR Trailing Logic (if Breakeven or Trailing)
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
