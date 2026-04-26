import { BinanceProvider } from '../providers/BinanceProvider.js';
import { DiscordNotifier } from '../services/DiscordNotifier.js';
import { CurrencyService } from '../services/CurrencyService.js';
import { SLCStrategy, SLCResult } from '../strategies/SLCStrategy.js';
import { VirtualTradeTracker, VirtualTrade } from '../services/VirtualTradeTracker.js';
import { DatabaseManager } from '../services/DatabaseManager.js';
import { MLAnalyzer } from '../services/MLAnalyzer.js';
import { OrderExecutor } from '../services/OrderExecutor.js';

// ============================================================
// SIGNAL ENGINE v2 — SLC-Only Mode
// Only trades when Structure → Level → Confirmation aligns.
// No Price Action fallback. No CoinSwitch. Binance Futures only.
// ============================================================

export class SignalEngine {
  private provider: BinanceProvider;
  private notifier: DiscordNotifier;
  private symbols: string[];
  private tracker: VirtualTradeTracker;
  private orderExecutor: OrderExecutor | null = null;

  // 4H kline cache with 1-hour TTL to prevent rate limit spam
  private klines4HCache: Map<string, { data: any[]; fetchedAt: number }> = new Map();
  private readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  private readonly MAX_CONCURRENT_TRADES = 5;

  constructor(provider: BinanceProvider, notifier: DiscordNotifier, symbols: string[], orderExecutor?: OrderExecutor) {
    this.provider = provider;
    this.notifier = notifier;
    this.symbols = symbols;
    this.tracker = new VirtualTradeTracker();
    this.orderExecutor = orderExecutor || null;

    // ── Trade Lifecycle Listeners ──────────────────────────
    this.tracker.onBreakeven = async (trade) => {
      await this.notifyBreakeven(trade);
      // Update testnet SL order if executing demo trades
      if (this.orderExecutor) {
        await this.updateTestnetStopLoss(trade);
      }
    };

    this.tracker.onTrailingUpdate = async (trade) => {
      await this.notifyTrailingUpdate(trade);
      // Update testnet SL order
      if (this.orderExecutor) {
        await this.updateTestnetStopLoss(trade);
      }
    };

    this.tracker.onClosed = async (trade) => {
      await this.notifyTradeClosed(trade);
      await DatabaseManager.logTrade(trade);
      // Remove from persistent storage
      await DatabaseManager.removeActiveTrade(trade.id);
    };
  }

  async run() {
    console.log('🚀 SignalEngine v2 Starting (SLC-Only Mode)...');
    console.log(`[SignalEngine] Monitoring ${this.symbols.length} symbols via WebSocket...`);

    // Rehydrate active trades from last session
    await this.rehydrateTrades();

    // Initialize WebSocket provider
    await this.provider.initialize(this.symbols);
    
    // Hook into WebSocket candle close events — zero-delay execution
    this.provider.onCandleClose = async (symbol: string, klines: any[]) => {
      try {
        await this.processSymbol(symbol, klines);
      } catch (e: any) {
        console.error(`[SignalEngine] Error processing ${symbol}:`, e.message);
      }
    };

    console.log('[SignalEngine] ✅ WebSocket connected. Listening for candle closes...');
    
    // Send startup notification
    await this.notifyStartup();
  }

