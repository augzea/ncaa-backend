import { prisma } from '../lib/prisma.js';
import { getESPNClient } from '../lib/espn.js';
import { derive2ptFromFg } from '../lib/calculations.js';
import { League as PrismaLeague } from '@prisma/client';

/**
 * Result of processing completed games
 */
export interface ProcessCompletedGamesResult {
  gamesFound: number;
  gamesProcessed: number;
  gamesSkipped: number;
  errors: string[];
}

/**
 * Job B: Final Game Processor
 * Processes completed games and extracts team shooting stats
 */
export async function processCompletedGames(): Promise<ProcessCompletedGamesResult> {
  console.log('[Game Processor] Starting...');
  const client = getESPNClient();

  const result: ProcessCompletedGamesResult = {
    gamesFound: 0,
    gamesProcessed: 0,
    gamesSkipped: 0,
    errors: [],
  };

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
    orderBy: { dateTime: 'asc' },
  });

  result.gamesFound = unprocessedGames.length;
  console.log(`[Game Processor] Found ${unprocessedGames.length} unprocessed final games`);

  for (const game of unprocessedGames) {
    try {
      console.log(`[Game Processor] Processing ${game.providerGameId}: ${game.awayTeam.name} @ ${game.homeTeam.name}`);

      // Fetch game details from ESPN (parsed boxscore)
      const boxscore = await client.getGameSummary(game.league as PrismaLeague, game.providerGameId);

      if (!boxscore) {
        console.log(`[Game Processor] No boxscore returned for ${game.providerGameId}, skipping`);
        result.gamesSkipped++;
        continue;
      }

      // ESPN sometimes fails to attach statistics for one/both teams
      const homeStats = boxscore.home.statistics;
      const awayStats = boxscore.away.statistics;

      if (!homeStats || !awayStats) {
        console.log(
          `[Game Processor] Missing stats for ${game.providerGameId}. homeStats=${!!homeStats} awayStats=${!!awayStats}. Skipping.`
        );
        result.gamesSkipped++;
        continue;
      }

      // Compute 2PT from FG and 3PT: 2PTM = FGM - 3PTM, 2PTA = FGA - 3PTA
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

      // Upsert team game stats for HOME team
      await prisma.teamGameStats.upsert({
        where: {
          gameId_teamId: {
            gameId: game.id,
            teamId: game.homeTeamId,
          },
        },
        create: {
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

          // Home team defensive stats (what opponent scored)
          def2ptmAllowed: away2pt.twoPtm,
          def2ptaAllowed: away2pt.twoPta,
          def3ptmAllowed: awayStats.three_points_made,
          def3ptaAllowed: awayStats.three_points_att,
          defFtmAllowed: awayStats.free_throws_made,
          defFtaAllowed: awayStats.free_throws_att,
        },
        update: {
          off2ptm: home2pt.twoPtm,
          off2pta: home2pt.twoPta,
          off3ptm: homeStats.three_points_made,
          off3pta: homeStats.three_points_att,
          offFtm: homeStats.free_throws_made,
          offFta: homeStats.free_throws_att,
          def2ptmAllowed: away2pt.twoPtm,
          def2ptaAllowed: away2pt.twoPta,
          def3ptmAllowed: awayStats.three_points_made,
          def3ptaAllowed: awayStats.three_points_att,
          defFtmAllowed: awayStats.free_throws_made,
          defFtaAllowed: awayStats.free_throws_att,
        },
      });

      // Upsert team game stats for AWAY team
      await prisma.teamGameStats.upsert({
        where: {
          gameId_teamId: {
            gameId: game.id,
            teamId: game.awayTeamId,
          },
        },
        create: {
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

          // Away team defensive stats (what home scored)
          def2ptmAllowed: home2pt.twoPtm,
          def2ptaAllowed: home2pt.twoPta,
          def3ptmAllowed: homeStats.three_points_made,
          def3ptaAllowed: homeStats.three_points_att,
          defFtmAllowed: homeStats.free_throws_made,
          defFtaAllowed: homeStats.free_throws_att,
        },
        update: {
          off2ptm: away2pt.twoPtm,
          off2pta: away2pt.twoPta,
          off3ptm: awayStats.three_points_made,
          off3pta: awayStats.three_points_att,
          offFtm: awayStats.free_throws_made,
          offFta: awayStats.free_throws_att,
          def2ptmAllowed: home2pt.twoPtm,
          def2ptaAllowed: home2pt.twoPta,
          def3ptmAllowed: homeStats.three_points_made,
          def3ptaAllowed: homeStats.three_points_att,
          defFtmAllowed: homeStats.free_throws_made,
          defFtaAllowed: homeStats.free_throws_att,
        },
      });

      // Update season rollups for both teams (aggregate update)
      await updateTeamSeasonRollup(game.homeTeamId, game.league as PrismaLeague, game.season);
      await updateTeamSeasonRollup(game.awayTeamId, game.league as PrismaLeague, game.season);

      // Mark game as processed + ensure scores are stored
      await prisma.game.update({
        where: { id: game.id },
        data: {
          statsProcessed: true,
          homeScore: homeStats.points ?? game.homeScore,
          awayScore: awayStats.points ?? game.awayScore,
        },
      });

      result.gamesProcessed++;
      console.log(`[Game Processor] Successfully processed ${game.providerGameId}`);
    } catch (error) {
      const errMsg = `Game ${game.providerGameId}: ${String(error)}`;
      result.errors.push(errMsg);
      console.error(`[Game Processor] Error: ${errMsg}`);
    }
  }

  console.log(
    `[Game Processor] Complete. Processed: ${result.gamesProcessed}, Skipped: ${result.gamesSkipped}, Errors: ${result.errors.length}`
  );
  return result;
}

/**
 * Update a team's season rollup by aggregating all their game stats
 */
async function updateTeamSeasonRollup(teamId: string, league: PrismaLeague, season: string): Promise<void> {
  const stats = await prisma.teamGameStats.aggregate({
    where: { teamId, league, season },
    _count: { _all: true },
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

  const gamesPlayed = stats._count._all;

  await prisma.teamSeasonRollup.upsert({
    where: { teamId },
    create: {
      teamId,
      league,
      season,
      gamesPlayed,
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
      gamesPlayed,
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
