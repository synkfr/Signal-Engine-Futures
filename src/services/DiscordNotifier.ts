import axios from 'axios';

export class DiscordNotifier {
  private signalsWebhookUrl: string;
  private tradesWebhookUrl: string;
  private resultsWebhookUrl: string;

  constructor(signalsWebhookUrl: string, tradesWebhookUrl: string, resultsWebhookUrl: string) {
    this.signalsWebhookUrl = signalsWebhookUrl;
    this.tradesWebhookUrl = tradesWebhookUrl;
    this.resultsWebhookUrl = resultsWebhookUrl;
    
    if (!this.signalsWebhookUrl || this.signalsWebhookUrl.includes('PASTE_')) {
      console.warn('⚠️ DISCORD_SIGNALS_WEBHOOK_URL is not set or invalid.');
    }
    if (!this.tradesWebhookUrl || this.tradesWebhookUrl.includes('PASTE_')) {
      console.warn('⚠️ DISCORD_TRADES_WEBHOOK_URL is not set or invalid.');
    }
    if (!this.resultsWebhookUrl || this.resultsWebhookUrl.includes('PASTE_')) {
      console.warn('⚠️ DISCORD_RESULTS_WEBHOOK_URL is not set or invalid.');
    }
  }

  /**
   * Sends a market signal to the Signals channel.
   */
  async sendSignal(payload: string | object): Promise<void> {
    await this.sendToWebhook(this.signalsWebhookUrl, payload);
  }

  /**
   * Sends a virtual trade opening alert to the Trades channel.
   */
  async sendVirtualTrade(payload: string | object): Promise<void> {
    await this.sendToWebhook(this.tradesWebhookUrl, payload);
  }

  /**
   * Sends a virtual trade result or SL movement to the Results channel.
   */
  async sendTradeResult(payload: string | object): Promise<void> {
    await this.sendToWebhook(this.resultsWebhookUrl, payload);
  }

  private async sendToWebhook(url: string, payload: string | object): Promise<void> {
    if (!url || url.includes('PASTE_')) return;

    try {
      const data = typeof payload === 'string' ? { content: payload } : payload;
      await axios.post(url, data);
    } catch (error: any) {
      console.error('[DiscordNotifier] Failed to send message:', error.message);
    }
  }
}
