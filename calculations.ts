import type { TeamStats, TeamDifferentials, NationalAveragesData, CalculationBreakdown } from './types.js';

/**
 * Calculate team differentials compared to national averages
 * Differential = (team_stat_made + team_stat_attempted) - (national_made + national_attempted)
 */
export function calculateDifferentials(
  teamStats: TeamStats,
  nationals: NationalAveragesData
): TeamDifferentials {
  // 2PT differential: (made + attempted) - (nat_made + nat_attempted)
  const off2ptDiff = (teamStats.off2ptm + teamStats.off2pta) - (nationals.natOff2ptmPg + nationals.natOff2ptaPg);
  const def2ptDiff = (teamStats.def2ptmAllowed + teamStats.def2ptaAllowed) - (nationals.natDef2ptmAllowedPg + nationals.natDef2ptaAllowedPg);

  // 3PT differential: (made + attempted) - (nat_made + nat_attempted)
  const off3ptDiff = (teamStats.off3ptm + teamStats.off3pta) - (nationals.natOff3ptmPg + nationals.natOff3ptaPg);
  const def3ptDiff = (teamStats.def3ptmAllowed + teamStats.def3ptaAllowed) - (nationals.natDef3ptmAllowedPg + nationals.natDef3ptaAllowedPg);

  // FT differential: (made + attempted) - (nat_made + nat_attempted)
  const offFtDiff = (teamStats.offFtm + teamStats.offFta) - (nationals.natOffFtmPg + nationals.natOffFtaPg);
  const defFtDiff = (teamStats.defFtmAllowed + teamStats.defFtaAllowed) - (nationals.natDefFtmAllowedPg + nationals.natDefFtaAllowedPg);

  return {
    off2ptDiff,
    off3ptDiff,
    offFtDiff,
    def2ptDiff,
    def3ptDiff,
    defFtDiff,
  };
}

/**
 * Calculate expected points for a team against an opponent
 * Team_adj = avg(T1_off_2pt_diff, T2_def_2pt_diff)
 *          + 1.5 * avg(T1_off_3pt_diff, T2_def_3pt_diff)
 *          + 0.5 * avg(T1_off_ft_diff, T2_def_ft_diff)
 * Expected_points = nat_points_pg_per_team + Team_adj
 */
export function calculateTeamExpected(
  teamDiffs: TeamDifferentials,
  opponentDiffs: TeamDifferentials,
  natPointsPerTeam: number
): { adjustments: { twoPoint: number; threePoint: number; freeThrow: number }; expectedPoints: number } {
  // 2PT adjustment: average of team's offense differential and opponent's defense differential
  const twoPointAdj = (teamDiffs.off2ptDiff + opponentDiffs.def2ptDiff) / 2;

  // 3PT adjustment: 1.5x weight
  const threePointAdj = 1.5 * ((teamDiffs.off3ptDiff + opponentDiffs.def3ptDiff) / 2);

  // FT adjustment: 0.5x weight
  const freeThrowAdj = 0.5 * ((teamDiffs.offFtDiff + opponentDiffs.defFtDiff) / 2);

  const totalAdjustment = twoPointAdj + threePointAdj + freeThrowAdj;
  const expectedPoints = natPointsPerTeam + totalAdjustment;

  return {
    adjustments: {
      twoPoint: twoPointAdj,
      threePoint: threePointAdj,
      freeThrow: freeThrowAdj,
    },
    expectedPoints,
  };
}

/**
 * Calculate the full game expected total
 * Expected_total = Team1_expected + Team2_expected
 */
export function calculateGameTotal(
  team1Stats: TeamStats,
  team1Name: string,
  team2Stats: TeamStats,
  team2Name: string,
  nationals: NationalAveragesData
): CalculationBreakdown {
  const team1Diffs = calculateDifferentials(team1Stats, nationals);
  const team2Diffs = calculateDifferentials(team2Stats, nationals);

  const team1Expected = calculateTeamExpected(team1Diffs, team2Diffs, nationals.natPointsPgPerTeam);
  const team2Expected = calculateTeamExpected(team2Diffs, team1Diffs, nationals.natPointsPgPerTeam);

  const expectedTotal = team1Expected.expectedPoints + team2Expected.expectedPoints;

  return {
    team1: {
      name: team1Name,
      expectedPoints: team1Expected.expectedPoints,
      adjustments: team1Expected.adjustments,
      differentials: team1Diffs,
    },
    team2: {
      name: team2Name,
      expectedPoints: team2Expected.expectedPoints,
      adjustments: team2Expected.adjustments,
      differentials: team2Diffs,
    },
    expectedTotal,
    nationalAverages: nationals,
  };
}

/**
 * Calculate bet profit based on American odds
 */
export function calculateBetProfit(
  stake: number,
  odds: number,
  result: 'win' | 'loss' | 'push'
): number {
  if (result === 'push') return 0;
  if (result === 'loss') return -stake;

  // Positive odds: profit = stake * (odds / 100)
  // Negative odds: profit = stake * (100 / |odds|)
  if (odds > 0) {
    return stake * (odds / 100);
  } else {
    return stake * (100 / Math.abs(odds));
  }
}

/**
 * Derive 2PT stats from FG and 3PT stats
 * 2PTM = FGM - 3PTM
 * 2PTA = FGA - 3PTA
 */
export function derive2ptFromFg(
  fgm: number,
  fga: number,
  threePtm: number,
  threePta: number
): { twoPtm: number; twoPta: number } {
  return {
    twoPtm: fgm - threePtm,
    twoPta: fga - threePta,
  };
}

/**
 * Convert per-game averages from season rollup totals
 */
export function calculatePerGameAverages(
  totals: {
    gamesPlayed: number;
    off2ptmTotal: number;
    off2ptaTotal: number;
    off3ptmTotal: number;
    off3ptaTotal: number;
    offFtmTotal: number;
    offFtaTotal: number;
    def2ptmAllowedTotal: number;
    def2ptaAllowedTotal: number;
    def3ptmAllowedTotal: number;
    def3ptaAllowedTotal: number;
    defFtmAllowedTotal: number;
    defFtaAllowedTotal: number;
  }
): TeamStats | null {
  if (totals.gamesPlayed === 0) return null;

  const g = totals.gamesPlayed;
  return {
    off2ptm: totals.off2ptmTotal / g,
    off2pta: totals.off2ptaTotal / g,
    off3ptm: totals.off3ptmTotal / g,
    off3pta: totals.off3ptaTotal / g,
    offFtm: totals.offFtmTotal / g,
    offFta: totals.offFtaTotal / g,
    def2ptmAllowed: totals.def2ptmAllowedTotal / g,
    def2ptaAllowed: totals.def2ptaAllowedTotal / g,
    def3ptmAllowed: totals.def3ptmAllowedTotal / g,
    def3ptaAllowed: totals.def3ptaAllowedTotal / g,
    defFtmAllowed: totals.defFtmAllowedTotal / g,
    defFtaAllowed: totals.defFtaAllowedTotal / g,
  };
}
