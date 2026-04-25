import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { VirtualTrade } from './VirtualTradeTracker.js';

export class DatabaseManager {
  private static db: Database | null = null;

  static async initialize() {
    this.db = await open({
      filename: './trade_history.db',
      driver: sqlite3.Database
    });

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS virtual_trades (
        id TEXT PRIMARY KEY,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        symbol TEXT,
        type TEXT,
        entryPrice REAL,
        closePrice REAL,
        pnlPercent REAL,
        outcome TEXT,
        closeReason TEXT,
        pattern TEXT,
        regime TEXT,
        trend TEXT,
        adx REAL
      )
    `);

    // Migration to add 'exchange' column to existing DB safely
    try {
      await this.db.exec(`ALTER TABLE virtual_trades ADD COLUMN exchange TEXT DEFAULT 'CoinSwitch'`);
      console.log('[DatabaseManager] Added "exchange" column to existing schema.');
    } catch (e: any) {
      // Column already exists, ignore error
      if (!e.message.includes('duplicate column name')) {
        console.error('[DatabaseManager] Migration error:', e.message);
      }
    }

    console.log('[DatabaseManager] SQLite Database initialized.');
  }

  static async logTrade(trade: VirtualTrade) {
    if (!this.db) await this.initialize();

    // Calculate PnL percentage
    let pnlPercent = 0;
    if (trade.closePrice) {
      if (trade.type === 'LONG') {
        pnlPercent = ((trade.closePrice - trade.entryPrice) / trade.entryPrice) * 100;
      } else {
        pnlPercent = ((trade.entryPrice - trade.closePrice) / trade.entryPrice) * 100;
      }
    }

    // Determine outcome
    let outcome = 'LOSS';
    if (pnlPercent > 0) outcome = 'WIN';
    if (Math.abs(pnlPercent) < 0.05) outcome = 'BREAKEVEN';

    const pattern = trade.metadata?.pattern || 'UNKNOWN';
    const regime = trade.metadata?.regime || 'UNKNOWN';
    const trend = trade.metadata?.trend || 'UNKNOWN';
    const adx = trade.metadata?.adx || 0;
    const exchange = trade.exchange || 'UNKNOWN';

    await this.db!.run(`
      INSERT INTO virtual_trades (id, symbol, type, entryPrice, closePrice, pnlPercent, outcome, closeReason, pattern, regime, trend, adx, exchange)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      trade.id, trade.symbol, trade.type, trade.entryPrice, trade.closePrice, pnlPercent, outcome, trade.closeReason, pattern, regime, trend, adx, exchange
    ]);

    console.log(`[DatabaseManager] Logged Virtual Trade ${trade.symbol} (${outcome}) on ${exchange} to SQLite.`);
  }

  static async getPatternStats(pattern: string, regime: string, exchange: string): Promise<{ winRate: number, totalTrades: number }> {
    if (!this.db) await this.initialize();

    const row = await this.db!.get(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'WIN' OR outcome = 'BREAKEVEN' THEN 1 ELSE 0 END) as wins
      FROM virtual_trades
      WHERE pattern = ? AND regime = ? AND exchange = ?
    `, [pattern, regime, exchange]);

    const total = row.total || 0;
    const wins = row.wins || 0;

    if (total === 0) return { winRate: 0, totalTrades: 0 };
    return { winRate: (wins / total) * 100, totalTrades: total };
  }
}
