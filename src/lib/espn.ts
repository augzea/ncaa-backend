import type { League } from './types.js';

const ESPN_MBB_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard';
const ESPN_WBB_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/scoreboard';

const ESPN_MBB_GAME_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary';
const ESPN_WBB_GAME_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/summary';

const FETCH_TIMEOUT_MS = 10000; // 10 seconds
const MAX_RETRIES = 3;
const RATE_LIMIT_MIN_MS = 300;
const RATE_LIMIT_MAX_MS = 500;

// Exported types for ESPN data
export interface ESPNTeamData {
  id: string;
  name: string;
  displayName: string;
  shortDisplayName: string;
  abbreviation: string;
  conference: string | null;
  score: number | undefined;
}

export interface ESPNEventData {
  id: string; // ESPN event id (numeric string)
  date: string;
  completed: boolean;
  statusState: 'pre' | 'in' | 'post';
  statusName: string;
  neutralSite: boolean;
  home: ESPNTeamData;
  away: ESPNTeamData;
}

export interface ESPNBoxscoreStats {
  field_goals_made: number;
  field_goals_att: number;
  three_points_made: number;
  three_points_att: number;
  free_throws_made: number;
  free_throws_att: number;
  points: number;
}

export interface ESPNBoxscore {
  id: string; // ESPN event id
  status: string;
  home: {
    id: string; // team id
    name: string;
    statistics: ESPNBoxscoreStats | undefined;
  };
  away: {
    id: string; // team id
    name: string;
    statistics: ESPNBoxscoreStats | undefined;
  };
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Random delay between min and max ms
 */
function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export class ESPNClient {
  private lastRequestTime: number = 0;

  private getScoreboardUrl(league: League): string {
    return league === 'MENS' ? ESPN_MBB_SCOREBOARD_URL : ESPN_WBB_SCOREBOARD_URL;
  }

  private getGameUrl(league: League): string {
    return league === 'MENS' ? ESPN_MBB_GAME_URL : ESPN_WBB_GAME_URL;
  }

  /**
   * Rate limit: ensure minimum delay between requests
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    const delay = randomDelay(RATE_LIMIT_MIN_MS, RATE_LIMIT_MAX_MS);

    if (elapsed < delay) {
      await sleep(delay - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Fetch with timeout + retries
   */
  private async fetchWithRetry<T>(url: string, retries: number = MAX_RETRIES): Promise<T> {
    await this.rateLimit();

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const text = await response.text().catch(() => 'No response body');
          throw new Error(
            `ESPN API error: HTTP ${response.status} ${response.statusText} - ${text.slice(0, 200)}`
          );
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (lastError.name === 'AbortError') {
          lastError = new Error(`ESPN API timeout after ${FETCH_TIMEOUT_MS}ms`);
        }

        if (attempt < retries) {
          const backoff = attempt * 1000; // 1s, 2s, 3s
          console.log(`[ESPN] Retry ${attempt}/${retries} for ${url} after ${backoff}ms: ${lastError.message}`);
          await sleep(backoff);
        }
      }
    }

