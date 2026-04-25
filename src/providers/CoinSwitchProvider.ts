import axios from 'axios';
import nacl from 'tweetnacl';
import { MarketProvider, OHLCV } from './MarketProvider.js';

export class CoinSwitchProvider implements MarketProvider {
  public name = 'CoinSwitch Pro Futures';
  private baseURL = 'https://coinswitch.co/trade/api/v2/futures';
  private apiKey: string;
  private secretKey: string;
  private unsupportedSymbols: Set<string> = new Set();

  constructor(apiKey: string, secretKey: string) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
  }

  async getAllTickers(): Promise<Record<string, number>> {
    const method = 'GET';
    const path = '/all-pairs/ticker';
    const params = 'exchange=EXCHANGE_2';
    const fullPath = `${path}?${params}`;
    const epoch = Date.now().toString();
    const signaturePath = `/trade/api/v2/futures${fullPath}`;
    const signature = this.generateSignature(method, signaturePath, epoch);

    try {
      const response = await axios.get<any>(`${this.baseURL}${fullPath}`, {
        headers: {
          'X-AUTH-SIGNATURE': signature,
          'X-AUTH-APIKEY': this.apiKey,
          'X-AUTH-EPOCH': epoch,
        },
      });

      const tickers: Record<string, number> = {};
      if (response.data && response.data.data) {
        for (const [symbol, ticker] of Object.entries(response.data.data)) {
          tickers[symbol.toUpperCase()] = parseFloat((ticker as any).last_price);
        }
      }
      return tickers;
    } catch (error: any) {
      console.error('[CoinSwitchProvider] Error fetching bulk tickers:', error.message);
      return {};
    }
  }

  async getAllTickersDetailed(): Promise<any> {
    const method = 'GET';
    const path = '/all-pairs/ticker';
    const params = 'exchange=EXCHANGE_2';
    const fullPath = `${path}?${params}`;
    const epoch = Date.now().toString();
    const signaturePath = `/trade/api/v2/futures${fullPath}`;
    const signature = this.generateSignature(method, signaturePath, epoch);

    try {
      const response = await axios.get<any>(`${this.baseURL}${fullPath}`, {
        headers: {
          'X-AUTH-SIGNATURE': signature,
          'X-AUTH-APIKEY': this.apiKey,
          'X-AUTH-EPOCH': epoch,
        },
      });

      if (response.data && response.data.data) {
        return response.data.data;
      }
      return {};
    } catch (error: any) {
      console.error('[CoinSwitchProvider] Error fetching bulk tickers:', error.message);
      return {};
    }
  }

  private generateSignature(method: string, pathWithParams: string, epoch: string): string {
    // Crucially, CoinSwitch requires the path to be unquoted (URL decoded)
    const decodedPath = decodeURIComponent(pathWithParams);
    const message = `${method}${decodedPath}${epoch}`;
    const seed = Buffer.from(this.secretKey, 'hex');
    const messageBytes = Buffer.from(message, 'utf-8');
    
    const keyPair = nacl.sign.keyPair.fromSeed(seed);
    const signature = nacl.sign.detached(messageBytes, keyPair.secretKey);
    return Buffer.from(signature).toString('hex');
  }

  async fetchOHLCV(symbol: string, timeframe: string = '1h', limit: number = 100): Promise<OHLCV[]> {
    if (this.unsupportedSymbols.has(symbol)) return [];

    const method = 'GET';
    const path = '/klines';
    
    let interval = timeframe;
    if (timeframe === '4h') interval = '240';
    else if (timeframe === '1h') interval = '60';
    else if (timeframe === '15m') interval = '15';
    else if (timeframe === '5m') interval = '5';
    else if (timeframe === '1m') interval = '1';
    
    const params = `exchange=EXCHANGE_2&symbol=${symbol.toLowerCase()}&interval=${interval}&limit=${limit}`;
    const fullPath = `${path}?${params}`;
    const epoch = Date.now().toString();
    const signaturePath = `/trade/api/v2/futures${fullPath}`;
    const signature = this.generateSignature(method, signaturePath, epoch);

    try {
      const response = await axios.get<any>(`${this.baseURL}${fullPath}`, {
        headers: {
          'X-AUTH-SIGNATURE': signature,
          'X-AUTH-APIKEY': this.apiKey,
          'X-AUTH-EPOCH': epoch,
        },
      });

      if (!response.data || !response.data.data) {
        return [];
      }

      return response.data.data.map((d: any) => ({
        timestamp: parseInt(d.start_time),
        open: parseFloat(d.o),
        high: parseFloat(d.h),
        low: parseFloat(d.l),
        close: parseFloat(d.c),
        volume: parseFloat(d.volume),
      })).reverse();
    } catch (error: any) {
      const status = error.response?.status;
      if (status === 422) {
        this.unsupportedSymbols.add(symbol);
        return [];
      }
      if (status === 429) {
        console.warn(`[CoinSwitchProvider] Rate limit (429) hit for ${symbol}. Triggering backoff...`);
        const error: any = new Error('Rate limit exceeded');
        error.status = 429;
        throw error;
      }
      if (status >= 500) {
        // Silently ignore 500 Internal Server Errors from CoinSwitch to prevent terminal spam
        return [];
      }
      
      console.error(`[CoinSwitchProvider] Error for ${symbol}:`, error.response?.data?.message || error.message);
      return [];
    }
  }

  async getTicker(symbol: string): Promise<{ last: number; symbol: string }> {
    const klines = await this.fetchOHLCV(symbol, '1', 1);
    if (klines && klines.length > 0) {
      return {
        last: klines[0].close,
        symbol: symbol,
      };
    }
    throw new Error(`Could not fetch ticker for ${symbol}`);
  }
}
