import axios from 'axios';

export class SymbolService {
  /**
   * Fetches the top symbols by 24h volume from Binance Futures.
   * Filters to USDT perpetual pairs only.
   */
  static async getBinanceTopSymbols(limit: number = 50, isTestnet: boolean = false): Promise<string[]> {
    try {
      const baseUrl = isTestnet ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';
      console.log(`[SymbolService] Fetching top ${limit} symbols from Binance ${isTestnet ? 'Testnet' : 'Mainnet'}...`);
      const response = await axios.get<any>(`${baseUrl}/fapi/v1/ticker/24hr`);
      
      const filtered = response.data
        .filter((t: any) => {
          const s = t.symbol.toUpperCase();
          return s.endsWith('USDT') && 
                 !s.includes('_');  // Exclude quarterly contracts like BTCUSDT_250627
        })
        .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, limit)
        .map((t: any) => t.symbol.toUpperCase());

      console.log(`[SymbolService] Found ${filtered.length} Binance Futures symbols.`);
      return filtered;
    } catch (e: any) {
      console.error('[SymbolService] Error fetching Binance symbols:', e.message);
      // Fallback to known high-volume pairs
      return [
        'BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'BNBUSDT', 'SOLUSDT',
        'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT'
      ];
    }
  }
}
