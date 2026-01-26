import type { League } from './types.js';

const ESPN_MBB_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard';
const ESPN_WBB_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/scoreboard';

const ESPN_MBB_GAME_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary';
const ESPN_WBB_GAME_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/summary';

const FETCH_TIMEOUT_MS = 15000; // 15s
const MAX_RETRIES = 3;

// Small randomized pacing between requests
const MIN_DELAY_MS = 250;
const MAX_DELAY_MS = 450;

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export class ESPNClient {
  private lastRequestTime = 0;

  private getScoreboardUrl(league: League): string {
    return league === 'MENS' ? ESPN_MBB_SCOREBOARD_URL : ESPN_WBB_SCOREBOARD_URL;
  }

  private getGameUrl(league: League): string {
    return league === 'MENS' ? ESPN_MBB_GAME_URL : ESPN_WBB_GAME_URL;
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    const minSpacing = randomDelay(MIN_DELAY_MS, MAX_DELAY_MS);

    if (elapsed < minSpacing) {
      await sleep(minSpacing - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

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
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if ((lastError as any).name === 'AbortError') {
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

  async getScoreboard(league: League, dateYYYYMMDD: string): Promise<ESPNEventData[]> {
    const baseUrl = this.getScoreboardUrl(league);
    const url = `${baseUrl}?dates=${dateYYYYMMDD}`;

    const response = await this.fetchWithRetry<ESPNScoreboardResponse>(url);
    return this.parseScoreboardEvents(response.events || []);
  }

  async getGameDetails(league: League, eventId: string): Promise<ESPNGameDetailsResponse> {
    const baseUrl = this.getGameUrl(league);
    const url = `${baseUrl}?event=${eventId}`;
    return this.fetchWithRetry<ESPNGameDetailsResponse>(url);
  }

  async getGameSummary(league: League, gameId: string): Promise<ESPNBoxscore | null> {
    try {
      const response = await this.getGameDetails(league, gameId);
      return this.parseGameSummary(response, gameId);
    } catch (error) {
      console.error(`[ESPN] Error fetching game summary for ${gameId}:`, error);
      return null;
    }
  }

  private parseScoreboardEvents(events: ESPNEvent[]): ESPNEventData[] {
    return events.map(event => {
      const competition = event.competitions?.[0];
      if (!competition) throw new Error(`No competition found for event ${event.id}`);

      const homeCompetitor = competition.competitors?.find(c => c.homeAway === 'home');
      const awayCompetitor = competition.competitors?.find(c => c.homeAway === 'away');
      if (!homeCompetitor || !awayCompetitor) throw new Error(`Missing home/away team for event ${event.id}`);

      const parseTeam = (competitor: ESPNCompetitor): ESPNTeamData => {
        const team = competitor.team;
        return {
          id: team?.id || competitor.id,
          name: team?.name || competitor.name || 'Unknown',
          displayName:
            team?.displayName ||
            `${team?.location || ''} ${team?.name || ''}`.trim() ||
            competitor.name ||
            'Unknown',
          shortDisplayName: team?.shortDisplayName || team?.abbreviation || team?.name || 'UNK',
          abbreviation: team?.abbreviation || competitor.abbreviation || 'UNK',
          conference: null,
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

  private parseGameSummary(response: ESPNGameDetailsResponse, gameId: string): ESPNBoxscore | null {
    const boxscore = response.boxscore;
    if (!boxscore?.teams || boxscore.teams.length < 2) return null;

    const header = response.header;
    const competition = header?.competitions?.[0];
    const homeCompetitor = competition?.competitors?.find(c => c.homeAway === 'home');
    const awayCompetitor = competition?.competitors?.find(c => c.homeAway === 'away');

    const homeTeam = boxscore.teams.find(t => t.team?.id === homeCompetitor?.id);
    const awayTeam = boxscore.teams.find(t => t.team?.id === awayCompetitor?.id);

    // ESPN often lists away first then home; use competitors mapping first, fallback to ordering
    const resolvedHome = homeTeam || boxscore.teams[1];
    const resolvedAway = awayTeam || boxscore.teams[0];

    return {
      id: gameId,
      status: competition?.status?.type?.name || 'STATUS_FINAL',
      home: {
        id: resolvedHome?.team?.id || '',
        name: resolvedHome?.team?.displayName || resolvedHome?.team?.name || 'Unknown',
        statistics: this.extractTeamStats(resolvedHome?.statistics || []),
      },
      away: {
        id: resolvedAway?.team?.id || '',
        name: resolvedAway?.team?.displayName || resolvedAway?.team?.name || 'Unknown',
        statistics: this.extractTeamStats(resolvedAway?.statistics || []),
      },
    };
  }

  private extractTeamStats(statistics: ESPNStatistic[]): ESPNBoxscoreStats | undefined {
    const statMap: Record<string, string> = {};

    for (const stat of statistics) {
      if (stat.name && stat.displayValue !== undefined) {
        statMap[stat.name] = stat.displayValue;
      }
    }

    const fgParts = (statMap['fieldGoalsMade-fieldGoalsAttempted'] || statMap['fieldGoals'] || '0-0').split('-');
    const fg3Parts = (
      statMap['threePointFieldGoalsMade-threePointFieldGoalsAttempted'] ||
      statMap['threePointFieldGoals'] ||
      '0-0'
    ).split('-');
    const ftParts = (statMap['freeThrowsMade-freeThrowsAttempted'] || statMap['freeThrows'] || '0-0').split('-');

    const fgm = parseInt(statMap['fieldGoalsMade'] || fgParts[0] || '0', 10);
    const fga = parseInt(statMap['fieldGoalsAttempted'] || fgParts[1] || '0', 10);
    const fg3m = parseInt(statMap['threePointFieldGoalsMade'] || fg3Parts[0] || '0', 10);
    const fg3a = parseInt(statMap['threePointFieldGoalsAttempted'] || fg3Parts[1] || '0', 10);
    const ftm = parseInt(statMap['freeThrowsMade'] || ftParts[0] || '0', 10);
    const fta = parseInt(statMap['freeThrowsAttempted'] || ftParts[1] || '0', 10);
    const points = parseInt(statMap['points'] || statMap['totalPoints'] || '0', 10);

    // If ESPN didn’t provide meaningful shooting totals, skip
    if (fga === 0 && fta === 0 && fg3a === 0) return undefined;

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

let clientInstance: ESPNClient | null = null;

export function getESPNClient(): ESPNClient {
  if (!clientInstance) clientInstance = new ESPNClient();
  return clientInstance;
}

interface ESPNScoreboardResponse {
  events?: ESPNEvent[];
  leagues?: unknown[];
  day?: unknown;
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
  id: string;
  homeAway: 'home' | 'away';
  score?: string;
  name?: string;
  abbreviation?: string;
  team?: {
    id: string;
    name?: string;
    location?: string;
    abbreviation?: string;
    displayName?: string;
    shortDisplayName?: string;
  };
}

export interface ESPNGameDetailsResponse {
  boxscore?: {
    teams?: ESPNBoxscoreTeam[];
    players?: unknown[];
  };
  header?: {
    competitions?: ESPNCompetitionHeader[];
  };
}

interface ESPNCompetitionHeader {
  competitors?: Array<{ id: string; homeAway: 'home' | 'away' }>;
  status?: {
    type?: { name?: string };
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
