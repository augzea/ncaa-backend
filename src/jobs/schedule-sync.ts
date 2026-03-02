import { prisma } from '../lib/prisma.js';
import { getESPNClient, type ESPNEventData } from '../lib/espn.js';
import type { League } from '../lib/types.js';
import { League as PrismaLeague, GameStatus } from '@prisma/client';

/**
 * Sync results for a single league
 */
export interface LeagueSyncResult {
  teamsInserted: number;
  teamsUpdated: number;
  gamesInserted: number;
  gamesUpdated: number;
  gamesDeleted: number; // NEW: pruned stale games
  errors: string[];
}

/**
 * Full sync results
 */
export interface SyncSchedulesResult {
  startDate: string;
  endDate: string;
  days: number;
  mens: LeagueSyncResult;
  womens: LeagueSyncResult;
  totalErrors: string[];
}

/**
 * Format date as YYYYMMDD for ESPN API
 */
function formatDateYYYYMMDD(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Get the current NCAA basketball season string (e.g., "2025-26")
 */
export function getCurrentSeason(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  // NCAA season typically spans Nov-Apr
  if (month >= 10) return `${year}-${String(year + 1).slice(2)}`;
  if (month <= 4) return `${year - 1}-${String(year).slice(2)}`;

  // Off-season: default to upcoming season
  return `${year}-${String(year + 1).slice(2)}`;
}

/**
 * Default range for a given season string "YYYY-YY"
 * (Nov 1 -> Apr 15)
 */
export function getDefaultSeasonDateRange(season: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(season);
  if (!m) {
    const cur = getCurrentSeason();
    return getDefaultSeasonDateRange(cur);
  }

  const startYear = Number(m[1]);
  const endYear = startYear + 1;

  const start = new Date(Date.UTC(startYear, 10, 1)); // Nov 1
  const end = new Date(Date.UTC(endYear, 3, 15)); // Apr 15
  return { start, end };
}

/**
 * Map ESPN game status to our status enum
 */
function mapGameStatus(event: ESPNEventData): GameStatus {
  if (event.completed) return 'FINAL';

  switch (event.statusState) {
    case 'post':
      return 'FINAL';
    case 'in':
      return 'IN_PROGRESS';
    case 'pre':
      return 'SCHEDULED';
    default: {
      const statusName = (event.statusName || '').toUpperCase();
      if (statusName.includes('POSTPONED')) return 'POSTPONED';
      if (statusName.includes('CANCEL')) return 'CANCELLED';
      return 'SCHEDULED';
    }
  }
}

/**
 * Utility: start/end UTC bounds for a given UTC date
 */
function dayBoundsUTC(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0));
  return { start, end };
}

/**
 * Prune stale games for a given league/season/day.
 * This fixes "TBD vs TBD" sticking around when ESPN later publishes
 * the real matchup (often with a different event id).
 *
 * Rule: after fetching ESPN's scoreboard for the day, the DB should contain
 * only games whose providerGameId is in the fetched list for that same day.
 */
async function pruneStaleGamesForDay(args: {
  league: PrismaLeague;
  season: string;
  day: Date; // any time within the day (UTC)
  keepProviderGameIds: Set<string>;
}): Promise<number> {
  const { league, season, day, keepProviderGameIds } = args;
  const { start, end } = dayBoundsUTC(day);

  // If ESPN returned nothing, do NOT delete everything for that day.
  // This protects you from a transient ESPN outage/empty response.
  if (keepProviderGameIds.size === 0) return 0;

  const deleted = await prisma.game.deleteMany({
    where: {
      league,
      season,
      dateTime: { gte: start, lt: end },
      // delete games not in ESPN's returned list
      providerGameId: { notIn: Array.from(keepProviderGameIds) },
    },
  });

  return deleted.count;
}

/**
 * Sync schedules for the next N days (both leagues)
 */
export async function syncSchedules(days: number = 14): Promise<SyncSchedulesResult> {
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + (days - 1));

  const season = getCurrentSeason();
  return syncSchedulesRange({ start, end, season });
}

/**
 * FULL RANGE sync (both leagues) for a given season
 * This is what /api/admin/sync-season uses.
 */
