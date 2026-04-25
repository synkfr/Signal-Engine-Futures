import { MarketProvider } from '../providers/MarketProvider.js';
import { DiscordNotifier } from '../services/DiscordNotifier.js';
import { CurrencyService } from '../services/CurrencyService.js';
import { MarketAnalyzer, MarketAnalysis } from '../services/MarketAnalyzer.js';
import { PriceActionAnalyzer } from '../services/PriceActionAnalyzer.js';
import { SLCStrategy } from '../strategies/SLCStrategy.js';
import { VirtualTradeTracker, VirtualTrade } from '../services/VirtualTradeTracker.js';
import { DatabaseManager } from '../services/DatabaseManager.js';
import { MLAnalyzer } from '../services/MLAnalyzer.js';
import { OrderExecutor } from '../services/OrderExecutor.js';

export class SignalEngine {
  private providers: MarketProvider[];
  private notifier: DiscordNotifier;
  private symbols: string[];
  private coinSwitchPrices: Record<string, number> = {};
  private tracker: VirtualTradeTracker;
  private orderExecutor: OrderExecutor | null = null;

  constructor(providers: MarketProvider[], notifier: DiscordNotifier, symbols: string[], orderExecutor?: OrderExecutor) {
    this.providers = providers;
    this.notifier = notifier;
    this.symbols = symbols;
    this.tracker = new VirtualTradeTracker();
    this.orderExecutor = orderExecutor || null;
    
    // Initialize DB asynchronously in run() but constructor is fine for class setup

    // Setup Virtual Trade Listeners
    this.tracker.onBreakeven = async (trade) => {
      const displaySymbol = trade.symbol.toUpperCase().replace('USDT', '/USDT');
      const entryUSDT = CurrencyService.formatUSDT(trade.entryPrice);
      const slUSDT = CurrencyService.formatUSDT(trade.currentSL);
      const payload = {
        embeds: [{
          title: `🛡️ STOP LOSS → BREAKEVEN`,
          description: `**${displaySymbol}** is now risk-free! SL moved to entry price.`,
          color: 0xFACC15,
          fields: [
            { name: '📊 Pair', value: `\`${displaySymbol}\``, inline: true },
            { name: '📍 Direction', value: trade.type === 'LONG' ? '🟢 LONG' : '🔴 SHORT', inline: true },
            { name: '🔒 New SL', value: `\`${slUSDT}\``, inline: true },
            { name: '💰 Entry', value: `\`${entryUSDT}\``, inline: true },
            { name: '🎯 Take Profit', value: `\`${CurrencyService.formatUSDT(trade.takeProfit)}\``, inline: true },
            { name: '📈 Status', value: '`RISK FREE`', inline: true },
          ],
          footer: { text: `${trade.exchange} • Trade ID: ${trade.id}` },
          timestamp: new Date().toISOString()
        }]
      };
      await this.notifier.sendTradeResult(payload);
    };

    this.tracker.onTrailingUpdate = async (trade) => {
      const displaySymbol = trade.symbol.toUpperCase().replace('USDT', '/USDT');
      const slUSDT = CurrencyService.formatUSDT(trade.currentSL);
      const entryUSDT = CurrencyService.formatUSDT(trade.entryPrice);
      // Calculate locked-in profit
      const lockedPnl = trade.type === 'LONG'
        ? ((trade.currentSL - trade.entryPrice) / trade.entryPrice * 100)
        : ((trade.entryPrice - trade.currentSL) / trade.entryPrice * 100);
      const payload = {
        embeds: [{
          title: `📈 TRAILING STOP UPDATED`,
          description: `**${displaySymbol}** trailing SL tightened. Profit locked in!`,
          color: 0x3B82F6,
          fields: [
            { name: '📊 Pair', value: `\`${displaySymbol}\``, inline: true },
            { name: '📍 Direction', value: trade.type === 'LONG' ? '🟢 LONG' : '🔴 SHORT', inline: true },
            { name: '🔒 Trailing SL', value: `\`${slUSDT}\``, inline: true },
            { name: '💰 Entry', value: `\`${entryUSDT}\``, inline: true },
            { name: '✅ Locked PnL', value: `\`${lockedPnl > 0 ? '+' : ''}${lockedPnl.toFixed(2)}%\``, inline: true },
            { name: '📈 Status', value: '`TRAILING`', inline: true },
          ],
          footer: { text: `${trade.exchange} • ATR-based trailing stop` },
          timestamp: new Date().toISOString()
        }]
      };
      await this.notifier.sendTradeResult(payload);
    };

    this.tracker.onClosed = async (trade) => {
      const displaySymbol = trade.symbol.toUpperCase().replace('USDT', '/USDT');
      const entryUSDT = CurrencyService.formatUSDT(trade.entryPrice);
      const closeUSDT = CurrencyService.formatUSDT(trade.closePrice!);
      
      // Calculate PnL
      let pnlPercent = 0;
      if (trade.type === 'LONG') {
        pnlPercent = ((trade.closePrice! - trade.entryPrice) / trade.entryPrice) * 100;
      } else {
        pnlPercent = ((trade.entryPrice - trade.closePrice!) / trade.entryPrice) * 100;
      }
      
      const isWin = pnlPercent > 0.05;
      const isBE = Math.abs(pnlPercent) <= 0.05;
      
      let color = 0xEF4444; // Red for loss
      let resultEmoji = '🛑';
      let resultLabel = 'LOSS';
      if (isWin) { color = 0x22C55E; resultEmoji = '🏆'; resultLabel = 'WIN'; }
      if (isBE) { color = 0xFACC15; resultEmoji = '🔄'; resultLabel = 'BREAKEVEN'; }

      const payload = {
        embeds: [{
          title: `${resultEmoji} TRADE CLOSED — ${resultLabel}`,
          description: `**${displaySymbol}** closed via **${trade.closeReason}**`,
          color: color,
          fields: [
            { name: '📊 Pair', value: `\`${displaySymbol}\``, inline: true },
            { name: '📍 Direction', value: trade.type === 'LONG' ? '🟢 LONG' : '🔴 SHORT', inline: true },
            { name: `${isWin ? '✅' : '❌'} PnL`, value: `\`${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%\``, inline: true },
            { name: '💰 Entry', value: `\`${entryUSDT}\``, inline: true },
            { name: '🏁 Exit', value: `\`${closeUSDT}\``, inline: true },
            { name: '📋 Reason', value: `\`${trade.closeReason}\``, inline: true },
            { name: '🏷️ Pattern', value: `\`${trade.metadata?.pattern || 'N/A'}\``, inline: true },
            { name: '📊 Regime', value: `\`${trade.metadata?.regime || 'N/A'}\``, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
          ],
          footer: { text: `${trade.exchange} • ${trade.id}` },
          timestamp: new Date().toISOString()
        }]
      };
      await this.notifier.sendTradeResult(payload);
      
      // Log for self-improvement
      await DatabaseManager.logTrade(trade);
    };
  }

  async run() {
    console.log('🚀 Signal Engine Starting...');
    console.log(`[SignalEngine] Monitoring ${this.symbols.length} symbols...`);

    // Initialize shared services for ALL engine paths
    await DatabaseManager.initialize();
    await CurrencyService.updateRate();

    const provider = this.providers[0];

    if (provider.name === 'Binance' && 'onCandleClose' in provider) {
      console.log(`[SignalEngine] WebSocket Mode Detected! Using zero-delay event listeners...`);
      
      // Initialize the provider and hook into the event
      await (provider as any).initialize(this.symbols);
      
      (provider as any).onCandleClose = async (symbol: string, klines: any[]) => {
        // Zero-Delay Execution
        await this.processSymbol(provider, symbol, klines);
      };

      // Do NOT start the polling loop for Binance
      return;
    }

    // Fallback: Standard Polling Loop (CoinSwitch)

    const processAll = async () => {
      console.log(`[SignalEngine] Starting market scan at ${new Date().toISOString()}...`);
      
      const csProvider = this.providers[0];
      if (!csProvider) {
        console.error('[SignalEngine] CoinSwitch provider is required for analysis.');
        return;
      }

      try {
        this.coinSwitchPrices = await (csProvider as any).getAllTickers();
      } catch (e) {
        console.warn('[SignalEngine] Could not update CoinSwitch bulk prices.');
      }

      for (let i = 0; i < this.symbols.length; i++) {
        const symbol = this.symbols[i];
        try {
          await this.processSymbol(csProvider, symbol);
          // 4 second delay to be absolutely safe with CoinSwitch's 30 req/min limit
          await new Promise(resolve => setTimeout(resolve, 4000));
        } catch (error: any) {
          if (error.status === 429) {
            console.log(`[SignalEngine] Pausing scan for 60 seconds to clear rate limit window...`);
            await new Promise(resolve => setTimeout(resolve, 60000));
            i--; // Retry the same symbol after waiting
          } else {
            console.error(`[SignalEngine] Error analyzing ${symbol}:`, error.message);
          }
        }
      }

      console.log(`[SignalEngine] Scan complete. Waiting for next cycle...`);
      setTimeout(processAll, 10000); 
    };

    processAll();
  }

  private readonly MAX_CONCURRENT_TRADES = 3;

  // 4H kline cache with 1-hour TTL to prevent rate limit spam
  private klines4HCache: Map<string, { data: any[]; fetchedAt: number }> = new Map();
  private readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  private async get4HKlines(provider: MarketProvider, symbol: string): Promise<any[]> {
    const cached = this.klines4HCache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
      return cached.data;
    }
    const klines = await provider.fetchOHLCV(symbol, '4h', 100);
    this.klines4HCache.set(symbol, { data: klines, fetchedAt: Date.now() });
    return klines;
  }