  // ============================================================
  // CORE: Process each symbol on 15m candle close
  // ============================================================
  private async processSymbol(symbol: string, klines15m: any[]) {
    if (klines15m.length < 50) return;

    const currentPrice = klines15m[klines15m.length - 1].close;

    // Update active trade with latest price data
    this.tracker.updateMarket(symbol, currentPrice, klines15m);

    // Skip if already in a trade on this symbol
    if (this.tracker.getActiveTrade(symbol)) return;

    // Maximum exposure limit
    if (this.tracker.getActiveTrades().length >= this.MAX_CONCURRENT_TRADES) return;

    // ── SLC Analysis: Structure → Level → Confirmation ──
    const klines4H = await this.get4HKlines(symbol);
    if (klines4H.length < 50) return;

    const slcResult = SLCStrategy.analyze(klines4H, klines15m);
    if (!slcResult) return;

    // ── ML Filter ──
    const slcPattern = `SLC_${slcResult.zone.type}_${slcResult.structure}`;
    const mlEvaluation = await MLAnalyzer.evaluateSignal(slcPattern, 'TRENDING', 'Binance');
    if (!mlEvaluation.approved) {
      console.log(`[ML] ❌ Rejected ${symbol} ${slcResult.signal}: ${mlEvaluation.reason}`);
      return;
    }

    // ── ALL STAGES PASSED — Open Trade ──
    console.log(`[SLC] ✅ ${symbol} ${slcResult.signal} — All 3 stages passed`);

    // Broadcast signal to Discord
    await this.broadcastSignal(symbol, slcResult, mlEvaluation.confidence);

    // Create trade record
    const tradeId = `${symbol}-${Date.now()}`;
    const trade: VirtualTrade = {
      id: tradeId,
      symbol,
      exchange: 'Binance',
      type: slcResult.signal,
      entryPrice: slcResult.entry,
      hardSL: slcResult.stopLoss,
      takeProfit: slcResult.takeProfit,
      currentSL: slcResult.stopLoss,
      status: 'ACTIVE',
      openedAt: Date.now(),
      maxFavorable: 0,
      maxAdverse: 0,
      metadata: {
        pattern: `SLC ${slcResult.zone.type}`,
        context: slcResult.context.join(', '),
        regime: 'TRENDING',
        structure: slcResult.structure,
        zoneStrength: slcResult.zone.strength,
        volumeScore: slcResult.zone.volumeScore,
        stochK: slcResult.stochastic.k,
        stochD: slcResult.stochastic.d,
        timeOfDay: this.getSession(),
        dayOfWeek: new Date().getDay(),
      }
    };

    this.tracker.addTrade(trade);

    // Persist to DB (crash recovery)
    await DatabaseManager.saveActiveTrade(trade);

    // Notify trade opened
    await this.notifyTradeOpened(trade, slcResult);

    // Execute testnet order if enabled
    if (this.orderExecutor) {
      const side = slcResult.signal === 'LONG' ? 'BUY' as const : 'SELL' as const;
      const result = await this.orderExecutor.executeTrade(
        symbol, side, slcResult.entry, slcResult.stopLoss, slcResult.takeProfit
      );
      if (result) {
        console.log(`[Demo] ✅ Testnet order placed for ${symbol}: OrderID=${result.entryOrder.orderId}`);
      }
    }
  }

