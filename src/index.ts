import 'dotenv/config';
import { CoinSwitchProvider } from './providers/CoinSwitchProvider.js';
import { BinanceProvider } from './providers/BinanceProvider.js';
import { DiscordNotifier } from './services/DiscordNotifier.js';
import { SignalEngine } from './engines/SignalEngine.js';
import { OrderExecutor } from './services/OrderExecutor.js';
import { SymbolService } from './services/SymbolService.js';

const {
  // CoinSwitch Webhooks
  DISCORD_SIGNALS_WEBHOOK_URL,
  DISCORD_TRADES_WEBHOOK_URL,
  DISCORD_RESULTS_WEBHOOK_URL,
  // Binance Webhooks
  BINANCE_SIGNALS_WEBHOOK_URL,
  BINANCE_TRADES_WEBHOOK_URL,
  BINANCE_RESULTS_WEBHOOK_URL,
  // API Keys
  COINSWITCH_API_KEY,
  COINSWITCH_SECRET_KEY,
  BINANCE_API_KEY,
  BINANCE_SECRET_KEY,
  BINANCE_TESTNET,
  // Order Execution
  ENABLE_TESTNET_ORDERS,
} = process.env;

async function start() {
  console.log('Checking environment variables...');
  
  // ============================================
  // ENGINE A: COINSWITCH (Polling)
  // ============================================
  console.log('Initializing CoinSwitch Notifier...');
  const csNotifier = new DiscordNotifier(
    DISCORD_SIGNALS_WEBHOOK_URL || '', 
    DISCORD_TRADES_WEBHOOK_URL || '',
    DISCORD_RESULTS_WEBHOOK_URL || ''
  );
  
  if (!COINSWITCH_API_KEY || !COINSWITCH_SECRET_KEY) {
    console.error('Error: COINSWITCH_API_KEY and COINSWITCH_SECRET_KEY are required.');
    process.exit(1);
  }

  console.log('Initializing CoinSwitch Provider...');
  const csProvider = new CoinSwitchProvider(COINSWITCH_API_KEY, COINSWITCH_SECRET_KEY);
  const csSymbols = await SymbolService.getTopSymbols(csProvider, 20);

  const csEngine = new SignalEngine([csProvider], csNotifier, csSymbols);
  console.log('🚀 CoinSwitch Engine Started.');
  csEngine.run(); // Async, don't await so Binance can start too

  // ============================================
  // ENGINE B: BINANCE (WebSockets)
  // ============================================
  console.log('Initializing Binance Notifier...');
  const binanceNotifier = new DiscordNotifier(
    BINANCE_SIGNALS_WEBHOOK_URL || '', 
    BINANCE_TRADES_WEBHOOK_URL || '',
    BINANCE_RESULTS_WEBHOOK_URL || ''
  );

  console.log('Initializing Binance Provider...');
  const isTestnet = BINANCE_TESTNET === 'true';
  const binanceProvider = new BinanceProvider(BINANCE_API_KEY, BINANCE_SECRET_KEY, isTestnet);
  const binanceSymbols = await SymbolService.getBinanceTopSymbols(20, isTestnet);

  // Initialize OrderExecutor for testnet demo trading (only if API keys + flag are set)
  let orderExecutor: OrderExecutor | undefined;
  if (BINANCE_API_KEY && BINANCE_SECRET_KEY && ENABLE_TESTNET_ORDERS === 'true') {
    try {
      orderExecutor = new OrderExecutor(BINANCE_API_KEY, BINANCE_SECRET_KEY, isTestnet);
    } catch (e: any) {
      console.error(`[OrderExecutor] ${e.message}`);
    }
  }

  const binanceEngine = new SignalEngine([binanceProvider], binanceNotifier, binanceSymbols, orderExecutor);
  console.log('🚀 Binance Engine Started.' + (orderExecutor ? ' (Testnet Orders ENABLED)' : ' (Signals Only)'));
  binanceEngine.run();
}

start().catch(err => {
  console.error('Fatal Error during startup:');
  if (err.response) {
    console.error('API Response Error:', err.response.data);
  } else {
    console.error(err);
  }
  process.exit(1);
});
