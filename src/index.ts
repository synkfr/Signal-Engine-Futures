import 'dotenv/config';
import { BinanceProvider } from './providers/BinanceProvider.js';
import { DiscordNotifier } from './services/DiscordNotifier.js';
import { SignalEngine } from './engines/SignalEngine.js';
import { OrderExecutor } from './services/OrderExecutor.js';
import { SymbolService } from './services/SymbolService.js';
import { DatabaseManager } from './services/DatabaseManager.js';

const {
  // Discord Webhooks
  BINANCE_SIGNALS_WEBHOOK_URL,
  BINANCE_TRADES_WEBHOOK_URL,
  BINANCE_RESULTS_WEBHOOK_URL,
  // Binance API
  BINANCE_API_KEY,
  BINANCE_SECRET_KEY,
  BINANCE_TESTNET,
  // Order Execution
  ENABLE_TESTNET_ORDERS,
  // Symbol count
  SYMBOL_COUNT,
} = process.env;

async function start() {
  console.log('═══════════════════════════════════════════');
  console.log('  🚀 SignalEngine v2 — SLC-Only Mode');
  console.log('═══════════════════════════════════════════');

  // Initialize Database
  await DatabaseManager.initialize();

  // Discord Notifier
  const notifier = new DiscordNotifier(
    BINANCE_SIGNALS_WEBHOOK_URL || '', 
    BINANCE_TRADES_WEBHOOK_URL || '',
    BINANCE_RESULTS_WEBHOOK_URL || ''
  );

  // Binance Provider
  const isTestnet = BINANCE_TESTNET === 'true';
  const symbolCount = parseInt(SYMBOL_COUNT || '50');
  const binanceProvider = new BinanceProvider(BINANCE_API_KEY, BINANCE_SECRET_KEY, isTestnet);
  const symbols = await SymbolService.getBinanceTopSymbols(symbolCount, isTestnet);

  console.log(`[Config] Mode: ${isTestnet ? '🧪 TESTNET (Demo)' : '🔴 MAINNET (Live)'}`);
  console.log(`[Config] Symbols: ${symbols.length}`);
  console.log(`[Config] Strategy: SLC-Only`);

  // Order Executor (demo trading — places real orders on testnet with fake money)
  let orderExecutor: OrderExecutor | undefined;
  if (BINANCE_API_KEY && BINANCE_SECRET_KEY && ENABLE_TESTNET_ORDERS === 'true') {
    try {
      orderExecutor = new OrderExecutor(BINANCE_API_KEY, BINANCE_SECRET_KEY, isTestnet);
      console.log(`[Config] Orders: ✅ Demo Trading ENABLED`);
    } catch (e: any) {
      console.error(`[OrderExecutor] ${e.message}`);
    }
  } else {
    console.log(`[Config] Orders: ❌ Signals Only (set ENABLE_TESTNET_ORDERS=true to enable)`);
  }

  // Start engine
  const engine = new SignalEngine(binanceProvider, notifier, symbols, orderExecutor);
  engine.run();
}

// Graceful shutdown
let isShuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Shutdown] ${signal} received. Saving state...`);
  // DatabaseManager flushes active trades automatically in the engine
  // Give pending writes 2 seconds to complete
  await new Promise(r => setTimeout(r, 2000));
  console.log('[Shutdown] State saved. Exiting.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

start().catch(err => {
  console.error('Fatal Error during startup:');
  if (err.response) {
    console.error('API Response Error:', err.response.data);
  } else {
    console.error(err);
  }
  process.exit(1);
});
