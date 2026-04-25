import { CoinSwitchProvider } from '../providers/CoinSwitchProvider.js';
import axios from 'axios';

export class SymbolService {
  /**
   * Fetches the top symbols by 24h volume from Binance Futures.
   * Excludes SOL and ETH as requested.
   */
  static async getBinanceTopSymbols(limit: number = 20, isTestnet: boolean = false): Promise<string[]> {
    try {
      const baseUrl = isTestnet ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';
      console.log(`[SymbolService] Fetching top ${limit} symbols from Binance ${isTestnet ? 'Testnet' : 'Mainnet'}...`);
      const response = await axios.get<any>(`${baseUrl}/fapi/v1/ticker/24hr`);
      
      const filtered = response.data
        .filter((t: any) => {
          const s = t.symbol.toUpperCase();
          return s.endsWith('USDT') && 
                 !s.startsWith('SOL') &&
                 !s.startsWith('ETH');
        })
        .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, limit)
        .map((t: any) => t.symbol.toUpperCase());

      console.log(`[SymbolService] Found ${filtered.length} Binance symbols.`);
      return filtered;
    } catch (e: any) {
      console.error('[SymbolService] Error fetching Binance symbols:', e.message);
      // Fallback
      return ['BTCUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'BNBUSDT'];
    }
  }

  /**
   * Fetches the top symbols by 24h volume from CoinSwitch Futures.
   * Excludes SOL and ETH as requested.
   */
  static async getTopSymbols(provider: CoinSwitchProvider, limit: number = 20): Promise<string[]> {
    try {
      console.log(`[SymbolService] Fetching top ${limit} symbols from CoinSwitch...`);
      const tickersInfo = await provider.getAllTickersDetailed();
      
      const filtered = Object.values(tickersInfo)
        .filter((t: any) => {
          const s = t.symbol.toUpperCase();
          return s.endsWith('USDT') && 
                 !s.startsWith('SOL') &&
                 !s.startsWith('ETH') &&
                 !s.includes('USDC') && !s.includes('EUR');
        })
        .sort((a: any, b: any) => parseFloat(b.quote_asset_volume_24h) - parseFloat(a.quote_asset_volume_24h))
        .slice(0, limit)
        .map((t: any) => t.symbol.toUpperCase());

      console.log(`[SymbolService] Found ${filtered.length} symbols.`);
      return filtered;
    } catch (error) {
      console.error('[SymbolService] Error fetching top symbols:', error);
      return ['BTCUSDT', 'BNBUSDT', 'ADAUSDT', 'XRPUSDT', 'DOTUSDT'];
    }
  }
}