  private async processSymbol(provider: MarketProvider, symbol: string, preloadedKlines?: any[]) {
    const klines = preloadedKlines || await provider.fetchOHLCV(symbol, '15m', 200); 
    if (klines.length < 50) return;

    // Update Virtual Tracker Market Data using the absolute latest price
    const currentPrice = klines[klines.length - 1].close;
    this.tracker.updateMarket(symbol, currentPrice, klines);

    // If trade is already active, don't look for new entries on this symbol
    if (this.tracker.getActiveTrade(symbol)) return;

    // Maximum Exposure Limit check
    if (this.tracker.getActiveTrades().length >= this.MAX_CONCURRENT_TRADES) {
      return;
    }

    // If this data was polled (not pushed via WebSocket), the last candle is incomplete.
    const closedKlines = preloadedKlines ? klines : klines.slice(0, -1);

    // =============================================
    // SLC STRATEGY: Structure → Level → Confirmation
    // =============================================
    const klines4H = await this.get4HKlines(provider, symbol);
    const slcResult = SLCStrategy.analyze(klines4H, closedKlines);

    if (slcResult) {
      const tradeType = slcResult.signal;

      // ML Filter
      const slcPattern = `SLC_${slcResult.zone.type}_${slcResult.structure}`;
      const mlEvaluation = await MLAnalyzer.evaluateSignal(slcPattern, 'TRENDING', provider.name);
      if (!mlEvaluation.approved) {
        console.log(`[ML Filter] Rejected SLC ${symbol} ${tradeType} on ${provider.name}: ${mlEvaluation.reason}`);
        return;
      }

      // SLC provides its own levels — do NOT use MarketAnalyzer
      const slcAnalysis: MarketAnalysis = {
        regime: 'TRENDING',
        adx: 0,
        atr: 0,
        trend: slcResult.structure === 'UPTREND' ? 'UP' : 'DOWN',
        levels: {
          entry: slcResult.entry,
          stopLoss: slcResult.stopLoss,
          takeProfit: slcResult.takeProfit,
        }
      };

      await this.broadcastSignal(provider, symbol, tradeType, 
        `SLC ${slcResult.zone.type} Zone`, slcAnalysis, mlEvaluation.confidence, slcResult.context);

      const tradeId = `${symbol}-${Date.now()}`;
      const virtualTrade: VirtualTrade = {
        id: tradeId,
        symbol,
        exchange: provider.name,
        type: tradeType,
        entryPrice: slcResult.entry,
        hardSL: slcResult.stopLoss,
        takeProfit: slcResult.takeProfit,
        currentSL: slcResult.stopLoss,
        status: 'ACTIVE',
        metadata: {
          pattern: `SLC ${slcResult.zone.type}`,
          context: slcResult.context.join(', '),
          regime: 'TRENDING',
          adx: 0,
          stochastic: slcResult.stochastic
        }
      };
      this.tracker.addTrade(virtualTrade);

      // Notify Virtual Trade Opened
      await this.notifyVirtualTradeOpened(virtualTrade, slcAnalysis);

      // Execute real testnet order if OrderExecutor is configured (Binance only)
      if (this.orderExecutor && provider.name === 'Binance') {
        const side = tradeType === 'LONG' ? 'BUY' as const : 'SELL' as const;
        const orderResult = await this.orderExecutor.executeTrade(
          symbol, side, slcResult.entry, slcResult.stopLoss, slcResult.takeProfit
        );
        if (orderResult) {
          console.log(`[SignalEngine] ✅ Testnet order executed for ${symbol}: Entry=${orderResult.entryOrder.orderId}`);
        }
      }
      return;
    }

    // =============================================
    // FALLBACK: Original Price Action Analyzer
    // =============================================
    const paSetup = PriceActionAnalyzer.analyze(closedKlines);
    if (!paSetup || paSetup.type === 'NEUTRAL') return;

    const tradeType = paSetup.type as 'LONG' | 'SHORT';

    // Enforce 4H structure alignment on fallback too
    // (prevents PA from firing counter-trend to SLC's macro view)
    if (klines4H.length >= 50) {
      const { EMA } = await import('technicalindicators');
      const closes4H = klines4H.map((k: any) => k.close);
      const ema21 = EMA.calculate({ period: 21, values: closes4H });
      const ema50 = EMA.calculate({ period: 50, values: closes4H });
      if (ema21.length > 0 && ema50.length > 0) {
        const lastEma21 = ema21[ema21.length - 1];
        const lastEma50 = ema50[ema50.length - 1];
        if (tradeType === 'LONG' && lastEma21 < lastEma50) return; // 4H bearish, reject LONG
        if (tradeType === 'SHORT' && lastEma21 > lastEma50) return; // 4H bullish, reject SHORT
      }
    }

    // Market Regime Analysis (for fallback only)
    const analysis = MarketAnalyzer.analyze(klines, tradeType, currentPrice);
    if (analysis.regime === 'VOLATILE') return;
    if (analysis.regime === 'TRENDING') {
      if (tradeType === 'LONG' && analysis.trend !== 'UP') return;
      if (tradeType === 'SHORT' && analysis.trend !== 'DOWN') return;
    }

    // ML Filter
    const mlEvaluation = await MLAnalyzer.evaluateSignal(paSetup.pattern, analysis.regime, provider.name);
    if (!mlEvaluation.approved) {
      console.log(`[ML Filter] Rejected ${symbol} ${tradeType} on ${provider.name}: ${mlEvaluation.reason}`);
      return;
    }

    await this.broadcastSignal(provider, symbol, tradeType, paSetup.pattern, analysis, mlEvaluation.confidence);

    const tradeId = `${symbol}-${Date.now()}`;
    const virtualTrade: VirtualTrade = {
      id: tradeId,
      symbol,
      exchange: provider.name,
      type: tradeType,
      entryPrice: analysis.levels.entry,
      hardSL: analysis.levels.stopLoss,
      takeProfit: analysis.levels.takeProfit,
      currentSL: analysis.levels.stopLoss,
      status: 'ACTIVE',
      metadata: {
        pattern: paSetup.pattern,
        context: paSetup.context.join(', '),
        regime: analysis.regime,
        adx: analysis.adx
      }
    };
    this.tracker.addTrade(virtualTrade);
    await this.notifyVirtualTradeOpened(virtualTrade, analysis);
  }

