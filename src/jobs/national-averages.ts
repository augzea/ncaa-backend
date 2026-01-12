import { prisma } from '../lib/prisma.js';
import { League as PrismaLeague } from '@prisma/client';
import { getCurrentSeason } from './schedule-sync.js';

/**
 * Result of building national averages
 */
export interface BuildNationalAveragesResult {
  mens: LeagueAveragesResult | null;
  womens: LeagueAveragesResult | null;
}

export interface LeagueAveragesResult {
  teamCount: number;
  totalGames: number;
  pointsPerTeamPerGame: number;
}

/**
 * Job C: National Averages Builder
 * Computes national averages from all team season rollups (weighted by gamesPlayed)
 */
export async function buildNationalAverages(): Promise<BuildNationalAveragesResult> {
  console.log('[National Averages] Starting builder...');
  const season = getCurrentSeason();

  const result: BuildNationalAveragesResult = {
    mens: null,
    womens: null,
  };

  const leagues: Array<{ prisma: PrismaLeague; key: 'mens' | 'womens' }> = [
    { prisma: 'MENS', key: 'mens' },
    { prisma: 'WOMENS', key: 'womens' },
  ];

  for (const { prisma: league, key } of leagues) {
    try {
      console.log(`[National Averages] Computing for ${league} ${season}...`);

      // Get all team rollups with at least one game played
      const rollups = await prisma.teamSeasonRollup.findMany({
        where: {
          league,
          season,
          gamesPlayed: { gt: 0 },
        },
      });

      if (rollups.length === 0) {
        console.log(`[National Averages] No team data for ${league} ${season}, skipping`);
        continue;
      }

      // Calculate weighted averages based on games played
      let totalOff2ptm = 0, totalOff2pta = 0;
      let totalOff3ptm = 0, totalOff3pta = 0;
      let totalOffFtm = 0, totalOffFta = 0;
      let totalDef2ptmAllowed = 0, totalDef2ptaAllowed = 0;
      let totalDef3ptmAllowed = 0, totalDef3ptaAllowed = 0;
      let totalDefFtmAllowed = 0, totalDefFtaAllowed = 0;
      let totalGames = 0;

      for (const rollup of rollups) {
        // Sum totals (not per-game) for weighted average
        totalOff2ptm += rollup.off2ptmTotal;
        totalOff2pta += rollup.off2ptaTotal;
        totalOff3ptm += rollup.off3ptmTotal;
        totalOff3pta += rollup.off3ptaTotal;
        totalOffFtm += rollup.offFtmTotal;
        totalOffFta += rollup.offFtaTotal;
        totalDef2ptmAllowed += rollup.def2ptmAllowedTotal;
        totalDef2ptaAllowed += rollup.def2ptaAllowedTotal;
        totalDef3ptmAllowed += rollup.def3ptmAllowedTotal;
        totalDef3ptaAllowed += rollup.def3ptaAllowedTotal;
        totalDefFtmAllowed += rollup.defFtmAllowedTotal;
        totalDefFtaAllowed += rollup.defFtaAllowedTotal;
        totalGames += rollup.gamesPlayed;
      }

      // Per-game national averages (weighted by games played)
      const natOff2ptmPg = totalGames > 0 ? totalOff2ptm / totalGames : 0;
      const natOff2ptaPg = totalGames > 0 ? totalOff2pta / totalGames : 0;
      const natOff3ptmPg = totalGames > 0 ? totalOff3ptm / totalGames : 0;
      const natOff3ptaPg = totalGames > 0 ? totalOff3pta / totalGames : 0;
      const natOffFtmPg = totalGames > 0 ? totalOffFtm / totalGames : 0;
      const natOffFtaPg = totalGames > 0 ? totalOffFta / totalGames : 0;
      const natDef2ptmAllowedPg = totalGames > 0 ? totalDef2ptmAllowed / totalGames : 0;
      const natDef2ptaAllowedPg = totalGames > 0 ? totalDef2ptaAllowed / totalGames : 0;
      const natDef3ptmAllowedPg = totalGames > 0 ? totalDef3ptmAllowed / totalGames : 0;
      const natDef3ptaAllowedPg = totalGames > 0 ? totalDef3ptaAllowed / totalGames : 0;
      const natDefFtmAllowedPg = totalGames > 0 ? totalDefFtmAllowed / totalGames : 0;
      const natDefFtaAllowedPg = totalGames > 0 ? totalDefFtaAllowed / totalGames : 0;

      // Calculate average points per team per game
      // Points = 2*2PTM + 3*3PTM + 1*FTM
      const natPointsPgPerTeam = 2 * natOff2ptmPg + 3 * natOff3ptmPg + natOffFtmPg;

      // Upsert national averages
      await prisma.nationalAverages.upsert({
        where: {
          league_season: { league, season },
        },
        create: {
          league,
          season,
          natOff2ptmPg,
          natOff2ptaPg,
          natOff3ptmPg,
          natOff3ptaPg,
          natOffFtmPg,
          natOffFtaPg,
          natDef2ptmAllowedPg,
          natDef2ptaAllowedPg,
          natDef3ptmAllowedPg,
          natDef3ptaAllowedPg,
          natDefFtmAllowedPg,
          natDefFtaAllowedPg,
          natPointsPgPerTeam,
        },
        update: {
          natOff2ptmPg,
          natOff2ptaPg,
          natOff3ptmPg,
          natOff3ptaPg,
          natOffFtmPg,
          natOffFtaPg,
          natDef2ptmAllowedPg,
          natDef2ptaAllowedPg,
          natDef3ptmAllowedPg,
          natDef3ptaAllowedPg,
          natDefFtmAllowedPg,
          natDefFtaAllowedPg,
          natPointsPgPerTeam,
        },
      });

      result[key] = {
        teamCount: rollups.length,
        totalGames,
        pointsPerTeamPerGame: natPointsPgPerTeam,
      };

      console.log(`[National Averages] ${league} ${season}:`);
      console.log(`  Teams: ${rollups.length}, Total games: ${totalGames}`);
      console.log(`  Avg points/team/game: ${natPointsPgPerTeam.toFixed(1)}`);
    } catch (error) {
      console.error(`[National Averages] Error computing for ${league}:`, error);
    }
  }

  console.log('[National Averages] Builder completed');
  return result;
}
