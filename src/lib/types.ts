import { z } from 'zod';

export const LeagueSchema = z.enum(['MENS', 'WOMENS']);
export type League = z.infer<typeof LeagueSchema>;

export const GameStatusSchema = z.enum(['SCHEDULED', 'IN_PROGRESS', 'FINAL', 'POSTPONED', 'CANCELLED']);
export type GameStatus = z.infer<typeof GameStatusSchema>;

export const SeasonSchema = z.string().regex(/^\d{4}-\d{2}$/, 'Season must be in format YYYY-YY');

export interface TeamStats {
  off2ptm: number;
  off2pta: number;
  off3ptm: number;
  off3pta: number;
  offFtm: number;
  offFta: number;
  def2ptmAllowed: number;
  def2ptaAllowed: number;
  def3ptmAllowed: number;
  def3ptaAllowed: number;
  defFtmAllowed: number;
  defFtaAllowed: number;
}

export interface TeamDifferentials {
  // Offensive differentials
  off2ptDiff: number;
  off3ptDiff: number;
  offFtDiff: number;
  // Defensive differentials
  def2ptDiff: number;
  def3ptDiff: number;
  defFtDiff: number;
}

export interface NationalAveragesData {
  natOff2ptmPg: number;
  natOff2ptaPg: number;
  natOff3ptmPg: number;
  natOff3ptaPg: number;
  natOffFtmPg: number;
  natOffFtaPg: number;
  natDef2ptmAllowedPg: number;
  natDef2ptaAllowedPg: number;
  natDef3ptmAllowedPg: number;
  natDef3ptaAllowedPg: number;
  natDefFtmAllowedPg: number;
  natDefFtaAllowedPg: number;
  natPointsPgPerTeam: number;
}

export interface CalculationBreakdown {
  team1: {
    name: string;
    expectedPoints: number;
    adjustments: {
      twoPoint: number;
      threePoint: number;
      freeThrow: number;
    };
    differentials: TeamDifferentials;
  };
  team2: {
    name: string;
    expectedPoints: number;
    adjustments: {
      twoPoint: number;
      threePoint: number;
      freeThrow: number;
    };
    differentials: TeamDifferentials;
  };
  expectedTotal: number;
  nationalAverages: NationalAveragesData;
}

// ESPN API types
export interface ESPNTeam {
  id: string;
  name: string;
  location?: string;
  abbreviation?: string;
  displayName: string;
  score?: number;
}

export interface ESPNGame {
  id: string;
  date: string;
  status: string;
  statusState: string;
  home: ESPNTeam;
  away: ESPNTeam;
  neutralSite: boolean;
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

export interface ESPNBoxscoreTeam {
  id: string;
  name: string;
  statistics?: ESPNBoxscoreStats;
}

export interface ESPNBoxscore {
  id: string;
  status: string;
  home: ESPNBoxscoreTeam;
  away: ESPNBoxscoreTeam;
}
