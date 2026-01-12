import type { League } from './types.js';

const ESPN_MBB_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard';
const ESPN_WBB_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/scoreboard';
const ESPN_MBB_GAME_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary';
const ESPN_WBB_GAME_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/summary';

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

export class ESPNClient {
  private getScoreboardUrl(league: League): string {
    return league === 'MENS' ? ESPN_MBB_SCOREBOARD_URL : ESPN_WBB_SCOREBOARD_URL;
  }

  private getGameUrl(league: League): string {
    return league === 'MENS' ? ESPN_MBB_GAME_URL : ESPN_WBB_GAME_URL;
  }

  /**
   * Fetch with proper error handling - throws on non-200 with status and response text
   */
  private async fetchWithError<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'No response body');
      throw new Error(`ESPN API error: HTTP ${response.status} ${response.statusText} - ${text}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get scoreboard for a specific date
   * @param league - 'MENS' or 'WOMENS'
   * @param dateYYYYMMDD - Date in YYYYMMDD format
   */
  async getScoreboard(league: League, dateYYYYMMDD: string): Promise<ESPNEventData[]> {
    const baseUrl = this.getScoreboardUrl(league);
    const url = `${baseUrl}?dates=${dateYYYYMMDD}`;

    const response = await this.fetchWithError<ESPNScoreboardResponse>(url);
    return this.parseScoreboardEvents(response.events || []);
  }

  /**
   * Get game summary/boxscore for a completed game
   */
  async getGameSummary(league: League, gameId: string): Promise<ESPNBoxscore | null> {
    const baseUrl = this.getGameUrl(league);
    const url = `${baseUrl}?event=${gameId}`;

    const response = await this.fetchWithError<ESPNGameSummaryResponse>(url);
    return this.parseGameSummary(response, gameId);
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
          displayName: team?.displayName || `${team?.location || ''} ${team?.name || ''}`.trim() || 'Unknown',
          shortDisplayName: team?.shortDisplayName || team?.abbreviation || team?.name || 'UNK',
          abbreviation: team?.abbreviation || competitor.abbreviation || 'UNK',
          conference: team?.conferenceId ? null : null, // ESPN doesn't reliably provide this in scoreboard
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
  private parseGameSummary(response: ESPNGameSummaryResponse, gameId: string): ESPNBoxscore | null {
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
    const team1 = homeTeam || boxscore.teams[1];
    const team2 = awayTeam || boxscore.teams[0];

    return {
      id: gameId,
      status: header?.competitions?.[0]?.status?.type?.name || 'STATUS_FINAL',
      home: {
        id: team1?.team?.id || '',
        name: team1?.team?.displayName || team1?.team?.name || 'Unknown',
        statistics: this.extractTeamStats(team1?.statistics || []),
      },
      away: {
        id: team2?.team?.id || '',
        name: team2?.team?.displayName || team2?.team?.name || 'Unknown',
        statistics: this.extractTeamStats(team2?.statistics || []),
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
    if (fga === 0 && fta === 0) {
      return undefined;
    }

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
  if (!clientInstance) {
    clientInstance = new ESPNClient();
  }
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

interface ESPNGameSummaryResponse {
  boxscore?: {
    teams?: ESPNBoxscoreTeam[];
  };
  header?: {
    competitions?: ESPNCompetition[];
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
  label?: string;
}
