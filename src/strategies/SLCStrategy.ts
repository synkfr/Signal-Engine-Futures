import { OHLCV } from '../providers/MarketProvider.js';
import { EMA, Stochastic } from 'technicalindicators';

// ============================================================
// SLC EXECUTION BLUEPRINT
// Structure → Level → Confirmation
// Based on "SLC Execution Blueprint by Data Trader"
// ============================================================

export interface SupplyDemandZone {
  type: 'DEMAND' | 'SUPPLY';
  high: number;
  low: number;
  touches: number;       // How many times price has revisited this zone
  strength: number;      // Combined strength score (move% + volume)
  volumeScore: number;   // Volume relative to average (>1 = above average)
}

export interface SLCResult {
  signal: 'LONG' | 'SHORT';
  structure: 'UPTREND' | 'DOWNTREND';
  zone: SupplyDemandZone;
  stochastic: { k: number; d: number };
  stopLoss: number;
  takeProfit: number;
  entry: number;
  context: string[];     // Human-readable explanation for Discord
}

export class SLCStrategy {

  /**
   * Full SLC Analysis Pipeline.
   * Returns null if ANY of the 3 stages fail.
   */
  static analyze(klines4H: OHLCV[], klines15m: OHLCV[]): SLCResult | null {
    if (klines4H.length < 50 || klines15m.length < 50) return null;

    // =====================
    // STAGE 1: STRUCTURE
    // =====================
    const structure = this.analyzeStructure(klines4H);
    if (!structure) return null; // Sideways → skip entirely

    // =====================
    // STAGE 2: LEVEL
    // =====================
    const zones = this.mapSupplyDemandZones(klines15m);
    const currentPrice = klines15m[klines15m.length - 1].close;

    // Find the zone that price is currently touching
    const activeZone = this.findActiveZone(zones, currentPrice, structure);
    if (!activeZone) return null; // Price is not at any key level

    // =====================
    // STAGE 3: CONFIRMATION
    // =====================
    const confirmation = this.checkStochasticConfirmation(klines15m, structure, activeZone);
    if (!confirmation) return null; // No stochastic crossover yet

    // =====================
    // ALL 3 STAGES PASSED ✅
    // =====================
    const signal: 'LONG' | 'SHORT' = structure === 'UPTREND' ? 'LONG' : 'SHORT';
    const risk = Math.abs(currentPrice - (signal === 'LONG' ? activeZone.low : activeZone.high));
    const reward = risk * 2; // Minimum 2R target

    const entry = currentPrice;
    const stopLoss = signal === 'LONG' 
      ? activeZone.low - (activeZone.high - activeZone.low) * 0.1   // Slightly below the demand zone
      : activeZone.high + (activeZone.high - activeZone.low) * 0.1; // Slightly above the supply zone
    const takeProfit = signal === 'LONG'
      ? entry + reward
      : entry - reward;

    const context: string[] = [
      `4H Structure: ${structure}`,
      `Zone: ${activeZone.type} (${activeZone.low.toFixed(2)} - ${activeZone.high.toFixed(2)})`,
      `Zone Touches: ${activeZone.touches}`,
      `Volume: ${activeZone.volumeScore.toFixed(1)}x avg${activeZone.volumeScore >= 1.5 ? ' 🔥' : ''}`,
      `Stochastic: K=${confirmation.k.toFixed(1)} D=${confirmation.d.toFixed(1)}`,
    ];

    return {
      signal,
      structure,
      zone: activeZone,
      stochastic: confirmation,
      stopLoss,
      takeProfit,
      entry,
      context,
    };
  }

