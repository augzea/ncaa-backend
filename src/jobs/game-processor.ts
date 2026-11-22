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

export type ProcessCompletedGamesOptions = {
  /**
   * Max number of games to process per run (batch size).
   * Keep this modest to avoid Railway timeouts.
   */
  limit?: number;
};

/**
 * Job B: Final Game Processor
 * Processes FINAL games that are statsProcessed=false and writes TeamGameStats + rollups
 *
 * IMPORTANT: This runs in batches to avoid HTTP timeouts on Railway.
 */
export async function processCompletedGames(
  options: ProcessCompletedGamesOptions = {}
): Promise<ProcessCompletedGamesResult> {
  const limit = Number.isFinite(options.limit) ? Number(options.limit) : 50;

  console.log(`[Game Processor] Starting batch... (limit=${limit})`);
  const client = getESPNClient();

  const result: ProcessCompletedGamesResult = {
    gamesFound: 0,
    gamesProcessed: 0,
    gamesSkipped: 0,
    errors: [],
  };

  // Find FINAL games not yet processed (batch)
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
    take: limit,
  });

  result.gamesFound = unprocessedGames.length;
  console.log(`[Game Processor] Found ${unprocessedGames.length} unprocessed final games (this batch)`);

  for (const game of unprocessedGames) {
    try {
      console.log(
        `[Game Processor] Processing providerGameId=${game.providerGameId}: ${game.awayTeam.name} @ ${game.homeTeam.name}`
      );

      const boxscore = await client.getGameSummary(game.league as PrismaLeague, game.providerGameId);

if (!boxscore || !boxscore.home.statistics || !boxscore.away.statistics) {
  console.log(`[Game Processor] No statistics available for ${game.providerGameId}, marking processed and skipping`);

  await prisma.game.update({
    where: { id: game.id },
    data: {
      statsProcessed: true, // IMPORTANT: prevents re-processing loop
      lastSyncedAt: new Date(),
    },
  });

  result.gamesSkipped++;
  continue;
}

      const homeStats = boxscore.home.statistics;
      const awayStats = boxscore.away.statistics;

      const home2pt = derive2ptFromFg(
        homeStats.field_goals_made,
        homeStats.field_goals_att,
        homeStats.three_points_made,
        homeStats.three_points_att
      );

      const away2pt = derive2ptFromFg(
        awayStats.field_goals_made,
