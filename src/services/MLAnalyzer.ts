import { DatabaseManager } from './DatabaseManager.js';

// ============================================================
// ML ANALYZER — Multi-dimensional signal evaluation
// Goes beyond simple win-rate to score signals using:
// - Pattern win rate (base)
// - Volume confidence (institutional zones)
// - Session performance (time-of-day filtering)
// - Loss streak protection
// ============================================================

interface SignalEvaluation {
  approved: boolean;
  confidence: number;
  factors: {
    patternWinRate: number;
    volumeBonus: number;
    sessionPenalty: number;
    streakAdjustment: number;
  };
  reason: string;
}

export class MLAnalyzer {
  private static MIN_TRADES_FOR_LEARNING = 20;
  private static BASE_MIN_WIN_RATE = 50;
  private static STREAK_THRESHOLD = 3; // After 3 consecutive losses, raise threshold

  /**
   * Multi-dimensional signal evaluation.
   * Scores the signal across multiple axes and returns a composite decision.
   */
  static async evaluateSignal(
    pattern: string, 
    regime: string, 
    exchange: string,
    volumeScore?: number,
    timeOfDay?: string
  ): Promise<SignalEvaluation> {
    const factors = {
      patternWinRate: 0,
      volumeBonus: 0,
      sessionPenalty: 0,
      streakAdjustment: 0,
    };

    // ── Factor 1: Base Pattern Win Rate ──
    const stats = await DatabaseManager.getPatternStats(pattern, regime, exchange);
    
    if (stats.totalTrades < this.MIN_TRADES_FOR_LEARNING) {
      return {
        approved: true,
        confidence: 0,
        factors,
        reason: `Collecting data (${stats.totalTrades}/${this.MIN_TRADES_FOR_LEARNING} trades).`
      };
    }

    factors.patternWinRate = stats.winRate;
    let effectiveThreshold = this.BASE_MIN_WIN_RATE;

    // ── Factor 2: Volume Confidence ──
    if (volumeScore !== undefined) {
      const volCorr = await DatabaseManager.getVolumeCorrelation();
      if (volumeScore >= 1.5 && volCorr.highVolWinRate > volCorr.lowVolWinRate) {
        // Institutional volume zone — lower the threshold (more permissive)
        factors.volumeBonus = 5;
        effectiveThreshold -= 5;
      } else if (volumeScore < 0.5) {
        // Very low volume — raise the threshold (more restrictive)
        factors.volumeBonus = -5;
        effectiveThreshold += 5;
      }
    }

    // ── Factor 3: Session Performance ──
    if (timeOfDay) {
      const sessionStats = await DatabaseManager.getSessionStats(timeOfDay);
      if (sessionStats.totalTrades >= 10 && sessionStats.winRate < 40) {
        // This session historically performs badly — penalize
        factors.sessionPenalty = -10;
        effectiveThreshold += 10;
      } else if (sessionStats.totalTrades >= 10 && sessionStats.winRate > 60) {
        // Great session — reward
        factors.sessionPenalty = 5;
        effectiveThreshold -= 5;
      }
    }

    // ── Factor 4: Loss Streak Protection ──
    const streak = await DatabaseManager.getRecentStreak();
    if (streak >= this.STREAK_THRESHOLD) {
      // After 3+ consecutive losses, temporarily raise threshold
      const penalty = Math.min(streak * 3, 15); // Max 15% penalty
      factors.streakAdjustment = -penalty;
      effectiveThreshold += penalty;
    }

    // ── Final Decision ──
    effectiveThreshold = Math.max(35, Math.min(70, effectiveThreshold)); // Clamp 35-70%
    const approved = stats.winRate >= effectiveThreshold;

    const compositeConfidence = stats.winRate + factors.volumeBonus + factors.sessionPenalty + factors.streakAdjustment;

    if (!approved) {
      const reasons: string[] = [];
      if (stats.winRate < this.BASE_MIN_WIN_RATE) reasons.push(`win rate ${stats.winRate.toFixed(1)}%`);
      if (factors.sessionPenalty < 0) reasons.push(`bad session`);
      if (factors.streakAdjustment < 0) reasons.push(`${streak} consecutive losses`);
      if (factors.volumeBonus < 0) reasons.push(`low volume`);

      return {
        approved: false,
        confidence: compositeConfidence,
        factors,
        reason: `Rejected: ${reasons.join(', ')} (threshold: ${effectiveThreshold.toFixed(0)}%)`
      };
    }

    return {
      approved: true,
      confidence: compositeConfidence,
      factors,
      reason: `Approved: ${stats.winRate.toFixed(1)}% win rate over ${stats.totalTrades} trades`
    };
  }
}