  // ============================================================
  // STAGE 1: STRUCTURE (High Timeframe Trend)
  // ============================================================
  private static analyzeStructure(klines4H: OHLCV[]): 'UPTREND' | 'DOWNTREND' | null {
    const closes = klines4H.map(k => k.close);

    // Use EMA 50 vs EMA 21 for faster trend detection on 4H
    const ema21 = EMA.calculate({ period: 21, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });

    if (ema21.length < 3 || ema50.length < 3) return null;

    const lastEma21 = ema21[ema21.length - 1];
    const lastEma50 = ema50[ema50.length - 1];

    // Also check for Higher Highs / Lower Lows to confirm structure
    const recent = klines4H.slice(-10);
    const highs = recent.map(k => k.high);
    const lows = recent.map(k => k.low);

    // Simple HH/HL detection: compare last 5 candles vs previous 5
    const firstHalf = klines4H.slice(-10, -5);
    const secondHalf = klines4H.slice(-5);

    const fhHighest = Math.max(...firstHalf.map(k => k.high));
    const shHighest = Math.max(...secondHalf.map(k => k.high));
    const fhLowest = Math.min(...firstHalf.map(k => k.low));
    const shLowest = Math.min(...secondHalf.map(k => k.low));

    const isHHHL = shHighest > fhHighest && shLowest > fhLowest; // Higher Highs & Higher Lows
    const isLHLL = shHighest < fhHighest && shLowest < fhLowest; // Lower Highs & Lower Lows

    // EMA alignment + structure confirmation
    if (lastEma21 > lastEma50 && isHHHL) return 'UPTREND';
    if (lastEma21 < lastEma50 && isLHLL) return 'DOWNTREND';

    // If EMAs agree but structure is ambiguous, still trust EMAs with a wider gap
    const emaDiffPct = Math.abs(lastEma21 - lastEma50) / lastEma50;
    if (emaDiffPct > 0.005) { // 0.5% gap minimum
      if (lastEma21 > lastEma50) return 'UPTREND';
      if (lastEma21 < lastEma50) return 'DOWNTREND';
    }

    return null; // Sideways / Choppy → Do NOT trade
  }

  // ============================================================
  // STAGE 2: LEVEL (Supply / Demand Zone Mapping)
  // ============================================================
  private static mapSupplyDemandZones(klines: OHLCV[]): SupplyDemandZone[] {
    const zones: SupplyDemandZone[] = [];
    const minMovePercent = 0.003; // 0.3% minimum move to qualify as institutional

    // Calculate average volume for relative comparison
    const avgVolume = klines.reduce((sum, k) => sum + k.volume, 0) / klines.length;

    // Scan from candle 2 to (length - 2) to have context on both sides
    for (let i = 2; i < klines.length - 2; i++) {
      const candle = klines[i];
      const body = Math.abs(candle.close - candle.open);
      const range = candle.high - candle.low;

      if (range === 0) continue;

      const bodyRatio = body / range;

      // Look for strong impulse candles (large body, small wicks)
      if (bodyRatio < 0.6) continue; // Must be at least 60% body

      const movePercent = body / candle.open;
      if (movePercent < minMovePercent) continue;

      // Volume profile: how much volume relative to average
      const volumeScore = avgVolume > 0 ? candle.volume / avgVolume : 1;

      // Combined strength: move% * volume multiplier
      // A 0.5% move with 2x average volume scores higher than a 1% move with 0.3x volume
      const combinedStrength = (movePercent * 100) * Math.max(volumeScore, 0.5);

      // Verify the move continued in the next candle (confirmation of strength)
      const nextCandle = klines[i + 1];

      if (candle.close > candle.open && nextCandle.close > nextCandle.open) {
        // Bullish impulse → DEMAND zone is the base of the impulse
        const baseCandle = klines[i - 1]; // The candle before the impulse
        zones.push({
          type: 'DEMAND',
          low: Math.min(baseCandle.low, candle.low),
          high: Math.max(baseCandle.open, Math.min(baseCandle.close, candle.open)),
          touches: 0,
          strength: combinedStrength,
          volumeScore,
        });
      } else if (candle.close < candle.open && nextCandle.close < nextCandle.open) {
        // Bearish impulse → SUPPLY zone is the top of the impulse
        const baseCandle = klines[i - 1];
        zones.push({
          type: 'SUPPLY',
          high: Math.max(baseCandle.high, candle.high),
          low: Math.min(baseCandle.open, Math.max(baseCandle.close, candle.open)),
          touches: 0,
          strength: combinedStrength,
          volumeScore,
        });
      }
    }

    // Count how many times each zone has been touched by subsequent price action
    for (const zone of zones) {
      for (const candle of klines) {
        if (zone.type === 'DEMAND' && candle.low <= zone.high && candle.low >= zone.low) {
          zone.touches++;
        }
        if (zone.type === 'SUPPLY' && candle.high >= zone.low && candle.high <= zone.high) {
          zone.touches++;
        }
      }
      // The initial impulse itself counts as 1 touch, so subtract it
      zone.touches = Math.max(0, zone.touches - 1);
    }

    // Filter: Zone must NOT have been broken multiple times (max 1 touch as per SLC)
    // Prefer zones with above-average volume (institutional footprint)
    return zones
      .filter(z => z.touches <= 1)
      .sort((a, b) => b.strength - a.strength); // Strongest zones first
  }

