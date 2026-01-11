import { prisma } from '../lib/prisma.js';
import { getSportradarClient } from '../lib/sportradar.js';
import { derive2ptFromFg } from '../lib/calculations.js';
import { League as PrismaLeague } from '@prisma/client';
import { getCurrentSeason } from './schedule-sync.js';

/**
 * Job B: Final Game Processor
 * Runs every 15-60 minutes to process completed games
 */
export async function processCompletedGames(): Promise<void> {
  console.log('[Job B] Starting final game processor...');
  const client = getSportradarClient();
  const season = getCurrentSeason();

  // Find games that are FINAL but not yet processed
  const unprocessedGames = await prisma.game.findMany({
    where: {
      status: 'FINAL',
      statsProcessed: false,
    },
    include: {
      homeTeam: true,
      awayTeam: true,
    },
  });

  console.log(`[Job B] Found ${unprocessedGames.length} unprocessed final games`);

  for (const game of unprocessedGames) {
    try {
      console.log(`[Job B] Processing game ${game.providerGameId}: ${game.awayTeam.name} @ ${game.homeTeam.name}`);

      // Fetch boxscore from Sportradar
      const boxscore = await client.getBoxscore(game.league as PrismaLeague, game.providerGameId);

      if (!boxscore.home.statistics || !boxscore.away.statistics) {
        console.log(`[Job B] No statistics available for game ${game.providerGameId}, skipping`);
        continue;
      }

      const homeStats = boxscore.home.statistics;
      const awayStats = boxscore.away.statistics;

      // Derive 2PT from FG and 3PT
      const home2pt = derive2ptFromFg(
        homeStats.field_goals_made,
        homeStats.field_goals_att,
        homeStats.three_points_made,
        homeStats.three_points_att
      );

      const away2pt = derive2ptFromFg(
        awayStats.field_goals_made,
        awayStats.field_goals_att,
        awayStats.three_points_made,
        awayStats.three_points_att
      );

      // Create team game stats for home team
      await prisma.teamGameStats.create({
        data: {
          gameId: game.id,
          teamId: game.homeTeamId,
          opponentId: game.awayTeamId,
          league: game.league,
          season: game.season,
          // Home team offensive stats
          off2ptm: home2pt.twoPtm,
          off2pta: home2pt.twoPta,
          off3ptm: homeStats.three_points_made,
          off3pta: homeStats.three_points_att,
          offFtm: homeStats.free_throws_made,
          offFta: homeStats.free_throws_att,
          // Home team defensive stats (what away team scored = what home allowed)
          def2ptmAllowed: away2pt.twoPtm,
          def2ptaAllowed: away2pt.twoPta,
          def3ptmAllowed: awayStats.three_points_made,
          def3ptaAllowed: awayStats.three_points_att,
          defFtmAllowed: awayStats.free_throws_made,
          defFtaAllowed: awayStats.free_throws_att,
        },
      });

      // Create team game stats for away team
      await prisma.teamGameStats.create({
        data: {
          gameId: game.id,
          teamId: game.awayTeamId,
          opponentId: game.homeTeamId,
          league: game.league,
          season: game.season,
          // Away team offensive stats
          off2ptm: away2pt.twoPtm,
          off2pta: away2pt.twoPta,
          off3ptm: awayStats.three_points_made,
          off3pta: awayStats.three_points_att,
          offFtm: awayStats.free_throws_made,
          offFta: awayStats.free_throws_att,
          // Away team defensive stats (what home team scored = what away allowed)
          def2ptmAllowed: home2pt.twoPtm,
          def2ptaAllowed: home2pt.twoPta,
          def3ptmAllowed: homeStats.three_points_made,
          def3ptaAllowed: homeStats.three_points_att,
          defFtmAllowed: homeStats.free_throws_made,
          defFtaAllowed: homeStats.free_throws_att,
        },
      });

      // Update season rollups for both teams
      await updateTeamSeasonRollup(game.homeTeamId, game.league, season);
      await updateTeamSeasonRollup(game.awayTeamId, game.league, season);

      // Mark game as processed
      await prisma.game.update({
        where: { id: game.id },
        data: {
          statsProcessed: true,
          homeScore: boxscore.home.statistics?.points ?? game.homeScore,
          awayScore: boxscore.away.statistics?.points ?? game.awayScore,
        },
      });

      console.log(`[Job B] Successfully processed game ${game.providerGameId}`);

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`[Job B] Error processing game ${game.providerGameId}:`, error);
    }
  }

  console.log('[Job B] Final game processor completed');
}

/**
 * Update a team's season rollup by aggregating all their game stats
 */
async function updateTeamSeasonRollup(
  teamId: string,
  league: PrismaLeague,
  season: string
): Promise<void> {
  // Aggregate all game stats for this team
  const stats = await prisma.teamGameStats.aggregate({
    where: {
      teamId,
      league,
      season,
    },
    _count: true,
    _sum: {
      off2ptm: true,
      off2pta: true,
      off3ptm: true,
      off3pta: true,
      offFtm: true,
      offFta: true,
      def2ptmAllowed: true,
      def2ptaAllowed: true,
      def3ptmAllowed: true,
      def3ptaAllowed: true,
      defFtmAllowed: true,
      defFtaAllowed: true,
    },
  });

  await prisma.teamSeasonRollup.upsert({
    where: { teamId },
    create: {
      teamId,
      league,
      season,
      gamesPlayed: stats._count,
      off2ptmTotal: stats._sum.off2ptm ?? 0,
      off2ptaTotal: stats._sum.off2pta ?? 0,
      off3ptmTotal: stats._sum.off3ptm ?? 0,
      off3ptaTotal: stats._sum.off3pta ?? 0,
      offFtmTotal: stats._sum.offFtm ?? 0,
      offFtaTotal: stats._sum.offFta ?? 0,
      def2ptmAllowedTotal: stats._sum.def2ptmAllowed ?? 0,
      def2ptaAllowedTotal: stats._sum.def2ptaAllowed ?? 0,
      def3ptmAllowedTotal: stats._sum.def3ptmAllowed ?? 0,
      def3ptaAllowedTotal: stats._sum.def3ptaAllowed ?? 0,
      defFtmAllowedTotal: stats._sum.defFtmAllowed ?? 0,
      defFtaAllowedTotal: stats._sum.defFtaAllowed ?? 0,
    },
    update: {
      gamesPlayed: stats._count,
      off2ptmTotal: stats._sum.off2ptm ?? 0,
      off2ptaTotal: stats._sum.off2pta ?? 0,
      off3ptmTotal: stats._sum.off3ptm ?? 0,
      off3ptaTotal: stats._sum.off3pta ?? 0,
      offFtmTotal: stats._sum.offFtm ?? 0,
      offFtaTotal: stats._sum.offFta ?? 0,
      def2ptmAllowedTotal: stats._sum.def2ptmAllowed ?? 0,
      def2ptaAllowedTotal: stats._sum.def2ptaAllowed ?? 0,
      def3ptmAllowedTotal: stats._sum.def3ptmAllowed ?? 0,
      def3ptaAllowedTotal: stats._sum.def3ptaAllowed ?? 0,
      defFtmAllowedTotal: stats._sum.defFtmAllowed ?? 0,
      defFtaAllowedTotal: stats._sum.defFtaAllowed ?? 0,
    },
  });
}
