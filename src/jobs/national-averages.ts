import { prisma } from '../lib/prisma.js';
import { League as PrismaLeague } from '@prisma/client';
import { getCurrentSeason } from './schedule-sync.js';

/**
 * Job C: National Averages Builder
 * Runs nightly to compute national averages from all team season rollups
 */
export async function buildNationalAverages(): Promise<void> {
  console.log('[Job C] Starting national averages builder...');
  const season = getCurrentSeason();

  const leagues: PrismaLeague[] = ['MENS', 'WOMENS'];

  for (const league of leagues) {
    try {
      console.log(`[Job C] Computing national averages for ${league} ${season}...`);

      // Get all team rollups with at least one game played
      const rollups = await prisma.teamSeasonRollup.findMany({
        where: {
          league,
          season,
          gamesPlayed: { gt: 0 },
        },
      });

      if (rollups.length === 0) {
        console.log(`[Job C] No team data for ${league} ${season}, skipping`);
        continue;
      }

      // Calculate per-game averages for each team, then average across all teams
      let totalOff2ptm = 0, totalOff2pta = 0;
      let totalOff3ptm = 0, totalOff3pta = 0;
      let totalOffFtm = 0, totalOffFta = 0;
      let totalDef2ptmAllowed = 0, totalDef2ptaAllowed = 0;
      let totalDef3ptmAllowed = 0, totalDef3ptaAllowed = 0;
      let totalDefFtmAllowed = 0, totalDefFtaAllowed = 0;
      let totalGames = 0;

      for (const rollup of rollups) {
        const g = rollup.gamesPlayed;
        totalOff2ptm += rollup.off2ptmTotal / g;
        totalOff2pta += rollup.off2ptaTotal / g;
        totalOff3ptm += rollup.off3ptmTotal / g;
        totalOff3pta += rollup.off3ptaTotal / g;
        totalOffFtm += rollup.offFtmTotal / g;
        totalOffFta += rollup.offFtaTotal / g;
        totalDef2ptmAllowed += rollup.def2ptmAllowedTotal / g;
        totalDef2ptaAllowed += rollup.def2ptaAllowedTotal / g;
        totalDef3ptmAllowed += rollup.def3ptmAllowedTotal / g;
        totalDef3ptaAllowed += rollup.def3ptaAllowedTotal / g;
        totalDefFtmAllowed += rollup.defFtmAllowedTotal / g;
        totalDefFtaAllowed += rollup.defFtaAllowedTotal / g;
        totalGames += g;
      }

      const teamCount = rollups.length;

      // National averages (average of per-game averages across teams)
      const natOff2ptmPg = totalOff2ptm / teamCount;
      const natOff2ptaPg = totalOff2pta / teamCount;
      const natOff3ptmPg = totalOff3ptm / teamCount;
      const natOff3ptaPg = totalOff3pta / teamCount;
      const natOffFtmPg = totalOffFtm / teamCount;
      const natOffFtaPg = totalOffFta / teamCount;
      const natDef2ptmAllowedPg = totalDef2ptmAllowed / teamCount;
      const natDef2ptaAllowedPg = totalDef2ptaAllowed / teamCount;
      const natDef3ptmAllowedPg = totalDef3ptmAllowed / teamCount;
      const natDef3ptaAllowedPg = totalDef3ptaAllowed / teamCount;
      const natDefFtmAllowedPg = totalDefFtmAllowed / teamCount;
      const natDefFtaAllowedPg = totalDefFtaAllowed / teamCount;

      // Calculate average points per team per game
      // Points = 2*2PTM + 3*3PTM + 1*FTM
      const natPointsPgPerTeam =
        2 * natOff2ptmPg + 3 * natOff3ptmPg + natOffFtmPg;

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

      console.log(`[Job C] National averages for ${league} ${season}:`);
      console.log(`  Teams: ${teamCount}, Total games: ${totalGames}`);
      console.log(`  Avg points/team/game: ${natPointsPgPerTeam.toFixed(1)}`);
    } catch (error) {
      console.error(`[Job C] Error computing averages for ${league}:`, error);
    }
  }

  console.log('[Job C] National averages builder completed');
}
