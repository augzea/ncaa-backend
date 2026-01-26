import type { League } from './types.js';

const ESPN_MBB_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard';
const ESPN_WBB_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/scoreboard';
const ESPN_MBB_GAME_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary';
const ESPN_WBB_GAME_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/summary';

const FETCH_TIMEOUT_MS = 10000;
const MAX_RETRIES = 3;

// =======================
// Types
// =======================

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

// =======================
// Utility
// =======================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =======================
// Client
// =======================

export class ESPNClient {
  private getScoreboardUrl(league: League): string {
    return league === 'MENS' ? ESPN_MBB_SCOREBOARD_URL : ESPN_WBB_SCOREBOARD_URL;
  }

  private getGameUrl(league: League): string {
    return league === 'MENS' ? ESPN_MBB_GAME_URL : ESPN_WBB_GAME_URL;
  }

  private async fetchWithRetry<T>(url: string, retries: number = MAX_RETRIES): Promise<T> {
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
          throw new Error(`ESPN API error: HTTP ${response.status}`);
        }

        return (await response.json()) as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < retries) {
          await sleep(attempt * 1000);
        }
      }
    }

    throw lastError;
  }

  async getScoreboard(league: League, dateYYYYMMDD: string): Promise<ESPNEventData[]> {
    const url = `${this.getScoreboardUrl(league)}?dates=${dateYYYYMMDD}`;
    const response = await this.fetchWithRetry<ESPNScoreboardResponse>(url);
    return this.parseScoreboardEvents(response.events || []);
  }

  async getGameDetails(league: League, eventId: string): Promise<ESPNGameDetailsResponse> {
    const url = `${this.getGameUrl(league)}?event=${eventId}`;
    return this.fetchWithRetry<ESPNGameDetailsResponse>(url);
  }

  async getGameSummary(league: League, gameId: string): Promise<ESPNBoxscore | null> {
    try {
      const response = await this.getGameDetails(league, gameId);
      return this.parseGameSummary(response, gameId);
    } catch {
      return null;
    }
  }

  private parseScoreboardEvents(events: ESPNEvent[]): ESPNEventData[] {
    return events.map(event => {
      const competition = event.competitions?.[0];
      if (!competition) throw new Error(`No competition for event ${event.id}`);

      const home = competition.competitors?.find(c => c.homeAway === 'home');
      const away = competition.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) throw new Error(`Missing teams for event ${event.id}`);

      const parseTeam = (c: ESPNCompetitor): ESPNTeamData => ({
        id: c.team?.id || c.id,
        name: c.team?.name || c.name || 'Unknown',
        displayName: c.team?.displayName || 'Unknown',
        shortDisplayName: c.team?.shortDisplayName || 'UNK',
        abbreviation: c.team?.abbreviation || 'UNK',
        conference: null,
        score: c.score ? parseInt(c.score, 10) : undefined,
      });

      const status = competition.status?.type;

      return {
        id: event.id,
        date: event.date,
        completed: status?.completed || false,
        statusState: (status?.state as any) || 'pre',
        statusName: status?.name || 'SCHEDULED',
        neutralSite: competition.neutralSite || false,
        home: parseTeam(home),
        away: parseTeam(away),
      };
    });
  }

  private parseGameSummary(response: ESPNGameDetailsResponse, gameId: string): ESPNBoxscore | null {
    const teams = response.boxscore?.teams;
    if (!teams || teams.length < 2) return null;

    return {
      id: gameId,
      status: 'FINAL',
      home: {
        id: teams[1]?.team?.id || '',
        name: teams[1]?.team?.displayName || '',
        statistics: this.extractTeamStats(teams[1]?.statistics || []),
      },
      away: {
        id: teams[0]?.team?.id || '',
        name: teams[0]?.team?.displayName || '',
        statistics: this.extractTeamStats(teams[0]?.statistics || []),
      },
    };
  }

  private extractTeamStats(stats: ESPNStatistic[]): ESPNBoxscoreStats | undefined {
    const map: Record<string, string> = {};
    for (const s of stats) {
      if (s.name && s.displayValue) {
        map[s.name] = s.displayValue;
      }
    }

    const parse = (key: string) => parseInt(map[key] || '0', 10);

    const fgm = parse('fieldGoalsMade');
    const fga = parse('fieldGoalsAttempted');
    const fg3m = parse('threePointFieldGoalsMade');
    const fg3a = parse('threePointFieldGoalsAttempted');
    const ftm = parse('freeThrowsMade');
    const fta = parse('freeThrowsAttempted');
    const pts = parse('points');

    if (fga === 0 && fta === 0) return undefined;

    return {
      field_goals_made: fgm,
      field_goals_att: fga,
      three_points_made: fg3m,
      three_points_att: fg3a,
      free_throws_made: ftm,
      free_throws_att: fta,
      points: pts,
    };
  }
}

// =======================
// Singleton
// =======================

let client: ESPNClient | null = null;
export function getESPNClient(): ESPNClient {
  if (!client) client = new ESPNClient();
  return client;
}

// =======================
// ESPN Raw Types
// =======================

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
  id: string;
  homeAway: 'home' | 'away';
  score?: string;
  name?: string;
  team?: {
    id: string;
    name?: string;
    displayName?: string;
    shortDisplayName?: string;
    abbreviation?: string;
  };
}

export interface ESPNGameDetailsResponse {
  boxscore?: {
    teams?: ESPNBoxscoreTeam[];
  };
}

interface ESPNBoxscoreTeam {
  team?: {
    id: string;
    displayName?: string;
  };
  statistics?: ESPNStatistic[];
}

interface ESPNStatistic {
  name?: string;
  displayValue?: string;
}
