export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketProvider {
  name: string;
  fetchOHLCV(symbol: string, timeframe: string, limit?: number): Promise<OHLCV[]>;
  getTicker(symbol: string): Promise<{ last: number; symbol: string }>;
}