export async function syncSchedulesRange(args: {
  start: Date;
  end: Date;
  season: string;
}): Promise<SyncSchedulesResult> {
  const { start, end, season } = args;

  const client = getESPNClient();

  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.floor((end.getTime() - start.getTime()) / msPerDay) + 1;

  const result: SyncSchedulesResult = {
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
    days,
    mens: { teamsInserted: 0, teamsUpdated: 0, gamesInserted: 0, gamesUpdated: 0, gamesDeleted: 0, errors: [] },
    womens: { teamsInserted: 0, teamsUpdated: 0, gamesInserted: 0, gamesUpdated: 0, gamesDeleted: 0, errors: [] },
    totalErrors: [],
  };

  const leagues: Array<{ key: League; prismaLeague: PrismaLeague; resultKey: 'mens' | 'womens' }> = [
    { key: 'MENS', prismaLeague: PrismaLeague.MENS, resultKey: 'mens' },
    { key: 'WOMENS', prismaLeague: PrismaLeague.WOMENS, resultKey: 'womens' },
  ];

  for (const { key: league, prismaLeague, resultKey } of leagues) {
    for (let i = 0; i < days; i++) {
      const day = new Date(start.getTime() + i * msPerDay);
      const dateStr = formatDateYYYYMMDD(day);

      try {
        const events = await client.getScoreboard(league, dateStr);

        // Track providerGameIds returned by ESPN for this day (for pruning)
        const keepIds = new Set<string>();

        for (const event of events) {
          keepIds.add(event.id);

          try {
            // Upsert teams
            const homeTeamResult = await upsertTeam(
              prismaLeague,
              season,
              event.home.id,
              event.home.displayName
            );
            result[resultKey].teamsInserted += homeTeamResult.inserted ? 1 : 0;
            result[resultKey].teamsUpdated += homeTeamResult.inserted ? 0 : 1;

            const awayTeamResult = await upsertTeam(
              prismaLeague,
              season,
              event.away.id,
              event.away.displayName
            );
            result[resultKey].teamsInserted += awayTeamResult.inserted ? 1 : 0;
            result[resultKey].teamsUpdated += awayTeamResult.inserted ? 0 : 1;

            // Upsert game
            const gameResult = await upsertGame(
              prismaLeague,
              season,
              event,
              homeTeamResult.team.id,
              awayTeamResult.team.id
            );
            result[resultKey].gamesInserted += gameResult.inserted ? 1 : 0;
            result[resultKey].gamesUpdated += gameResult.inserted ? 0 : 1;
          } catch (eventError) {
            const errMsg = `Event ${event.id}: ${String(eventError)}`;
            result[resultKey].errors.push(errMsg);
          }
        }

        // NEW: prune stale games for this league/day after a successful fetch
        const prunedCount = await pruneStaleGamesForDay({
          league: prismaLeague,
          season,
          day,
          keepProviderGameIds: keepIds,
        });
        result[resultKey].gamesDeleted += prunedCount;
      } catch (dateError) {
        const errMsg = `${league} ${dateStr}: ${String(dateError)}`;
        result[resultKey].errors.push(errMsg);
        result.totalErrors.push(errMsg);
      }
    }
  }

  return result;
}

/**
 * Upsert a team and ensure it has a season rollup record
 * NOTE: your Prisma schema does NOT have shortName and TeamSeasonRollup is unique by teamId only.
 */
async function upsertTeam(
  league: PrismaLeague,
  season: string,
  providerTeamId: string,
  name: string
): Promise<{ team: { id: string }; inserted: boolean }> {
  const existing = await prisma.team.findUnique({
    where: {
      league_season_providerTeamId: {
        league,
        season,
        providerTeamId,
      },
    },
  });

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

  // Rollup is unique by teamId in YOUR schema
  await prisma.teamSeasonRollup.upsert({
    where: { teamId: team.id },
    create: { teamId: team.id, league, season },
    update: { league, season },
  });

  return { team, inserted: !existing };
}

/**
 * Upsert a game
 */
async function upsertGame(
  league: PrismaLeague,
  season: string,
  event: ESPNEventData,
  homeTeamId: string,
  awayTeamId: string
): Promise<{ inserted: boolean }> {
  const existing = await prisma.game.findUnique({
    where: {
      league_season_providerGameId: {
        league,
        season,
        providerGameId: event.id,
      },
    },
  });

  await prisma.game.upsert({
    where: {
      league_season_providerGameId: {
        league,
        season,
        providerGameId: event.id,
      },
    },
    create: {
      league,
      season,
      providerGameId: event.id,
      dateTime: new Date(event.date),
      homeTeamId,
      awayTeamId,
      neutralSite: event.neutralSite,
      status: mapGameStatus(event),
      homeScore: event.home.score ?? null,
      awayScore: event.away.score ?? null,
      lastSyncedAt: new Date(),
    },
    update: {
      dateTime: new Date(event.date),
      homeTeamId,
      awayTeamId,
      neutralSite: event.neutralSite,
      status: mapGameStatus(event),
      homeScore: event.home.score ?? null,
      awayScore: event.away.score ?? null,
      lastSyncedAt: new Date(),
    },
  });

  return { inserted: !existing };
}