  // ============================================================
  // 4H KLINE CACHE
  // ============================================================
  private async get4HKlines(symbol: string): Promise<any[]> {
    const cached = this.klines4HCache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
      return cached.data;
    }
    const klines = await this.provider.fetchOHLCV(symbol, '4h', 100);
    this.klines4HCache.set(symbol, { data: klines, fetchedAt: Date.now() });
    return klines;
  }

  // ============================================================
  // CRASH RECOVERY
  // ============================================================
  private async rehydrateTrades() {
    const activeTrades = await DatabaseManager.loadActiveTrades();
    if (activeTrades.length > 0) {
      this.tracker.rehydrate(activeTrades);
      console.log(`[Recovery] 🔄 Recovered ${activeTrades.length} active trade(s) from last session`);
      
      // Notify Discord
      const symbols = activeTrades.map(t => t.symbol.replace('USDT', '/USDT')).join(', ');
      await this.notifier.sendTradeResult({
        embeds: [{
          title: '🔄 Trades Recovered from Last Session',
          description: `The bot restarted and recovered **${activeTrades.length}** active trade(s).`,
          color: 0x3B82F6,
          fields: [
            { name: '📊 Symbols', value: `\`${symbols}\``, inline: false },
            { name: '📈 Status', value: 'Monitoring resumed. SL/TP tracking active.', inline: false },
          ],
          footer: { text: 'SignalEngine v2 • Crash Recovery' },
          timestamp: new Date().toISOString()
        }]
      });
    }
  }

  // ============================================================
  // TESTNET ORDER MANAGEMENT
  // ============================================================
  private async updateTestnetStopLoss(trade: VirtualTrade) {
    if (!this.orderExecutor) return;
    try {
      // Cancel old SL order and place new one
      await this.orderExecutor.cancelAllOrders(trade.symbol);
      const slSide = trade.type === 'LONG' ? 'SELL' as const : 'BUY' as const;
      // Re-place updated SL + existing TP
      await this.orderExecutor.executeTrade(
        trade.symbol,
        trade.type === 'LONG' ? 'BUY' : 'SELL',
        trade.entryPrice,
        trade.currentSL,
        trade.takeProfit
      );
    } catch (e: any) {
      console.error(`[Demo] Failed to update testnet SL for ${trade.symbol}:`, e.message);
    }
  }

  // ============================================================
  // DISCORD NOTIFICATIONS
  // ============================================================
  private async notifyStartup() {
    const activeCount = this.tracker.getActiveTrades().length;
    await this.notifier.sendSignal({
      embeds: [{
        title: '🚀 SignalEngine v2 Online',
        description: 'SLC-Only Mode. Monitoring Binance Futures via WebSocket.',
        color: 0x22C55E,
        fields: [
          { name: '📊 Symbols', value: `\`${this.symbols.length}\``, inline: true },
          { name: '🎯 Strategy', value: '`SLC Blueprint`', inline: true },
          { name: '📈 Active Trades', value: `\`${activeCount}\``, inline: true },
          { name: '🤖 Demo Trading', value: this.orderExecutor ? '`ENABLED`' : '`DISABLED`', inline: true },
          { name: '🧠 ML Filter', value: '`ACTIVE`', inline: true },
          { name: '⏱️ Max Concurrent', value: `\`${this.MAX_CONCURRENT_TRADES}\``, inline: true },
        ],
        footer: { text: `Started at ${new Date().toLocaleString()}` },
        timestamp: new Date().toISOString()
      }]
    });
  }

  private async broadcastSignal(symbol: string, slc: SLCResult, mlConfidence: number) {
    const displaySymbol = symbol.toUpperCase().replace('USDT', '/USDT');
    const actionColor = slc.signal === 'LONG' ? 0x22C55E : 0xEF4444;
    const mlStr = mlConfidence === 0 ? 'Collecting Data' : `${mlConfidence.toFixed(1)}% Win Rate`;

    const fields: any[] = [
      { name: '📊 Pair', value: `\`${displaySymbol}\``, inline: true },
      { name: '📍 Action', value: slc.signal === 'LONG' ? '🟢 BUY / LONG' : '🔴 SELL / SHORT', inline: true },
      { name: '🏷️ Strategy', value: '`SLC Blueprint`', inline: true },
      { name: '\u200B', value: '───── 🎯 **SLC Checklist** ─────', inline: false },
    ];

    // SLC Context
    for (const ctx of slc.context) {
      fields.push({ name: '✅', value: ctx, inline: true });
    }

    fields.push(
      { name: '\u200B', value: '───── 💰 **Trade Levels** ─────', inline: false },
      { name: '💰 Entry', value: `\`${CurrencyService.formatUSDT(slc.entry)}\``, inline: true },
      { name: '🎯 Take Profit', value: `\`${CurrencyService.formatUSDT(slc.takeProfit)}\``, inline: true },
      { name: '🛑 Stop Loss', value: `\`${CurrencyService.formatUSDT(slc.stopLoss)}\``, inline: true },
      { name: '⚖️ Risk:Reward', value: '`1:2 (SLC)`', inline: true },
      { name: '🧠 ML Confidence', value: `\`${mlStr}\``, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
    );

    // Binance market data
    const oi = await this.provider.fetchOpenInterest(symbol);
    const funding = await this.provider.fetchFundingRate(symbol);
    if (oi !== null || funding !== null) {
      fields.push({ name: '\u200B', value: '───── 📊 **Market Data** ─────', inline: false });
      if (oi !== null) fields.push({ name: '📊 Open Interest', value: `\`${oi.toLocaleString()}\``, inline: true });
      if (funding !== null) {
        const emoji = funding > 0 ? '🟢' : '🔴';
        fields.push({ name: `${emoji} Funding Rate`, value: `\`${(funding * 100).toFixed(4)}%\``, inline: true });
      }
    }

    const payload = {
      embeds: [{
        title: `🎯 SLC SIGNAL — ${displaySymbol}`,
        description: `**Structure → Level → Confirmation** all passed. High-probability setup.`,
        color: actionColor,
        fields,
        footer: { text: `Binance Futures • ${displaySymbol}` },
        timestamp: new Date().toISOString()
      }]
    };

    console.log(`[Signal] 🎯 ${slc.signal} ${symbol} — SLC ${slc.zone.type} Zone`);
    await this.notifier.sendSignal(payload);
  }

  private async notifyTradeOpened(trade: VirtualTrade, slc: SLCResult) {
    const displaySymbol = trade.symbol.toUpperCase().replace('USDT', '/USDT');
    const color = trade.type === 'LONG' ? 0x22C55E : 0xEF4444;
    const direction = trade.type === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    const risk = Math.abs(trade.entryPrice - trade.hardSL);
    const reward = Math.abs(trade.takeProfit - trade.entryPrice);
    const rrRatio = risk > 0 ? (reward / risk).toFixed(1) : '∞';

    await this.notifier.sendVirtualTrade({
      embeds: [{
        title: `🎯 TRADE OPENED — ${displaySymbol}`,
        description: `SLC Blueprint signal confirmed. All 3 stages passed.`,
        color,
        fields: [
          { name: '📊 Pair', value: `\`${displaySymbol}\``, inline: true },
          { name: '📍 Direction', value: direction, inline: true },
          { name: '🏷️ Pattern', value: `\`SLC ${slc.zone.type}\``, inline: true },
          { name: '💰 Entry', value: `\`${CurrencyService.formatUSDT(trade.entryPrice)}\``, inline: true },
          { name: '🎯 Take Profit', value: `\`${CurrencyService.formatUSDT(trade.takeProfit)}\``, inline: true },
          { name: '🛑 Stop Loss', value: `\`${CurrencyService.formatUSDT(trade.hardSL)}\``, inline: true },
          { name: '⚖️ Risk:Reward', value: `\`1:${rrRatio}\``, inline: true },
          { name: '🤖 Demo Order', value: this.orderExecutor ? '`PLACED`' : '`DISABLED`', inline: true },
          { name: '⏰ Session', value: `\`${this.getSession()}\``, inline: true },
        ],
        footer: { text: `Binance • ${trade.id}` },
        timestamp: new Date().toISOString()
      }]
    });
  }

  private async notifyBreakeven(trade: VirtualTrade) {
    const displaySymbol = trade.symbol.toUpperCase().replace('USDT', '/USDT');
    await this.notifier.sendTradeResult({
      embeds: [{
        title: `🛡️ STOP LOSS → BREAKEVEN`,
        description: `**${displaySymbol}** is now risk-free! SL moved to entry.`,
        color: 0xFACC15,
        fields: [
          { name: '📊 Pair', value: `\`${displaySymbol}\``, inline: true },
          { name: '📍 Direction', value: trade.type === 'LONG' ? '🟢 LONG' : '🔴 SHORT', inline: true },
          { name: '🔒 New SL', value: `\`${CurrencyService.formatUSDT(trade.currentSL)}\``, inline: true },
          { name: '💰 Entry', value: `\`${CurrencyService.formatUSDT(trade.entryPrice)}\``, inline: true },
          { name: '🎯 Take Profit', value: `\`${CurrencyService.formatUSDT(trade.takeProfit)}\``, inline: true },
          { name: '📈 Status', value: '`RISK FREE`', inline: true },
        ],
        footer: { text: `Binance • ${trade.id}` },
        timestamp: new Date().toISOString()
      }]
    });
    // Persist updated SL
    await DatabaseManager.updateTradeStatus(trade.id, trade.status, trade.currentSL);
  }

  private async notifyTrailingUpdate(trade: VirtualTrade) {
    const displaySymbol = trade.symbol.toUpperCase().replace('USDT', '/USDT');
    const lockedPnl = trade.type === 'LONG'
      ? ((trade.currentSL - trade.entryPrice) / trade.entryPrice * 100)
      : ((trade.entryPrice - trade.currentSL) / trade.entryPrice * 100);

    await this.notifier.sendTradeResult({
      embeds: [{
        title: `📈 TRAILING STOP UPDATED`,
        description: `**${displaySymbol}** trailing SL tightened. Profit locked in!`,
        color: 0x3B82F6,
        fields: [
          { name: '📊 Pair', value: `\`${displaySymbol}\``, inline: true },
          { name: '📍 Direction', value: trade.type === 'LONG' ? '🟢 LONG' : '🔴 SHORT', inline: true },
          { name: '🔒 Trailing SL', value: `\`${CurrencyService.formatUSDT(trade.currentSL)}\``, inline: true },
          { name: '💰 Entry', value: `\`${CurrencyService.formatUSDT(trade.entryPrice)}\``, inline: true },
          { name: '✅ Locked PnL', value: `\`${lockedPnl > 0 ? '+' : ''}${lockedPnl.toFixed(2)}%\``, inline: true },
          { name: '📈 Status', value: '`TRAILING`', inline: true },
        ],
        footer: { text: `Binance • ATR-based trailing stop` },
        timestamp: new Date().toISOString()
      }]
    });
    // Persist updated SL
    await DatabaseManager.updateTradeStatus(trade.id, trade.status, trade.currentSL);
  }

  private async notifyTradeClosed(trade: VirtualTrade) {
    const displaySymbol = trade.symbol.toUpperCase().replace('USDT', '/USDT');
    
    let pnlPercent = 0;
    if (trade.type === 'LONG') {
      pnlPercent = ((trade.closePrice! - trade.entryPrice) / trade.entryPrice) * 100;
    } else {
      pnlPercent = ((trade.entryPrice - trade.closePrice!) / trade.entryPrice) * 100;
    }
    
    const isWin = pnlPercent > 0.05;
    const isBE = Math.abs(pnlPercent) <= 0.05;
    
    let color = 0xEF4444;
    let emoji = '🛑';
    let label = 'LOSS';
    if (isWin) { color = 0x22C55E; emoji = '🏆'; label = 'WIN'; }
    if (isBE) { color = 0xFACC15; emoji = '🔄'; label = 'BREAKEVEN'; }

    // Duration
    const durationMs = trade.openedAt ? Date.now() - trade.openedAt : 0;
    const durationStr = durationMs > 0 ? this.formatDuration(durationMs) : 'N/A';

    await this.notifier.sendTradeResult({
      embeds: [{
        title: `${emoji} TRADE CLOSED — ${label}`,
        description: `**${displaySymbol}** closed via **${trade.closeReason}**`,
        color,
        fields: [
          { name: '📊 Pair', value: `\`${displaySymbol}\``, inline: true },
          { name: '📍 Direction', value: trade.type === 'LONG' ? '🟢 LONG' : '🔴 SHORT', inline: true },
          { name: `${isWin ? '✅' : '❌'} PnL`, value: `\`${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%\``, inline: true },
          { name: '💰 Entry', value: `\`${CurrencyService.formatUSDT(trade.entryPrice)}\``, inline: true },
          { name: '🏁 Exit', value: `\`${CurrencyService.formatUSDT(trade.closePrice!)}\``, inline: true },
          { name: '📋 Reason', value: `\`${trade.closeReason}\``, inline: true },
          { name: '⏱️ Duration', value: `\`${durationStr}\``, inline: true },
          { name: '📈 Best PnL', value: `\`+${(trade.maxFavorable || 0).toFixed(2)}%\``, inline: true },
          { name: '📉 Worst Drawdown', value: `\`-${(trade.maxAdverse || 0).toFixed(2)}%\``, inline: true },
        ],
        footer: { text: `Binance • ${trade.id}` },
        timestamp: new Date().toISOString()
      }]
    });
  }

  // ============================================================
  // HELPERS
  // ============================================================
  private getSession(): string {
    const hour = new Date().getUTCHours();
    if (hour >= 0 && hour < 8) return 'ASIA';
    if (hour >= 8 && hour < 13) return 'LONDON';
    if (hour >= 13 && hour < 21) return 'NEW_YORK';
    return 'ASIA';
  }

  private formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainMins = minutes % 60;
    if (hours < 24) return `${hours}h ${remainMins}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
}
