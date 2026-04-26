import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { VirtualTrade } from './VirtualTradeTracker.js';

// ============================================================
// DATABASE MANAGER — SQLite persistence for trade history
// and crash recovery (active trade state).
// ============================================================

export class DatabaseManager {
  private static db: Database | null = null;

  static async initialize() {
    this.db = await open({
      filename: './trade_history.db',
      driver: sqlite3.Database
    });

    // Enable WAL mode for better concurrent read/write performance
    await this.db.exec('PRAGMA journal_mode=WAL');

    // ── Trade History Table ──
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS virtual_trades (
        id TEXT PRIMARY KEY,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        symbol TEXT,
        type TEXT,
        exchange TEXT DEFAULT 'Binance',
        entryPrice REAL,
        closePrice REAL,
        pnlPercent REAL,
        outcome TEXT,
        closeReason TEXT,
        pattern TEXT,
        regime TEXT,
        trend TEXT,
        adx REAL,
        zoneStrength REAL,
        volumeScore REAL,
        stochK REAL,
        stochD REAL,
        fundingRate REAL,
        openInterest REAL,
        timeOfDay TEXT,
        dayOfWeek INTEGER,
        riskReward REAL,
        duration INTEGER,
        maxFavorable REAL,
        maxAdverse REAL
      )
    `);

    // ── Active Trades Table (crash recovery) ──
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_trades (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL DEFAULT 'Binance',
        type TEXT NOT NULL,
        entryPrice REAL NOT NULL,
        hardSL REAL NOT NULL,
        takeProfit REAL NOT NULL,
        currentSL REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        openedAt INTEGER,
        maxFavorable REAL DEFAULT 0,
        maxAdverse REAL DEFAULT 0,
        metadata TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('[DatabaseManager] SQLite initialized (WAL mode).');
  }

  // ============================================================
  // ACTIVE TRADE PERSISTENCE (Crash Recovery)
  // ============================================================

  static async saveActiveTrade(trade: VirtualTrade) {
    if (!this.db) await this.initialize();

    await this.db!.run(`
      INSERT OR REPLACE INTO active_trades (id, symbol, exchange, type, entryPrice, hardSL, takeProfit, currentSL, status, openedAt, maxFavorable, maxAdverse, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      trade.id, trade.symbol, trade.exchange, trade.type,
      trade.entryPrice, trade.hardSL, trade.takeProfit, trade.currentSL,
      trade.status, trade.openedAt || Date.now(),
      trade.maxFavorable || 0, trade.maxAdverse || 0,
      JSON.stringify(trade.metadata || {})
    ]);
  }

  static async updateTradeStatus(id: string, status: string, currentSL: number) {
    if (!this.db) await this.initialize();

    await this.db!.run(`
      UPDATE active_trades SET status = ?, currentSL = ? WHERE id = ?
    `, [status, currentSL, id]);
  }

  static async updateTradeMFEMAE(id: string, maxFavorable: number, maxAdverse: number) {
    if (!this.db) await this.initialize();

    await this.db!.run(`
      UPDATE active_trades SET maxFavorable = ?, maxAdverse = ? WHERE id = ?
    `, [maxFavorable, maxAdverse, id]);
  }

  static async removeActiveTrade(id: string) {
    if (!this.db) await this.initialize();
    await this.db!.run('DELETE FROM active_trades WHERE id = ?', [id]);
  }

  static async loadActiveTrades(): Promise<VirtualTrade[]> {
    if (!this.db) await this.initialize();

    const rows = await this.db!.all('SELECT * FROM active_trades');
    return rows.map((row: any) => ({
      id: row.id,
      symbol: row.symbol,
      exchange: row.exchange,
      type: row.type,
      entryPrice: row.entryPrice,
      hardSL: row.hardSL,
      takeProfit: row.takeProfit,
      currentSL: row.currentSL,
      status: row.status,
      openedAt: row.openedAt,
      maxFavorable: row.maxFavorable || 0,
      maxAdverse: row.maxAdverse || 0,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
    }));
  }

  // ============================================================
  // TRADE HISTORY LOGGING
  // ============================================================

  static async logTrade(trade: VirtualTrade) {
    if (!this.db) await this.initialize();

    let pnlPercent = 0;
    if (trade.closePrice) {
      if (trade.type === 'LONG') {
        pnlPercent = ((trade.closePrice - trade.entryPrice) / trade.entryPrice) * 100;
      } else {
        pnlPercent = ((trade.entryPrice - trade.closePrice) / trade.entryPrice) * 100;
      }
    }

    let outcome = 'LOSS';
    if (pnlPercent > 0) outcome = 'WIN';
    if (Math.abs(pnlPercent) < 0.05) outcome = 'BREAKEVEN';

    const m = trade.metadata || {};
    const duration = trade.openedAt ? Math.floor((Date.now() - trade.openedAt) / 60000) : 0;
    const riskReward = trade.closePrice
      ? Math.abs((trade.closePrice - trade.entryPrice) / (trade.entryPrice - trade.hardSL))
      : 0;

    await this.db!.run(`
      INSERT OR REPLACE INTO virtual_trades (
        id, symbol, type, exchange, entryPrice, closePrice, pnlPercent, outcome, closeReason,
        pattern, regime, trend, adx,
        zoneStrength, volumeScore, stochK, stochD,
        fundingRate, openInterest, timeOfDay, dayOfWeek,
        riskReward, duration, maxFavorable, maxAdverse
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      trade.id, trade.symbol, trade.type, trade.exchange || 'Binance',
      trade.entryPrice, trade.closePrice, pnlPercent, outcome, trade.closeReason,
      m.pattern || 'UNKNOWN', m.regime || 'UNKNOWN', m.structure === 'UPTREND' ? 'UP' : 'DOWN', m.adx || 0,
      m.zoneStrength || 0, m.volumeScore || 0, m.stochK || 0, m.stochD || 0,
      m.fundingRate || 0, m.openInterest || 0, m.timeOfDay || 'UNKNOWN', m.dayOfWeek || 0,
      riskReward, duration, trade.maxFavorable || 0, trade.maxAdverse || 0
    ]);

    console.log(`[DB] Logged trade ${trade.symbol} (${outcome}, ${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`);
  }

  // ============================================================
  // ML QUERY METHODS
  // ============================================================

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

  static async getSessionStats(timeOfDay: string): Promise<{ winRate: number, totalTrades: number }> {
    if (!this.db) await this.initialize();

    const row = await this.db!.get(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'WIN' OR outcome = 'BREAKEVEN' THEN 1 ELSE 0 END) as wins
      FROM virtual_trades
      WHERE timeOfDay = ?
    `, [timeOfDay]);

    const total = row?.total || 0;
    const wins = row?.wins || 0;

    if (total === 0) return { winRate: 0, totalTrades: 0 };
    return { winRate: (wins / total) * 100, totalTrades: total };
  }

  static async getRecentStreak(): Promise<number> {
    if (!this.db) await this.initialize();

    const rows = await this.db!.all(`
      SELECT outcome FROM virtual_trades ORDER BY timestamp DESC LIMIT 10
    `);

    let streak = 0;
    for (const row of rows) {
      if (row.outcome === 'LOSS') streak++;
      else break;
    }
    return streak;
  }

  static async getVolumeCorrelation(): Promise<{ highVolWinRate: number, lowVolWinRate: number }> {
    if (!this.db) await this.initialize();

    const high = await this.db!.get(`
      SELECT COUNT(*) as total, SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins
      FROM virtual_trades WHERE volumeScore >= 1.5
    `);
    const low = await this.db!.get(`
      SELECT COUNT(*) as total, SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins
      FROM virtual_trades WHERE volumeScore < 1.5
    `);

    return {
      highVolWinRate: high?.total > 0 ? (high.wins / high.total) * 100 : 0,
      lowVolWinRate: low?.total > 0 ? (low.wins / low.total) * 100 : 0,
    };
  }
}
