import type { League } from './types.js';

// ESPN endpoints
const ESPN_MBB_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard';
const ESPN_WBB_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/scoreboard';
const ESPN_MBB_GAME_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary';
const ESPN_WBB_GAME_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/summary';

// --- Important for "ALL D1 games" ---
// ESPN scoreboard commonly returns only a subset unless groups + high limit are provided.  [oai_citation:1‡Gist](https://gist.github.com/akeaswaran/b48b02f1c94f873c6655e7129910fc3b?permalink_comment_id=4692879&utm_source=chatgpt.com)
const ESPN_D1_GROUP = 50;
const SCOREBOARD_LIMIT = 1000;

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
 * Sleep for rate limiting
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

function parseScore(raw: unknown): number | undefined {
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) raw = Number(raw);
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 2_147_483_647
    ? raw
    : undefined;
}

export class ESPNClient {
  private lastRequestTime: number = 0;

  private getScoreboardUrl(league: League): string {
    return league === 'MENS' ? ESPN_MBB_SCOREBOARD_URL : ESPN_WBB_SCOREBOARD_URL;
  }

  private getGameUrl(league: League): string {
    return league === 'MENS' ? ESPN_MBB_GAME_URL : ESPN_WBB_GAME_URL;
