import axios from 'axios';
import WebSocket from 'ws';
import { MarketProvider, OHLCV } from './MarketProvider.js';

// ============================================================
// BINANCE FUTURES PROVIDER — WebSocket + REST
// Real-time 15m kline streaming with exponential reconnect backoff.
// ============================================================

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

  // Reconnection state
  private reconnectAttempt: number = 0;
  private readonly MAX_RECONNECT_DELAY = 60000; // 60s max
  private lastMessageTime: number = 0;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

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
    const batchSize = 5;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      await Promise.all(batch.map(s => this.fetchHistoricalKlines(s)));
      if (i + batchSize < symbols.length) {
        await new Promise(r => setTimeout(r, 500)); // Rate limit breathing room
      }
    }

    console.log(`[BinanceProvider] Historical data loaded for ${symbols.length} symbols.`);

    // 2. Start WebSocket for live updates
    this.startWebSocket();

    // 3. Start health check
    this.startHealthCheck();
  }

  private async fetchHistoricalKlines(symbol: string) {
    try {
      const response = await axios.get<any>(`${this.baseURL}/klines`, {
        params: { symbol, interval: '15m', limit: 200 }
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
    // Binance combined streams: max 200 per connection
    // For 50 symbols, we need 1 connection
    const streams = this.symbols.map(s => `${s.toLowerCase()}@kline_15m`).join('/');
    const url = `${this.wsURL}${streams}`;
    
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log(`[BinanceProvider] ✅ WebSocket connected (${this.symbols.length} streams).`);
      this.reconnectAttempt = 0; // Reset backoff on successful connect
      this.lastMessageTime = Date.now();

      // Binance requires periodic pong frames
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 3 * 60 * 1000);
    });

    this.ws.on('message', (rawData: WebSocket.RawData) => {
      this.lastMessageTime = Date.now();

      const parsed = JSON.parse(rawData.toString());
      if (!parsed.data || !parsed.data.k) return;

      const klineData = parsed.data.k;
      const symbol = parsed.data.s;
      const isClosed = klineData.x;

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
        klines[klines.length - 1] = latestKline;
      } else {
        klines.push(latestKline);
        if (klines.length > 200) klines.shift();
      }

      // Zero-delay trigger on candle close
      if (isClosed && this.onCandleClose) {
        this.onCandleClose(symbol, [...klines]);
      }
    });

    this.ws.on('close', () => {
      console.warn('[BinanceProvider] ⚠️ WebSocket disconnected.');
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[BinanceProvider] WebSocket error:', err.message);
    });
  }

  /**
   * Exponential backoff reconnection: 5s → 10s → 20s → 40s → 60s (max)
   */
  private scheduleReconnect() {
    const baseDelay = 5000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempt), this.MAX_RECONNECT_DELAY);
    this.reconnectAttempt++;
    console.log(`[BinanceProvider] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempt})...`);
    setTimeout(() => this.startWebSocket(), delay);
  }

  /**
   * Health check: warn if no data received for > 2 minutes
   */
  private startHealthCheck() {
    this.healthCheckInterval = setInterval(() => {
      if (this.lastMessageTime > 0) {
        const silenceMs = Date.now() - this.lastMessageTime;
        if (silenceMs > 2 * 60 * 1000) {
          console.warn(`[BinanceProvider] ⚠️ No WebSocket data for ${Math.floor(silenceMs / 1000)}s. Connection may be stale.`);
        }
      }
    }, 60 * 1000); // Check every minute
  }

  // ── MarketProvider Interface ──

  async fetchOHLCV(symbol: string, timeframe: string, limit: number = 200): Promise<OHLCV[]> {
    if (timeframe === '15m') {
      const cached = this.klineCache.get(symbol);
      if (cached) return cached;
    }
    
    try {
      const response = await axios.get<any>(`${this.baseURL}/klines`, {
        params: { symbol, interval: timeframe, limit }
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
      const v2URL = this.baseURL.replace('/fapi/v1', '/fapi/v2');
      const response = await axios.get<any>(`${v2URL}/ticker/price`, { params: { symbol } });
      return { last: parseFloat(response.data.price), symbol };
    } catch (e: any) {
      console.error(`[BinanceProvider] Failed to fetch ticker for ${symbol}`);
      return { last: 0, symbol };
    }
  }

  // ── Advanced Binance Features ──

  async fetchOpenInterest(symbol: string): Promise<number | null> {
    try {
      const response = await axios.get<any>(`${this.baseURL}/openInterest`, { params: { symbol } });
      return parseFloat(response.data.openInterest);
    } catch (e: any) {
      return null;
    }
  }

  async fetchFundingRate(symbol: string): Promise<number | null> {
    try {
      const response = await axios.get<any>(`${this.baseURL}/premiumIndex`, { params: { symbol } });
      return parseFloat(response.data.lastFundingRate);
    } catch (e: any) {
      return null;
    }
  }
}
