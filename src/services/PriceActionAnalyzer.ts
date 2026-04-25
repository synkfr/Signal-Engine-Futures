import { OHLCV } from '../providers/MarketProvider.js';
import { EMA, SMA } from 'technicalindicators';

export interface PriceActionSetup {
  pattern: string;
  type: 'LONG' | 'SHORT' | 'NEUTRAL';
  context: string[];
}

export class PriceActionAnalyzer {
  static analyze(klines: OHLCV[]): PriceActionSetup | null {
    if (klines.length < 21) return null;

    const current = klines[klines.length - 1];
    const previous = klines[klines.length - 2];
    
    // Calculate EMAs
    const closePrices = klines.map(k => k.close);
    const ema50 = EMA.calculate({ period: 50, values: closePrices }).pop() || 0;
    const ema200 = EMA.calculate({ period: 200, values: closePrices }).pop() || 0;

    // Calculate Volume SMA
    const volumes = klines.map(k => k.volume);
    const volSMA = SMA.calculate({ period: 20, values: volumes }).pop() || 0;

    // Calculate Support/Resistance (10 period swing low/high)
    const recentKlines = klines.slice(-12, -2); // Exclude current and previous
    const swingLow = Math.min(...recentKlines.map(k => k.low));
    const swingHigh = Math.max(...recentKlines.map(k => k.high));

    let pattern: string | null = null;
    let type: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';

    // 1. Candlestick Pattern Recognition
    
    // Engulfing
    const isBullishEngulfing = previous.close < previous.open && 
                               current.close > current.open &&
                               current.open <= previous.close &&
                               current.close >= previous.open;
                               
    const isBearishEngulfing = previous.close > previous.open &&
                               current.close < current.open &&
                               current.open >= previous.close &&
                               current.close <= previous.open;

    // Pin Bars
    const body = Math.abs(current.close - current.open);
    const lowerWick = Math.min(current.open, current.close) - current.low;
    const upperWick = current.high - Math.max(current.open, current.close);
    
    const isBullishPinBar = lowerWick > (2 * body) && upperWick < body;
    const isBearishPinBar = upperWick > (2 * body) && lowerWick < body;

    // Doji
    const isDoji = body <= (current.high - current.low) * 0.1;

    // Marubozu
    const isBullishMarubozu = current.close > current.open && lowerWick < body * 0.05 && upperWick < body * 0.05;
    const isBearishMarubozu = current.close < current.open && lowerWick < body * 0.05 && upperWick < body * 0.05;

    if (isBullishEngulfing) { pattern = 'Bullish Engulfing'; type = 'LONG'; }
    else if (isBearishEngulfing) { pattern = 'Bearish Engulfing'; type = 'SHORT'; }
    else if (isBullishPinBar) { pattern = 'Bullish Pin Bar'; type = 'LONG'; }
    else if (isBearishPinBar) { pattern = 'Bearish Pin Bar'; type = 'SHORT'; }
    else if (isBullishMarubozu) { pattern = 'Bullish Marubozu'; type = 'LONG'; }
    else if (isBearishMarubozu) { pattern = 'Bearish Marubozu'; type = 'SHORT'; }
    else if (isDoji) { pattern = 'Doji'; type = 'NEUTRAL'; }

    if (!pattern || type === 'NEUTRAL') return null;

    // 2. Contextual Validation (Location & Volume)
    const context: string[] = [];
    let isValid = false;

    // Volume Check
    if (current.volume > volSMA * 1.2) {
      context.push('High Volume Surge');
    }

    // Proximity tolerance (1.0% for crypto volatility)
    const isNear = (price: number, target: number) => Math.abs(price - target) / target < 0.01;

    if (type === 'LONG') {
      if (isNear(current.low, ema50) || isNear(current.low, ema200)) {
        context.push('Bounced off EMA');
        isValid = true;
      }
      if (isNear(current.low, swingLow)) {
        context.push('At Swing Support');
        isValid = true;
      }
    } else if (type === 'SHORT') {
      if (isNear(current.high, ema50) || isNear(current.high, ema200)) {
        context.push('Rejected at EMA');
        isValid = true;
      }
      if (isNear(current.high, swingHigh)) {
        context.push('At Swing Resistance');
        isValid = true;
      }
    }

    // Only return if it formed at a valid structural location
    if (isValid || context.includes('High Volume Surge')) {
      return { pattern, type, context };
    }

    return null; // Middle of nowhere, ignore.
  }
}
