import { ADX, ATR, EMA } from 'technicalindicators';
import { OHLCV } from '../providers/MarketProvider.js';

export type MarketRegime = 'TRENDING' | 'SIDEWAYS' | 'VOLATILE';

export interface MarketAnalysis {
  regime: MarketRegime;
  adx: number;
  atr: number;
  trend: 'UP' | 'DOWN' | 'NEUTRAL';
  levels: {
    entry: number;
    stopLoss: number;
    takeProfit: number;
  };
}

export class MarketAnalyzer {
  /**
   * Analyzes the market based on OHLCV data.
   */
  static analyze(klines: OHLCV[], action: 'LONG' | 'SHORT' | null, currentTickerPrice: number): MarketAnalysis {
    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    
    // 1. Calculate ADX (Average Directional Index) for trend strength
    const adxInput = {
      high: highs,
      low: lows,
      close: closes,
      period: 14
    };
    const adxValues = ADX.calculate(adxInput);
    const currentADX = adxValues[adxValues.length - 1]?.adx || 0;

    // 2. Calculate ATR (Average True Range) for volatility
    const atrValues = ATR.calculate({
      high: highs,
      low: lows,
      close: closes,
      period: 14
    });
    const currentATR = atrValues[atrValues.length - 1] || (highs[highs.length-1] - lows[lows.length-1]);

    // 3. Determine Trend (EMA 50 vs EMA 200)
    const ema50 = EMA.calculate({ period: 50, values: closes }).pop() || 0;
    const ema200 = EMA.calculate({ period: 200, values: closes }).pop() || 0;
    
    let trend: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
    if (ema50 > ema200) trend = 'UP';
    if (ema50 < ema200) trend = 'DOWN';

    // Determine Regime
    let regime: MarketRegime = 'SIDEWAYS';
    if (currentADX > 25) {
      regime = 'TRENDING';
    }
    
    // Check for high volatility (e.g., if ATR is 2x its average)
    const avgATR = atrValues.slice(-14).reduce((a, b) => a + b, 0) / 14;
    if (currentATR > avgATR * 1.8) {
      regime = 'VOLATILE';
    }

    // 4. Calculate Entry, SL, TP based on LIVE ticker price instead of lagging kline
    const levels = this.calculateLevels(currentTickerPrice, currentATR, action);

    return {
      regime,
      adx: currentADX,
      atr: currentATR,
      trend,
      levels
    };
  }

  private static calculateLevels(price: number, atr: number, action: 'LONG' | 'SHORT' | null) {
    if (!action) return { entry: price, stopLoss: 0, takeProfit: 0 };

    const slMultiplier = 1.5; // 1.5x ATR for SL
    const tpMultiplier = 3.0; // 3x ATR for TP (2:1 RR)

    if (action === 'LONG') {
      return {
        entry: price,
        stopLoss: price - (atr * slMultiplier),
        takeProfit: price + (atr * tpMultiplier)
      };
    } else {
      return {
        entry: price,
        stopLoss: price + (atr * slMultiplier),
        takeProfit: price - (atr * tpMultiplier)
      };
    }
  }
}