  private async notifyVirtualTradeOpened(trade: VirtualTrade, analysis: MarketAnalysis) {
    const displaySymbol = trade.symbol.toUpperCase().replace('USDT', '/USDT');
    const color = trade.type === 'LONG' ? 0x22C55E : 0xEF4444;
    const direction = trade.type === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    const risk = Math.abs(trade.entryPrice - trade.hardSL);
    const reward = Math.abs(trade.takeProfit - trade.entryPrice);
    const rrRatio = risk > 0 ? (reward / risk).toFixed(1) : '∞';
    const isSLC = trade.metadata?.pattern?.startsWith('SLC');

    const payload = {
      embeds: [{
        title: `${isSLC ? '🎯' : '🤖'} TRADE OPENED — ${displaySymbol}`,
        description: isSLC
          ? `SLC Blueprint signal confirmed. All 3 stages passed.`
          : `Price Action pattern detected. Fallback strategy active.`,
        color: color,
        fields: [
          { name: '📊 Pair', value: `\`${displaySymbol}\``, inline: true },
          { name: '📍 Direction', value: direction, inline: true },
          { name: '🏷️ Pattern', value: `\`${trade.metadata?.pattern || 'N/A'}\``, inline: true },
          { name: '💰 Entry', value: `\`${CurrencyService.formatUSDT(analysis.levels.entry)}\``, inline: true },
          { name: '🎯 Take Profit', value: `\`${CurrencyService.formatUSDT(analysis.levels.takeProfit)}\``, inline: true },
          { name: '🛑 Stop Loss', value: `\`${CurrencyService.formatUSDT(analysis.levels.stopLoss)}\``, inline: true },
          { name: '⚖️ Risk:Reward', value: `\`1:${rrRatio}\``, inline: true },
          { name: '📈 Status', value: '`ACTIVE`', inline: true },
          { name: '\u200B', value: '\u200B', inline: true },
        ],
        footer: { text: `${trade.exchange} • ${trade.id}` },
        timestamp: new Date().toISOString()
      }]
    };
    await this.notifier.sendVirtualTrade(payload);
  }

