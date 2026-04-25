import axios from 'axios';

export class CurrencyService {
  /**
   * Formats a raw number to exact 5 decimal places.
   * Useful for Futures limit orders where precision is required.
   */
  static formatUSDT(amount: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 5,
    }).format(amount).replace('$', '$'); // Using $ to represent USDT
  }

  // We keep this empty method to avoid breaking imports where updateRate was called
  static async updateRate(): Promise<number> {
    return 1;
  }
}