  /**
   * Find the zone that current price is touching right now.
   * Filters by trade direction (only DEMAND for UPTREND, SUPPLY for DOWNTREND).
   */
  private static findActiveZone(
    zones: SupplyDemandZone[],
    currentPrice: number,
    structure: 'UPTREND' | 'DOWNTREND'
  ): SupplyDemandZone | null {
    const targetType = structure === 'UPTREND' ? 'DEMAND' : 'SUPPLY';

    // Find the closest matching zone the price is currently inside or very near
    const tolerance = 0.002; // 0.2% proximity tolerance

    const matching = zones
      .filter(z => z.type === targetType)
      .filter(z => {
        const zoneSize = z.high - z.low;
        const expandedLow = z.low - zoneSize * tolerance;
        const expandedHigh = z.high + zoneSize * tolerance;
        return currentPrice >= expandedLow && currentPrice <= expandedHigh;
      })
      .sort((a, b) => b.strength - a.strength); // Prefer strongest zone

    return matching.length > 0 ? matching[0] : null;
  }

  // ============================================================
  // STAGE 3: CONFIRMATION (Stochastic 5,3,3 Crossover)
  // ============================================================
  private static checkStochasticConfirmation(
    klines: OHLCV[],
    structure: 'UPTREND' | 'DOWNTREND',
    zone: SupplyDemandZone
  ): { k: number; d: number } | null {
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const closes = klines.map(k => k.close);

    const stochValues = Stochastic.calculate({
      high: highs,
      low: lows,
      close: closes,
      period: 5,
      signalPeriod: 3,
    });

    if (stochValues.length < 3) return null;

    const current = stochValues[stochValues.length - 1];
    const previous = stochValues[stochValues.length - 2];
    const twoBefore = stochValues[stochValues.length - 3];

    if (!current.k || !current.d || !previous.k || !previous.d) return null;

    if (structure === 'UPTREND' && zone.type === 'DEMAND') {
      // LONG Confirmation:
      // Stochastic was in oversold (<20), and has NOW crossed back above 20
      const wasOversold = previous.k! <= 20 || twoBefore.k! <= 20;
      const crossedUp = current.k! > 20 && current.k! > current.d!;

      if (wasOversold && crossedUp) {
        return { k: current.k!, d: current.d! };
      }
    }

    if (structure === 'DOWNTREND' && zone.type === 'SUPPLY') {
      // SHORT Confirmation:
      // Stochastic was in overbought (>80), and has NOW crossed back below 80
      const wasOverbought = previous.k! >= 80 || twoBefore.k! >= 80;
      const crossedDown = current.k! < 80 && current.k! < current.d!;

      if (wasOverbought && crossedDown) {
        return { k: current.k!, d: current.d! };
      }
    }

    return null; // No valid crossover
  }
}
