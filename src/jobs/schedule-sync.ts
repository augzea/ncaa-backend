import { prisma } from '../lib/prisma.js';
import { getSportradarClient } from '../lib/sportradar.js';
import type { League } from '../lib/types.js';
import { League as PrismaLeague, GameStatus } from '@prisma/client';

/**
 * Get the current NCAA basketball season string (e.g., "2025-26")
 */
export function getCurrentSeason(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  // NCAA basketball season runs Nov-April
  // If we're in Nov-Dec, season is current year - next year
  // If we're in Jan-April, season is prev year - current year
  if (month >= 11) {
    return `${year}-${String(year + 1).slice(2)}`;
  } else if (month <= 4) {
    return `${year - 1}-${String(year).slice(2)}`;
  } else {
    // Off-season: default to upcoming season
    return `${year}-${String(year + 1).slice(2)}`;
  }
}

/**
 * Map Sportradar game status to our status enum
 */
function mapGameStatus(status: string): GameStatus {
  const statusMap: Record<string, GameStatus> = {
    'scheduled': 'SCHEDULED',
    'created': 'SCHEDULED',
    'inprogress': 'IN_PROGRESS',
    'halftime': 'IN_PROGRESS',
    'closed': 'FINAL',
    'complete': 'FINAL',
    'postponed': 'POSTPONED',
    'cancelled': 'CANCELLED',
    'delayed': 'SCHEDULED',
    'unnecessary': 'CANCELLED',
  };

  return statusMap[status.toLowerCase()] || 'SCHEDULED';
}

/**
 * Job A: Schedule Sync
 * Runs every 3-6 hours to fetch schedules for today through +14 days
 */
export async function syncSchedules(): Promise<void> {
  console.log('[Job A] Starting schedule sync...');
  const client = getSportradarClient();
  const season = getCurrentSeason();
  const startDate = new Date();

  const leagues: League[] = ['MENS', 'WOMENS'];

  for (const league of leagues) {
    console.log(`[Job A] Syncing ${league} schedule for season ${season}...`);

    try {
      const games = await client.getScheduleRange(league as League, startDate, 14);
      console.log(`[Job A] Found ${games.length} games for ${league}`);

      for (const game of games) {
        // Ensure teams exist
        const homeTeam = await upsertTeam(
          league as PrismaLeague,
          season,
          game.home.id,
          game.home.market ? `${game.home.market} ${game.home.name}` : game.home.name
        );

        const awayTeam = await upsertTeam(
          league as PrismaLeague,
          season,
          game.away.id,
          game.away.market ? `${game.away.market} ${game.away.name}` : game.away.name
        );

        // Upsert game
        await prisma.game.upsert({
          where: {
            league_season_providerGameId: {
              league: league as PrismaLeague,
              season,
              providerGameId: game.id,
            },
          },
          create: {
            league: league as PrismaLeague,
            season,
            providerGameId: game.id,
            dateTime: new Date(game.scheduled),
            homeTeamId: homeTeam.id,
            awayTeamId: awayTeam.id,
            neutralSite: game.neutral_site || false,
            status: mapGameStatus(game.status),
            homeScore: game.home_points ?? null,
            awayScore: game.away_points ?? null,
            lastSyncedAt: new Date(),
          },
          update: {
            dateTime: new Date(game.scheduled),
            status: mapGameStatus(game.status),
            homeScore: game.home_points ?? null,
            awayScore: game.away_points ?? null,
            lastSyncedAt: new Date(),
          },
        });
      }

      console.log(`[Job A] Completed sync for ${league}`);
    } catch (error) {
      console.error(`[Job A] Error syncing ${league} schedule:`, error);
    }
  }

  console.log('[Job A] Schedule sync completed');
}

/**
 * Upsert a team and ensure it has a season rollup record
 */
async function upsertTeam(
  league: PrismaLeague,
  season: string,
  providerTeamId: string,
  name: string
): Promise<{ id: string }> {
  const team = await prisma.team.upsert({
    where: {
      league_season_providerTeamId: {
        league,
        season,
        providerTeamId,
      },
    },
    create: {
      league,
      season,
      providerTeamId,
      name,
    },
    update: {
      name,
    },
  });

  // Ensure season rollup exists
  await prisma.teamSeasonRollup.upsert({
    where: {
      teamId: team.id,
    },
    create: {
      teamId: team.id,
      league,
      season,
    },
    update: {},
  });

  return team;
}
