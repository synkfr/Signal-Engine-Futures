import { BacktestEngine } from './engines/BacktestEngine.js';

/**
 * CLI Backtest Runner
 * Usage:
 *   node dist/backtest.js BTCUSDT 3        # Single symbol, 3 months
 *   node dist/backtest.js --multi 3         # Batch test top symbols
 *   node dist/backtest.js --multi 6         # Batch test, 6 months
 */
async function main() {
  const isMulti = process.argv[2] === '--multi';
  const months = parseInt(process.argv[isMulti ? 3 : 3] || '3');

  console.log('🧪 SignalEngine Backtester');
  console.log(`Mode: ${isMulti ? 'Multi-Symbol' : 'Single'} | Period: ${months} months\n`);

  const engine = new BacktestEngine();

  if (isMulti) {
    const symbols = ['BTCUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'BNBUSDT', 'SOLUSDT', 'AVAXUSDT', 'LINKUSDT'];
    const results = [];
    
    for (const sym of symbols) {
      const r = await engine.run(sym, months);
      results.push(r);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Summary table
    console.log('\n📊 MULTI-SYMBOL SUMMARY:');
    console.log('─'.repeat(75));
    console.log(`${'Symbol'.padEnd(12)} ${'Trades'.padEnd(8)} ${'Win%'.padEnd(8)} ${'PnL%'.padEnd(10)} ${'PF'.padEnd(8)} ${'MaxDD%'.padEnd(10)} ${'Streak'.padEnd(6)}`);
    console.log('─'.repeat(75));
    for (const r of results) {
      console.log(
        `${r.symbol.padEnd(12)} ` +
        `${String(r.totalTrades).padEnd(8)} ` +
        `${r.winRate.toFixed(1).padEnd(8)} ` +
        `${((r.totalPnlPercent > 0 ? '+' : '') + r.totalPnlPercent.toFixed(2)).padEnd(10)} ` +
        `${(r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)).padEnd(8)} ` +
        `${('-' + r.maxDrawdownPercent.toFixed(2)).padEnd(10)} ` +
        `${String(r.maxConsecutiveLosses).padEnd(6)}`
      );
    }
    console.log('─'.repeat(75));

    // Aggregate stats
    const totalTrades = results.reduce((s, r) => s + r.totalTrades, 0);
    const totalWins = results.reduce((s, r) => s + r.wins, 0);
    const aggWinRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
    const aggPnl = results.reduce((s, r) => s + r.totalPnlPercent, 0);
    console.log(`\n  Aggregate: ${totalTrades} trades | ${aggWinRate.toFixed(1)}% win rate | ${aggPnl > 0 ? '+' : ''}${aggPnl.toFixed(2)}% PnL`);
  } else {
    const symbol = process.argv[2] || 'BTCUSDT';
    console.log(`Symbol: ${symbol}\n`);
    await engine.run(symbol, months);
  }
}

main().catch(console.error);
