import axios from 'axios';
import crypto from 'crypto';

// ============================================================
// ORDER EXECUTOR — Binance Futures Testnet (Demo Trading)
// Places real orders using FAKE money on Binance's demo server.
// SAFETY: Will NEVER execute on mainnet unless both
//   BINANCE_TESTNET=false AND ENABLE_LIVE_ORDERS=true
// ============================================================

interface OrderResult {
  orderId: number;
  symbol: string;
  side: string;
  type: string;
  price: string;
  status: string;
}

export class OrderExecutor {
  private baseURL: string;
  private apiKey: string;
  private secretKey: string;
  private isTestnet: boolean;
  private leverage: number;

  constructor(apiKey: string, secretKey: string, isTestnet: boolean = true, leverage: number = 5) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.isTestnet = isTestnet;
    this.leverage = leverage;

    // SAFETY GUARD: Block live mainnet unless explicitly enabled
    if (!isTestnet) {
      const enableLive = process.env.ENABLE_LIVE_ORDERS === 'true';
      if (!enableLive) {
        throw new Error(
          '🛑 SAFETY BLOCK: You are trying to use LIVE mainnet orders without ENABLE_LIVE_ORDERS=true. ' +
          'This is a safety guard. If you REALLY want to use real money, set ENABLE_LIVE_ORDERS=true in your .env file.'
        );
      }
      this.baseURL = 'https://fapi.binance.com';
      console.warn('⚠️  WARNING: OrderExecutor is running on LIVE MAINNET. Real money at risk!');
    } else {
      this.baseURL = 'https://demo-fapi.binance.com';
      console.log('✅ OrderExecutor initialized on TESTNET (demo trading, fake money).');
    }
  }

  /**
   * Generate HMAC SHA256 signature for Binance authenticated endpoints.
   */
  private sign(queryString: string): string {
    return crypto.createHmac('sha256', this.secretKey).update(queryString).digest('hex');
  }

  /**
   * Make a signed request to Binance.
   */
  private async signedRequest(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, any> = {}): Promise<any> {
    params.timestamp = Date.now();
    params.recvWindow = 5000;

    const queryString = Object.entries(params)
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    const signature = this.sign(queryString);
    const fullQuery = `${queryString}&signature=${signature}`;

    const url = `${this.baseURL}${path}?${fullQuery}`;

    try {
      const response = await axios({
        method,
        url,
        headers: { 'X-MBX-APIKEY': this.apiKey }
      });
      return response.data;
    } catch (e: any) {
      const errData = e.response?.data;
      console.error(`[OrderExecutor] API Error: ${errData?.msg || e.message} (code: ${errData?.code})`);
      throw e;
    }
  }

  /**
   * Setup the symbol for trading: set margin type and leverage.
   * Called once per symbol before placing orders.
   */
  async setupSymbol(symbol: string): Promise<void> {
    // Set ISOLATED margin
    try {
      await this.signedRequest('POST', '/fapi/v1/marginType', {
        symbol,
        marginType: 'ISOLATED',
      });
      console.log(`[OrderExecutor] Set ${symbol} to ISOLATED margin.`);
    } catch (e: any) {
      // Error -4046 means already set to ISOLATED, ignore
      if (e.response?.data?.code !== -4046) {
        console.error(`[OrderExecutor] Failed to set margin type for ${symbol}:`, e.response?.data?.msg);
      }
    }

    // Set leverage
    try {
      await this.signedRequest('POST', '/fapi/v1/leverage', {
        symbol,
        leverage: this.leverage,
      });
      console.log(`[OrderExecutor] Set ${symbol} leverage to ${this.leverage}x.`);
    } catch (e: any) {
      console.error(`[OrderExecutor] Failed to set leverage for ${symbol}:`, e.response?.data?.msg);
    }
  }

  /**
   * Get available USDT balance.
   */
  async getAvailableBalance(): Promise<number> {
    const data = await this.signedRequest('GET', '/fapi/v2/balance');
    const usdt = data.find((b: any) => b.asset === 'USDT');
    return usdt ? parseFloat(usdt.availableBalance) : 0;
  }

  /**
   * Execute a full SLC trade: Market Entry + Stop Loss + Take Profit.
   * Position size is calculated based on risk percentage of available balance.
   */
  async executeTrade(
    symbol: string,
    side: 'BUY' | 'SELL',
    entryPrice: number,
    stopLoss: number,
    takeProfit: number,
    riskPercent: number = 1 // Risk 1% of balance per trade
  ): Promise<{ entryOrder: any; slOrder: any; tpOrder: any } | null> {
    try {
      // 1. Setup symbol (margin + leverage)
      await this.setupSymbol(symbol);

      // 2. Calculate position size based on risk
      const balance = await this.getAvailableBalance();
      const riskAmount = balance * (riskPercent / 100);
      const slDistance = Math.abs(entryPrice - stopLoss);
      
      if (slDistance === 0) {
        console.error('[OrderExecutor] SL distance is 0, cannot calculate position size.');
        return null;
      }

      // Quantity = Risk Amount / (SL Distance * Leverage adjustment)
      let quantity = (riskAmount * this.leverage) / entryPrice;
      // Round to reasonable precision (3 decimal places for most pairs)
      quantity = Math.floor(quantity * 1000) / 1000;

      if (quantity <= 0) {
        console.error(`[OrderExecutor] Calculated quantity is 0. Balance: ${balance} USDT, Risk: ${riskAmount} USDT`);
        return null;
      }

      console.log(`[OrderExecutor] Placing ${side} order for ${symbol}: Qty=${quantity}, Entry≈${entryPrice}, SL=${stopLoss}, TP=${takeProfit}`);
      console.log(`[OrderExecutor] Risk: ${riskPercent}% of ${balance.toFixed(2)} USDT = ${riskAmount.toFixed(2)} USDT`);

      // 3. Place MARKET entry order
      const entryOrder = await this.signedRequest('POST', '/fapi/v1/order', {
        symbol,
        side,
        type: 'MARKET',
        quantity,
      });
      console.log(`[OrderExecutor] ✅ Entry filled: OrderID=${entryOrder.orderId}, Price=${entryOrder.avgPrice || 'market'}`);

      // 4. Place STOP_MARKET (Stop Loss) — opposite side to close
      const slSide = side === 'BUY' ? 'SELL' : 'BUY';
      const slOrder = await this.signedRequest('POST', '/fapi/v1/order', {
        symbol,
        side: slSide,
        type: 'STOP_MARKET',
        stopPrice: stopLoss.toFixed(2),
        closePosition: 'true', // Close entire position
        workingType: 'CONTRACT_PRICE',
      });
      console.log(`[OrderExecutor] ✅ Stop Loss placed at ${stopLoss}: OrderID=${slOrder.orderId}`);

      // 5. Place TAKE_PROFIT_MARKET — opposite side to close
      const tpOrder = await this.signedRequest('POST', '/fapi/v1/order', {
        symbol,
        side: slSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: takeProfit.toFixed(2),
        closePosition: 'true',
        workingType: 'CONTRACT_PRICE',
      });
      console.log(`[OrderExecutor] ✅ Take Profit placed at ${takeProfit}: OrderID=${tpOrder.orderId}`);

      return { entryOrder, slOrder, tpOrder };
    } catch (e: any) {
      console.error(`[OrderExecutor] ❌ Trade execution failed for ${symbol}:`, e.message);
      return null;
    }
  }

  /**
   * Cancel all open orders for a symbol.
   */
  async cancelAllOrders(symbol: string): Promise<void> {
    try {
      await this.signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol });
      console.log(`[OrderExecutor] Cancelled all open orders for ${symbol}.`);
    } catch (e: any) {
      console.error(`[OrderExecutor] Failed to cancel orders for ${symbol}:`, e.message);
    }
  }
}
