import { DatabaseManager } from './DatabaseManager.js';

export class MLAnalyzer {
  private static MIN_TRADES_FOR_LEARNING = 20; // Needs at least 20 trades to start filtering
  private static MIN_WIN_RATE = 50; // Blacklist if win rate drops below 50%

  /**
   * Analyzes if the current setup is statistically viable on the specific exchange.
   * Returns true if approved, false if historically it's a losing setup.
   */
  static async evaluateSignal(pattern: string, regime: string, exchange: string): Promise<{ approved: boolean, confidence: number, reason: string }> {
    const stats = await DatabaseManager.getPatternStats(pattern, regime, exchange);

    if (stats.totalTrades < this.MIN_TRADES_FOR_LEARNING) {
      return {
        approved: true,
        confidence: 0,
        reason: `Insufficient data (${stats.totalTrades}/${this.MIN_TRADES_FOR_LEARNING} trades). Collecting data.`
      };
    }

    if (stats.winRate < this.MIN_WIN_RATE) {
      return {
        approved: false,
        confidence: stats.winRate,
        reason: `Historically low win rate (${stats.winRate.toFixed(1)}%) over ${stats.totalTrades} trades.`
      };
    }

    return {
      approved: true,
      confidence: stats.winRate,
      reason: `Statistically viable setup (${stats.winRate.toFixed(1)}% win rate).`
    };
  }
}
