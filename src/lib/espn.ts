import type { League } from './types.js';

const ESPN_MBB_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard';
const ESPN_WBB_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/scoreboard';

const ESPN_MBB_GAME_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary';
const ESPN_WBB_GAME_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/summary';

// ESPN often defaults to “featured” / limited slates unless group is specified.
// For NCAA basketball, Division I is commonly groups=50.
const NCAA_D1_GROUP = '50';

// Pagination controls (ESPN often honors these)
const PAGE_LIMIT = 300;

const FETCH_TIMEOUT_MS = 10000; // 10 seconds
const MAX_RETRIES = 3;

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
  id: string;
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
  id: string;
  status: string;
  home: {
    id: string;
    name: string;
    statistics: ESPNBoxscoreStats | undefined;
  };
  away: {
    id: string;
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

/**
 * Safely build URL with query params
 */
function withParams(baseUrl: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
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
    const delay = randomDelay(300, 550);

    if (elapsed < delay) {
      await sleep(delay - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Fetch with timeout, retries, and proper error handling
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

    throw lastError!;
  }

  /**
   * Get scoreboard for a specific date (ALL Division I games)
   * Uses groups=50 and paginates using limit/offset when supported.
   *
   * @param league - 'MENS' or 'WOMENS'
   * @param dateYYYYMMDD - Date in YYYYMMDD format
   */
  async getScoreboard(league: League, dateYYYYMMDD: string): Promise<ESPNEventData[]> {
    const baseUrl = this.getScoreboardUrl(league);

    const allEvents: ESPNEvent[] = [];
    let offset = 0;

    // paginate until ESPN stops returning events
    while (true) {
      const url = withParams(baseUrl, {
        dates: dateYYYYMMDD,
        groups: NCAA_D1_GROUP,
        limit: PAGE_LIMIT,
        offset,
      });

      const response = await this.fetchWithRetry<ESPNScoreboardResponse>(url);
      const page = response.events || [];

      if (page.length === 0) break;

      allEvents.push(...page);

      // If ESPN honors limit/offset, page size < limit means we're done.
      if (page.length < PAGE_LIMIT) break;

      offset += PAGE_LIMIT;

      // safety cap to prevent infinite loops if ESPN ignores offset but always returns same page
      if (offset > 3000) {
        console.warn(`[ESPN] Pagination safety cap hit for ${league} ${dateYYYYMMDD}. Returning what we have.`);
        break;
      }
    }

    return this.parseScoreboardEvents(allEvents);
  }

  /**
   * Get game details/boxscore for a specific event
   * (we include groups=50 for consistency; ESPN may ignore it here but it doesn’t hurt)
   */
  async getGameDetails(league: League, eventId: string): Promise<ESPNGameDetailsResponse> {
    const baseUrl = this.getGameUrl(league);
    const url = withParams(baseUrl, { event: eventId, groups: NCAA_D1_GROUP });
    return this.fetchWithRetry<ESPNGameDetailsResponse>(url);
  }

  /**
   * Get game summary/boxscore for a completed game (parsed)
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
      if (!competition) {
        throw new Error(`No competition found for event ${event.id}`);
      }

      const homeCompetitor = competition.competitors?.find(c => c.homeAway === 'home');
      const awayCompetitor = competition.competitors?.find(c => c.homeAway === 'away');

      if (!homeCompetitor || !awayCompetitor) {
        throw new Error(`Missing home or away team for event ${event.id}`);
      }

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
          conference: null, // you can wire this later if you want
          score: competitor.score ? parseInt(competitor.score, 10) : undefined,
        };
      };

      const status = competition.status?.type;
      const completed = status?.completed === true || status?.state === 'post';

      return {
        id: event.id,
        date: event.date,
        completed,
        statusState: (status?.state as 'pre' | 'in' | 'post') || 'pre',
        statusName: status?.name || 'STATUS_SCHEDULED',
        neutralSite: competition.neutralSite || false,
        home: parseTeam(homeCompetitor),
        away: parseTeam(awayCompetitor),
      };
    });
  }

  /**
   * Parse game summary into boxscore format
   */
  private parseGameSummary(response: ESPNGameDetailsResponse, gameId: string): ESPNBoxscore | null {
    const boxscore = response.boxscore;
    if (!boxscore?.teams || boxscore.teams.length < 2) {
      return null;
    }

    // Find home and away teams from the header
    const header = response.header;
    const competition = header?.competitions?.[0];
    const homeCompetitor = competition?.competitors?.find(c => c.homeAway === 'home');
    const awayCompetitor = competition?.competitors?.find(c => c.homeAway === 'away');

    // Match boxscore teams to home/away by ID
    const homeTeam = boxscore.teams.find(t => t.team?.id === homeCompetitor?.id);
    const awayTeam = boxscore.teams.find(t => t.team?.id === awayCompetitor?.id);

    // Fallback to order (usually away first, home second)
    const teamHome = homeTeam || boxscore.teams[1];
    const teamAway = awayTeam || boxscore.teams[0];

    return {
      id: gameId,
      status: header?.competitions?.[0]?.status?.type?.name || 'STATUS_FINAL',
      home: {
        id: teamHome?.team?.id || '',
        name: teamHome?.team?.displayName || teamHome?.team?.name || 'Unknown',
        statistics: this.extractTeamStats(teamHome?.statistics || []),
      },
      away: {
        id: teamAway?.team?.id || '',
        name: teamAway?.team?.displayName || teamAway?.team?.name || 'Unknown',
        statistics: this.extractTeamStats(teamAway?.statistics || []),
      },
    };
  }

  /**
   * Extract statistics from ESPN boxscore format
   */
  private extractTeamStats(statistics: ESPNStatistic[]): ESPNBoxscoreStats | undefined {
    const statMap: Record<string, string> = {};

    for (const stat of statistics) {
      if (stat.name && stat.displayValue !== undefined) {
        statMap[stat.name] = stat.displayValue;
      }
    }

    // Parse field goals (format: "30-62" for made-attempted)
    const fgParts = (statMap['fieldGoalsMade-fieldGoalsAttempted'] || statMap['fieldGoals'] || '0-0').split('-');
    const fg3Parts = (statMap['threePointFieldGoalsMade-threePointFieldGoalsAttempted'] || statMap['threePointFieldGoals'] || '0-0').split('-');
    const ftParts = (statMap['freeThrowsMade-freeThrowsAttempted'] || statMap['freeThrows'] || '0-0').split('-');

    const fgm = parseInt(statMap['fieldGoalsMade'] || fgParts[0] || '0', 10);
    const fga = parseInt(statMap['fieldGoalsAttempted'] || fgParts[1] || '0', 10);
    const fg3m = parseInt(statMap['threePointFieldGoalsMade'] || fg3Parts[0] || '0', 10);
    const fg3a = parseInt(statMap['threePointFieldGoalsAttempted'] || fg3Parts[1] || '0', 10);
    const ftm = parseInt(statMap['freeThrowsMade'] || ftParts[0] || '0', 10);
    const fta = parseInt(statMap['freeThrowsAttempted'] || ftParts[1] || '0', 10);
    const points = parseInt(statMap['points'] || statMap['totalPoints'] || '0', 10);

    // Only return stats if we have meaningful data
    if (fga === 0 && fta === 0) return undefined;

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
  leagues?: unknown[];
  day?: unknown;
}

interface ESPNEvent {
  id: string;
  uid?: string;
  date: string;
  name?: string;
  shortName?: string;
  competitions?: ESPNCompetition[];
}

interface ESPNCompetition {
  id?: string;
  date?: string;
  neutralSite?: boolean;
  competitors?: ESPNCompetitor[];
  status?: {
    type?: {
      id?: string;
      name?: string;
      state?: string;
      description?: string;
      completed?: boolean;
    };
  };
}

interface ESPNCompetitor {
  id: string;
  homeAway: 'home' | 'away';
  score?: string;
  name?: string;
  location?: string;
  abbreviation?: string;
  team?: {
    id: string;
    name?: string;
    location?: string;
    abbreviation?: string;
    displayName?: string;
    shortDisplayName?: string;
    conferenceId?: string;
  };
}

// Exported for game processor
export interface ESPNGameDetailsResponse {
  boxscore?: {
    teams?: ESPNBoxscoreTeam[];
    players?: unknown[];
  };
  header?: {
    competitions?: ESPNCompetition[];
  };
  gameInfo?: unknown;
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
  label?: string;
}
