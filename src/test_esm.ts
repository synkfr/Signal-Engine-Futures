import dotenv from 'dotenv';
import { CoinSwitchProvider } from './providers/CoinSwitchProvider.js';

dotenv.config();

async function run() {
  const provider = new CoinSwitchProvider(process.env.COINSWITCH_API_KEY!, process.env.COINSWITCH_SECRET_KEY!);
  
  const klines = await provider.fetchOHLCV('BTCUSDT', '15m', 5);
  console.log('Klines returned:', klines.length);
  if (klines.length > 0) {
    console.log('Success, 15m is valid.');
  }
}

run();