    throw lastError ?? new Error('Unknown ESPN fetch error');
  }

  /**
   * Get scoreboard for a specific date
   */
  async getScoreboard(league: League, dateYYYYMMDD: string): Promise<ESPNEventData[]> {
    const baseUrl = this.getScoreboardUrl(league);
    const url = `${baseUrl}?dates=${dateYYYYMMDD}`;

    const response = await this.fetchWithRetry<ESPNScoreboardResponse>(url);
    return this.parseScoreboardEvents(response.events || []);
  }

  /**
   * Get game details/boxscore for an event
   */
  async getGameDetails(league: League, eventId: string): Promise<ESPNGameDetailsResponse> {
    const baseUrl = this.getGameUrl(league);
    const url = `${baseUrl}?event=${eventId}`;
    return this.fetchWithRetry<ESPNGameDetailsResponse>(url);
  }

  /**
   * Get game summary parsed into our boxscore
   */
  async getGameSummary(league: League, gameId: string): Promise<ESPNBoxscore | null> {
    try {
      const response = await this.getGameDetails(league, gameId);
      return this.parseGameSummary(response, gameId);
    } catch (error) {
      console.error(`[ESPN] Error fetching game summary for ${gameId}:`, error);
      return null;
    }
  }

  /**
   * Parse scoreboard events into normalized format
   */
  private parseScoreboardEvents(events: ESPNEvent[]): ESPNEventData[] {
    return events.map(event => {
      const competition = event.competitions?.[0];
      if (!competition) throw new Error(`No competition found for event ${event.id}`);

      const homeCompetitor = competition.competitors?.find(c => c.homeAway === 'home');
      const awayCompetitor = competition.competitors?.find(c => c.homeAway === 'away');
      if (!homeCompetitor || !awayCompetitor) throw new Error(`Missing home/away for event ${event.id}`);

      const parseTeam = (competitor: ESPNCompetitor): ESPNTeamData => {
        const team = competitor.team;
        return {
          id: team?.id || competitor.id,
          name: team?.name || competitor.name || 'Unknown',
          displayName:
            team?.displayName ||
            `${team?.location || ''} ${team?.name || ''}`.trim() ||
            'Unknown',
          shortDisplayName: team?.shortDisplayName || team?.abbreviation || team?.name || 'UNK',
          abbreviation: team?.abbreviation || competitor.abbreviation || 'UNK',
          conference: null, // ESPN "conferenceId" here isn't reliable; keep null unless you map it
          score: competitor.score ? parseInt(competitor.score, 10) : undefined,
        };
      };

      const statusType = competition.status?.type;
      const completed = statusType?.completed === true || statusType?.state === 'post';

      return {
        id: event.id, // <-- ESPN event id (numeric string)
        date: event.date,
        completed,
        statusState: (statusType?.state as 'pre' | 'in' | 'post') || 'pre',
        statusName: statusType?.name || 'STATUS_UNKNOWN',
        neutralSite: competition.neutralSite || false,
        home: parseTeam(homeCompetitor),
        away: parseTeam(awayCompetitor),
      };
    });
  }

  /**
   * Parse game summary into boxscore format.
   * IMPORTANT: competitor.id is NOT team.id. Use competitor.team.id.
   */
  private parseGameSummary(response: ESPNGameDetailsResponse, gameId: string): ESPNBoxscore | null {
    const boxscore = response.boxscore;
    if (!boxscore?.teams || boxscore.teams.length < 2) return null;

    const competition = response.header?.competitions?.[0];
    const competitors = competition?.competitors ?? [];

    const homeTeamId = competitors.find(c => c.homeAway === 'home')?.team?.id;
    const awayTeamId = competitors.find(c => c.homeAway === 'away')?.team?.id;

    const homeTeam = homeTeamId ? boxscore.teams.find(t => t.team?.id === homeTeamId) : undefined;
    const awayTeam = awayTeamId ? boxscore.teams.find(t => t.team?.id === awayTeamId) : undefined;

    // Safe fallback
    const safeHome = homeTeam ?? boxscore.teams[1] ?? boxscore.teams[0];
    const safeAway = awayTeam ?? boxscore.teams[0] ?? boxscore.teams[1];

    const homeStats = this.extractTeamStats(safeHome?.statistics || []);
    const awayStats = this.extractTeamStats(safeAway?.statistics || []);

    return {
      id: gameId,
      status: competition?.status?.type?.name || 'STATUS_UNKNOWN',
      home: {
        id: safeHome?.team?.id || '',
        name: safeHome?.team?.displayName || safeHome?.team?.name || 'Unknown',
        statistics: homeStats,
      },
      away: {
        id: safeAway?.team?.id || '',
        name: safeAway?.team?.displayName || safeAway?.team?.name || 'Unknown',
        statistics: awayStats,
      },
    };
  }

  /**
   * Extract shooting stats from ESPN team statistics array.
   * Uses the common ESPN displayValue formats like "30-62".
   */
  private extractTeamStats(statistics: ESPNStatistic[]): ESPNBoxscoreStats | undefined {
    const statMap: Record<string, string> = {};

    for (const stat of statistics) {
      if (stat.name && stat.displayValue !== undefined) {
        statMap[stat.name] = stat.displayValue;
      }
    }

    const fgParts = (statMap['fieldGoalsMade-fieldGoalsAttempted'] || statMap['fieldGoals'] || '0-0').split('-');
    const fg3Parts =
      (statMap['threePointFieldGoalsMade-threePointFieldGoalsAttempted'] ||
        statMap['threePointFieldGoals'] ||
        '0-0').split('-');
    const ftParts = (statMap['freeThrowsMade-freeThrowsAttempted'] || statMap['freeThrows'] || '0-0').split('-');

    const fgm = parseInt(statMap['fieldGoalsMade'] || fgParts[0] || '0', 10);
    const fga = parseInt(statMap['fieldGoalsAttempted'] || fgParts[1] || '0', 10);
    const fg3m = parseInt(statMap['threePointFieldGoalsMade'] || fg3Parts[0] || '0', 10);
    const fg3a = parseInt(statMap['threePointFieldGoalsAttempted'] || fg3Parts[1] || '0', 10);
    const ftm = parseInt(statMap['freeThrowsMade'] || ftParts[0] || '0', 10);
    const fta = parseInt(statMap['freeThrowsAttempted'] || ftParts[1] || '0', 10);
    const points = parseInt(statMap['points'] || statMap['totalPoints'] || '0', 10);

    // If there is literally no attempt data, treat as missing
    if (fga === 0 && fg3a === 0 && fta === 0) return undefined;

    return {
      field_goals_made: fgm,
      field_goals_att: fga,
      three_points_made: fg3m,
      three_points_att: fg3a,
      free_throws_made: ftm,
      free_throws_att: fta,
      points,
    };
  }
}

// Singleton instance
let clientInstance: ESPNClient | null = null;
export function getESPNClient(): ESPNClient {
  if (!clientInstance) clientInstance = new ESPNClient();
  return clientInstance;
}

// ============ Internal ESPN API response types ============

interface ESPNScoreboardResponse {
  events?: ESPNEvent[];
}

interface ESPNEvent {
  id: string;
  date: string;
  competitions?: ESPNCompetition[];
}

interface ESPNCompetition {
  neutralSite?: boolean;
  competitors?: ESPNCompetitor[];
  status?: {
    type?: {
      name?: string;
      state?: string;
      completed?: boolean;
    };
  };
}

interface ESPNCompetitor {
  id: string; // competitor id (NOT team id)
  homeAway: 'home' | 'away';
  score?: string;
  name?: string;
  abbreviation?: string;
  team?: {
    id: string; // team id
    name?: string;
    location?: string;
    abbreviation?: string;
    displayName?: string;
    shortDisplayName?: string;
  };
}

// Exported for game processor
export interface ESPNGameDetailsResponse {
  boxscore?: {
    teams?: ESPNBoxscoreTeam[];
  };
  header?: {
    competitions?: Array<{
      competitors?: ESPNCompetitor[];
      status?: {
        type?: {
          name?: string;
        };
      };
    }>;
  };
}

interface ESPNBoxscoreTeam {
  team?: {
    id: string;
    name?: string;
    displayName?: string;
  };
  statistics?: ESPNStatistic[];
}

interface ESPNStatistic {
  name?: string;
  displayValue?: string;
}