  private async broadcastSignal(provider: MarketProvider, symbol: string, type: 'LONG' | 'SHORT', pattern: string, analysis: MarketAnalysis, mlConfidence: number, slcContext?: string[]) {
    const { entry, stopLoss, takeProfit } = analysis.levels;
    const exchange = provider.name;
    
    const csPrice = this.coinSwitchPrices[symbol.toUpperCase()];
    const priceToConvert = csPrice || entry;

    const currentUSDT = CurrencyService.formatUSDT(priceToConvert);
    const entryUSDT = CurrencyService.formatUSDT(entry);
    const stopLossUSDT = CurrencyService.formatUSDT(stopLoss);
    const takeProfitUSDT = CurrencyService.formatUSDT(takeProfit);
    
    const displaySymbol = symbol.toUpperCase().replace('USDT', '/USDT');

    const mlConfidenceStr = mlConfidence === 0 ? 'Evaluating (Collecting Data)' : `${mlConfidence.toFixed(1)}% Win Rate`;
    const actionColor = type === 'LONG' ? 0x22C55E : 0xEF4444;

    const isSLC = pattern.startsWith('SLC');
    const signalEmoji = isSLC ? '🎯' : '🚀';
    const strategyLabel = isSLC ? 'SLC Blueprint' : 'Price Action';

    const fields: any[] = [
      { name: '📊 Pair', value: `\`${displaySymbol}\``, inline: true },
      { name: '📍 Action', value: `${type === 'LONG' ? '🟢 BUY / LONG' : '🔴 SELL / SHORT'}`, inline: true },
      { name: '🏷️ Strategy', value: `\`${strategyLabel}\``, inline: true },
      { name: '\u200B', value: '───── 📋 **Setup Details** ─────', inline: false },
      { name: '🔍 Pattern', value: `\`${pattern}\``, inline: true },
      { name: '🌊 Condition', value: `\`${analysis.regime} (${analysis.trend} Trend)\``, inline: true },
      { name: '💪 Trend ADX', value: `\`${analysis.adx.toFixed(1)} (${analysis.adx > 25 ? 'Strong' : 'Weak'})\``, inline: true },
      { name: '\u200B', value: '───── 💰 **Trade Levels** ─────', inline: false },
      { name: '💰 Entry', value: `\`${entryUSDT}\``, inline: true },
      { name: '🎯 Take Profit', value: `\`${takeProfitUSDT}\``, inline: true },
      { name: '🛑 Stop Loss', value: `\`${stopLossUSDT}\``, inline: true },
      { name: '⚖️ Risk:Reward', value: isSLC ? '`1:2 (SLC)`' : `\`1:${(Math.abs(takeProfit - entry) / Math.abs(stopLoss - entry)).toFixed(1)}\``, inline: true },
      { name: '🧠 ML Confidence', value: `\`${mlConfidenceStr}\``, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
    ];

    // SLC Context (Structure, Level, Confirmation details)
    if (slcContext && slcContext.length > 0) {
      fields.push({ name: '\u200B', value: '───── 🎯 **SLC Checklist** ─────', inline: false });
      fields.push({ name: '✅ Checklist', value: slcContext.map(c => `> ✅ ${c}`).join('\n'), inline: false });
    }

    // Advanced Binance Data
    if (exchange === 'Binance' && 'fetchOpenInterest' in provider && 'fetchFundingRate' in provider) {
      const oi = await (provider as any).fetchOpenInterest(symbol);
      const funding = await (provider as any).fetchFundingRate(symbol);
      
      if (oi !== null || funding !== null) {
        fields.push({ name: '\u200B', value: '───── 📊 **Market Data** ─────', inline: false });
        if (oi !== null) fields.push({ name: '📊 Open Interest', value: `\`${oi.toLocaleString()}\``, inline: true });
        if (funding !== null) {
          const fundingEmoji = funding > 0 ? '🟢' : '🔴';
          fields.push({ name: `${fundingEmoji} Funding Rate`, value: `\`${(funding * 100).toFixed(4)}%\``, inline: true });
        }
      }
    }

    const payload = {
      embeds: [{
        title: `${signalEmoji} ${isSLC ? 'SLC' : 'PA'} SIGNAL — ${displaySymbol}`,
        description: isSLC
          ? `**Structure → Level → Confirmation** all passed. High-probability setup.`
          : `**Price Action** pattern detected. Fallback strategy active.`,
        color: actionColor,
        fields: fields,
        footer: {
          text: `${exchange} • Price: ${currentUSDT} • ${strategyLabel}`
        },
        timestamp: new Date().toISOString()
      }]
    };

    console.log(`[SignalEngine] ${type} Signal sent for ${symbol} based on ${pattern} (${strategyLabel})`);
    await this.notifier.sendSignal(payload);
  }
}
