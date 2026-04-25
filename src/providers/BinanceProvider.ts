import axios from 'axios';
import WebSocket from 'ws';
import { MarketProvider, OHLCV } from './MarketProvider.js';

export class BinanceProvider implements MarketProvider {
  name = 'Binance';
  private baseURL = 'https://fapi.binance.com/fapi/v1';
  private wsURL = 'wss://fstream.binance.com/stream?streams=';
  
  private apiKey?: string;
  private secretKey?: string;

  // In-memory cache for ultra-fast SignalEngine processing
  private klineCache: Map<string, OHLCV[]> = new Map();
  private ws: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private symbols: string[] = [];

  // Callbacks
  public onCandleClose?: (symbol: string, klines: OHLCV[]) => void;

  constructor(apiKey?: string, secretKey?: string, isTestnet: boolean = false) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    if (isTestnet) {
      this.baseURL = 'https://demo-fapi.binance.com/fapi/v1';
      this.wsURL = 'wss://fstream.binancefuture.com/stream?streams=';
    }
  }

  async initialize(symbols: string[]) {
    this.symbols = symbols;
    console.log(`[BinanceProvider] Initializing ${symbols.length} symbols...`);

    // 1. Fetch historical data via REST to populate cache
    for (const symbol of symbols) {
      await this.fetchHistoricalKlines(symbol);
      await new Promise(r => setTimeout(r, 100)); // prevent rate limit
    }

    // 2. Start WebSocket for live updates
    this.startWebSocket();
  }

  private async fetchHistoricalKlines(symbol: string) {
    try {
      const response = await axios.get<any>(`${this.baseURL}/klines`, {
        params: { symbol: symbol, interval: '15m', limit: 200 }
      });
      
      const klines: OHLCV[] = response.data.map((k: any) => ({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5])
      }));

      this.klineCache.set(symbol, klines);
    } catch (e: any) {
      console.error(`[BinanceProvider] Failed to fetch historical data for ${symbol}:`, e.message);
    }
  }

  private startWebSocket() {
    // Binance streams are lowercase
    const streams = this.symbols.map(s => `${s.toLowerCase()}@kline_15m`).join('/');
    const url = `${this.wsURL}${streams}`;
    
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[BinanceProvider] WebSocket Connected for live Klines.');
      // Binance requires periodic pong frames to keep connection alive
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 3 * 60 * 1000); // Every 3 minutes
    });

    this.ws.on('message', (rawData: WebSocket.RawData) => {
      const parsed = JSON.parse(rawData.toString());
      if (!parsed.data || !parsed.data.k) return;

      const klineData = parsed.data.k;
      const symbol = parsed.data.s;
      const isClosed = klineData.x; // Is this kline closed?

      // Update Cache
      const klines = this.klineCache.get(symbol);
      if (!klines) return;

      const latestKline: OHLCV = {
        timestamp: klineData.t,
        open: parseFloat(klineData.o),
        high: parseFloat(klineData.h),
        low: parseFloat(klineData.l),
        close: parseFloat(klineData.c),
        volume: parseFloat(klineData.v)
      };

      const lastStored = klines[klines.length - 1];
      if (lastStored.timestamp === latestKline.timestamp) {
        // Update current active candle
        klines[klines.length - 1] = latestKline;
      } else {
        // New candle started
        klines.push(latestKline);
        if (klines.length > 200) klines.shift(); // Keep only 200
      }

      // Zero-Delay Trigger! If candle closed, fire event immediately!
      if (isClosed && this.onCandleClose) {
        this.onCandleClose(symbol, [...klines]);
      }
    });

    this.ws.on('close', () => {
      console.warn('[BinanceProvider] WebSocket Disconnected. Reconnecting in 5s...');
      if (this.pingInterval) clearInterval(this.pingInterval);
      setTimeout(() => this.startWebSocket(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('[BinanceProvider] WebSocket Error:', err.message);
    });
  }

  // MarketProvider Interface methods
  async fetchOHLCV(symbol: string, timeframe: string, limit: number = 200): Promise<OHLCV[]> {
    // If it's 15m, return the live WebSocket cache instantly
    if (timeframe === '15m') {
      const cached = this.klineCache.get(symbol);
      if (cached) return cached;
    }
    
    // Otherwise (e.g., 4h), fetch fresh from REST API
    try {
      const response = await axios.get<any>(`${this.baseURL}/klines`, {
        params: { symbol: symbol, interval: timeframe, limit: limit }
      });
      
      return response.data.map((k: any) => ({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5])
      }));
    } catch (e: any) {
      console.error(`[BinanceProvider] Failed to fetch ${timeframe} data for ${symbol}:`, e.message);
      return [];
    }
  }

  async getTicker(symbol: string): Promise<{ last: number; symbol: string }> {
    try {
      // Binance docs: v2 is the correct ticker/price endpoint
      const v2URL = this.baseURL.replace('/fapi/v1', '/fapi/v2');
      const response = await axios.get<any>(`${v2URL}/ticker/price`, {
        params: { symbol }
      });
      return { last: parseFloat(response.data.price), symbol };
    } catch (e: any) {
      console.error(`[BinanceProvider] Failed to fetch ticker for ${symbol}`);
      return { last: 0, symbol };
    }
  }

  // Advanced Binance Exclusive Features
  async fetchOpenInterest(symbol: string): Promise<number | null> {
    try {
      const response = await axios.get<any>(`${this.baseURL}/openInterest`, {
        params: { symbol }
      });
      return parseFloat(response.data.openInterest);
    } catch (e: any) {
      return null;
    }
  }

  async fetchFundingRate(symbol: string): Promise<number | null> {
    try {
      const response = await axios.get<any>(`${this.baseURL}/premiumIndex`, {
        params: { symbol }
      });
      return parseFloat(response.data.lastFundingRate);
    } catch (e: any) {
      return null;
    }
  }
}
