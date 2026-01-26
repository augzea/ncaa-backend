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
 * Derive season string from event date
 * Rule: if month >= 10 (Oct-Dec), season is YEAR-(YEAR+1 last2)
 *       else (Jan-Sep), season is (YEAR-1)-YEAR last2
 */
function deriveSeasonFromDate(dateStr: string): string {
  const date = new Date(dateStr);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;

  if (month >= 10) return `${year}-${String(year + 1).slice(2)}`;
  return `${year - 1}-${String(year).slice(2)}`;
}

/**
 * Get the current NCAA basketball season string (e.g., "2025-26")
 */
export function getCurrentSeason(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  if (month >= 10) return `${year}-${String(year + 1).slice(2)}`;
  if (month <= 4) return `${year - 1}-${String(year).slice(2)}`;
  return `${year}-${String(year + 1).slice(2)}`;
}

/**
 * Default date range for a season (inclusive start/end, UTC)
 * Example season "2025-26" => 2025-11-01 .. 2026-04-15
 */
export function getDefaultSeasonDateRange(season: string): { start: Date; end: Date } {
  // season = "YYYY-YY"
  const startYear = Number(season.slice(0, 4));
  const endYear = startYear + 1;

  // You can adjust these if you want earlier/later coverage
  const start = new Date(Date.UTC(startYear, 10, 1)); // Nov 1
  const end = new Date(Date.UTC(endYear, 3, 15));    // Apr 15

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
 * Sync schedules for a date window (today → today+days-1)
 */
export async function syncSchedules(days: number = 14): Promise<SyncSchedulesResult> {
  const today = new Date();
  const startDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + days - 1);

  return syncSchedulesRange({
    start: startDate,
    end: endDate,
    season: getCurrentSeason(),
  });
}

/**
 * Sync schedules for an explicit date range (inclusive), BOTH leagues.
 * This is what your /api/admin/sync-season endpoint should call.
 */
export async function syncSchedulesRange(args: {
  start: Date;
  end: Date;
  season: string;
}): Promise<SyncSchedulesResult> {
  const { start, end } = args;

  const client = getESPNClient();

  const startDate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const endDate = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));

  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.floor((endDate.getTime() - startDate.getTime()) / msPerDay) + 1;

  console.log(`[Schedule Sync] Starting ESPN sync for range ${startDate.toISOString().slice(0, 10)} → ${endDate.toISOString().slice(0, 10)} (${days} days)`);

  const result: SyncSchedulesResult = {
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0],
    days,
    mens: { teamsInserted: 0, teamsUpdated: 0, gamesInserted: 0, gamesUpdated: 0, errors: [] },
    womens: { teamsInserted: 0, teamsUpdated: 0, gamesInserted: 0, gamesUpdated: 0, errors: [] },
    totalErrors: [],
  };

  const leagues: Array<{ key: League; resultKey: 'mens' | 'womens' }> = [
    { key: 'MENS', resultKey: 'mens' },
    { key: 'WOMENS', resultKey: 'womens' },
  ];

  for (const { key: league, resultKey } of leagues) {
    console.log(`[Schedule Sync] Syncing ${league} league...`);

    for (let offset = 0; offset < days; offset++) {
      const date = new Date(startDate);
      date.setUTCDate(date.getUTCDate() + offset);
      const dateStr = formatDateYYYYMMDD(date);

      try {
        const events = await client.getScoreboard(league, dateStr);
        console.log(`[Schedule Sync] ${league} ${dateStr}: ${events.length} events`);

        for (const event of events) {
          try {
            // ESPN event.date tells us season boundaries too, but we store season derived from event date
            const season = deriveSeasonFromDate(event.date);

            const homeTeamResult = await upsertTeam(
              league as PrismaLeague,
              season,
              event.home.id,
              event.home.displayName,
              event.home.conference ?? null
            );
            result[resultKey].teamsInserted += homeTeamResult.inserted ? 1 : 0;
            result[resultKey].teamsUpdated += homeTeamResult.inserted ? 0 : 1;

            const awayTeamResult = await upsertTeam(
              league as PrismaLeague,
              season,
              event.away.id,
              event.away.displayName,
              event.away.conference ?? null
            );
            result[resultKey].teamsInserted += awayTeamResult.inserted ? 1 : 0;
            result[resultKey].teamsUpdated += awayTeamResult.inserted ? 0 : 1;

            const gameResult = await upsertGame(
              league as PrismaLeague,
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
            console.error(`[Schedule Sync] ${league} error: ${errMsg}`);
          }
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (dateError) {
        const errMsg = `${league} ${dateStr}: ${String(dateError)}`;
        result[resultKey].errors.push(errMsg);
        result.totalErrors.push(errMsg);
        console.error(`[Schedule Sync] Error: ${errMsg}`);
      }
    }
  }

  console.log(
    `[Schedule Sync] Complete. Total games: ${
      result.mens.gamesInserted +
      result.mens.gamesUpdated +
      result.womens.gamesInserted +
      result.womens.gamesUpdated
    }`
  );

  return result;
}

/**
 * Upsert a team and ensure TeamSeasonRollup exists.
 * Your schema has TeamSeasonRollup.teamId @unique so we upsert by teamId only.
 */
async function upsertTeam(
  league: PrismaLeague,
  season: string,
  providerTeamId: string,
  name: string,
  conference: string | null
): Promise<{ team: { id: string }; inserted: boolean }> {
  const existing = await prisma.team.findUnique({
    where: { league_season_providerTeamId: { league, season, providerTeamId } },
  });

  const team = await prisma.team.upsert({
    where: { league_season_providerTeamId: { league, season, providerTeamId } },
    create: { league, season, providerTeamId, name, conference },
    update: { name, conference },
  });

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
    where: { league_season_providerGameId: { league, season, providerGameId: event.id } },
  });

  await prisma.game.upsert({
    where: { league_season_providerGameId: { league, season, providerGameId: event.id } },
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
      status: mapGameStatus(event),
      homeScore: event.home.score ?? null,
      awayScore: event.away.score ?? null,
      lastSyncedAt: new Date(),
    },
  });

  return { inserted: !existing };
}
