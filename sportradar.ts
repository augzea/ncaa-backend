import type { League, SportradarGame, SportradarBoxscore } from './types.js';

const SPORTRADAR_BASE_URL = 'https://api.sportradar.com/ncaamb/trial/v8/en';
const SPORTRADAR_WBB_BASE_URL = 'https://api.sportradar.com/ncaawb/trial/v8/en';

export class SportradarClient {
  private apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('Sportradar API key is required');
    }
    this.apiKey = apiKey;
  }

  private getBaseUrl(league: League): string {
    return league === 'MENS' ? SPORTRADAR_BASE_URL : SPORTRADAR_WBB_BASE_URL;
  }

  private async fetch<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Sportradar API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Fetch schedule for a specific date
   */
  async getDailySchedule(league: League, date: Date): Promise<{ games: SportradarGame[] }> {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    const baseUrl = this.getBaseUrl(league);
    const url = `${baseUrl}/games/${year}/${month}/${day}/schedule.json?api_key=${this.apiKey}`;

    return this.fetch<{ games: SportradarGame[] }>(url);
  }

  /**
   * Fetch schedule for a date range (up to 14 days)
   */
  async getScheduleRange(league: League, startDate: Date, days: number = 14): Promise<SportradarGame[]> {
    const allGames: SportradarGame[] = [];

    for (let i = 0; i < days; i++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + i);

      try {
        const result = await this.getDailySchedule(league, date);
        if (result.games) {
          allGames.push(...result.games);
        }
        // Rate limiting: wait 1 second between requests
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`Error fetching schedule for ${date.toISOString().split('T')[0]}:`, error);
      }
    }

    return allGames;
  }

  /**
   * Fetch game boxscore/summary
   */
  async getBoxscore(league: League, gameId: string): Promise<SportradarBoxscore> {
    const baseUrl = this.getBaseUrl(league);
    const url = `${baseUrl}/games/${gameId}/boxscore.json?api_key=${this.apiKey}`;

    return this.fetch<SportradarBoxscore>(url);
  }

  /**
   * Fetch season schedule to get all teams
   */
  async getSeasonSchedule(league: League, season: string): Promise<{ games: SportradarGame[] }> {
    // Season format for Sportradar: "2025" for 2025-26 season
    const seasonYear = season.split('-')[0];
    const baseUrl = this.getBaseUrl(league);
    const url = `${baseUrl}/games/${seasonYear}/REG/schedule.json?api_key=${this.apiKey}`;

    return this.fetch<{ games: SportradarGame[] }>(url);
  }
}

// Singleton instance
let clientInstance: SportradarClient | null = null;

export function getSportradarClient(): SportradarClient {
  if (!clientInstance) {
    const apiKey = process.env.SPORTRADAR_API_KEY;
    if (!apiKey) {
      throw new Error('SPORTRADAR_API_KEY environment variable is not set');
    }
    clientInstance = new SportradarClient(apiKey);
  }
  return clientInstance;
}
