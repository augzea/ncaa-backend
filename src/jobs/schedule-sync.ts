import { prisma } from '../lib/prisma.js';
import { getESPNClient, type ESPNEventData } from '../lib/espn.js';
import type { League } from '../lib/types.js';
import { League as PrismaLeague, GameStatus } from '@prisma/client';

export interface LeagueSyncResult {
  teamsInserted: number;
  teamsUpdated: number;
  gamesInserted: number;
  gamesUpdated: number;
  errors: string[];
}

export interface SyncSchedulesResult {
  startDate: string;
  endDate: string;
  days: number;
  mens: LeagueSyncResult;
  womens: LeagueSyncResult;
  totalErrors: string[];
}

function formatDateYYYYMMDD(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function deriveSeasonFromDate(dateStr: string): string {
  const date = new Date(dateStr);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;

  if (month >= 10) return `${year}-${String(year + 1).slice(2)}`;
  return `${year - 1}-${String(year).slice(2)}`;
}

export function getCurrentSeason(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  if (month >= 10) return `${year}-${String(year + 1).slice(2)}`;
  if (month <= 4) return `${year - 1}-${String(year).slice(2)}`;
  return `${year}-${String(year + 1).slice(2)}`;
}

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
      const statusName = event.statusName.toUpperCase();
      if (statusName.includes('POSTPONED')) return 'POSTPONED';
      if (statusName.includes('CANCEL')) return 'CANCELLED';
      return 'SCHEDULED';
    }
  }
}

function parseSeasonToYears(season: string): { startYear: number; endYear: number } {
  // "2025-26"
  const m = /^(\d{4})-(\d{2})$/.exec(season);
  if (!m) throw new Error(`Invalid season format: ${season}`);
  const startYear = parseInt(m[1], 10);
  const endYear = parseInt(`${String(startYear).slice(0, 2)}${m[2]}`, 10);
  return { startYear, endYear };
}

function defaultSeasonWindow(season: string): { start: Date; end: Date } {
  const { startYear, endYear } = parseSeasonToYears(season);

  // Reasonable defaults that cover all D1 games:
  // Nov 1 -> Apr 15 (covers regular season + conference tourneys + NCAA tourney)
  const start = new Date(Date.UTC(startYear, 10, 1)); // month 10 = November
  const end = new Date(Date.UTC(endYear, 3, 15)); // month 3 = April
  return { start, end };
}

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

/**
 * OLD behavior: sync next N days starting today (kept for convenience).
 */
export async function syncSchedules(days: number = 14): Promise<SyncSchedulesResult> {
  const today = new Date();
  const startDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + days - 1);

  return syncDateRangeBothLeagues(startDate, endDate);
}

/**
 * NEW: Sync a full season (or custom window) for BOTH leagues.
 * This is what you want for accurate national averages.
 */
export async function syncSeasonBothLeagues(
  season: string,
  startISO?: string,
  endISO?: string
): Promise<SyncSchedulesResult> {
  const window = defaultSeasonWindow(season);

  const start = startISO ? new Date(`${startISO}T00:00:00.000Z`) : window.start;
  const end = endISO ? new Date(`${endISO}T00:00:00.000Z`) : window.end;

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Invalid start or end date');
  }
  if (end < start) {
    throw new Error('End date must be >= start date');
  }

  return syncDateRangeBothLeagues(start, end, season);
}

async function syncDateRangeBothLeagues(
  startDate: Date,
  endDate: Date,
  forcedSeason?: string
): Promise<SyncSchedulesResult> {
  const client = getESPNClient();

  // inclusive range
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.floor((endDate.getTime() - startDate.getTime()) / msPerDay) + 1;

  const result: SyncSchedulesResult = {
    startDate: isoDate(startDate),
    endDate: isoDate(endDate),
    days,
    mens: { teamsInserted: 0, teamsUpdated: 0, gamesInserted: 0, gamesUpdated: 0, errors: [] },
    womens: { teamsInserted: 0, teamsUpdated: 0, gamesInserted: 0, gamesUpdated: 0, errors: [] },
    totalErrors: [],
  };

  const leagues: Array<{ key: League; resultKey: 'mens' | 'womens' }> = [
    { key: 'MENS', resultKey: 'mens' },
    { key: 'WOMENS', resultKey: 'womens' },
  ];

  console.log(`[Schedule Sync] Syncing BOTH leagues: ${result.startDate} -> ${result.endDate} (${days} days)`);

  for (const { key: league, resultKey } of leagues) {
    console.log(`[Schedule Sync] Syncing ${league}...`);

    for (let i = 0; i < days; i++) {
      const date = new Date(startDate);
      date.setUTCDate(date.getUTCDate() + i);
      const dateStr = formatDateYYYYMMDD(date);

      try {
        const events = await client.getScoreboard(league, dateStr);
        console.log(`[Schedule Sync] ${league} ${dateStr}: ${events.length} events`);

        for (const event of events) {
          try {
            const season = forcedSeason ?? deriveSeasonFromDate(event.date);

            const homeTeamResult = await upsertTeam(
              league as PrismaLeague,
              season,
              event.home.id,
              event.home.displayName,
              event.home.abbreviation
            );
            result[resultKey].teamsInserted += homeTeamResult.inserted ? 1 : 0;
            result[resultKey].teamsUpdated += homeTeamResult.inserted ? 0 : 1;

            const awayTeamResult = await upsertTeam(
              league as PrismaLeague,
              season,
              event.away.id,
              event.away.displayName,
              event.away.abbreviation
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
            console.error(`[Schedule Sync] ${league} event error: ${errMsg}`);
          }
        }
      } catch (dateError) {
        const errMsg = `${league} ${dateStr}: ${String(dateError)}`;
        result[resultKey].errors.push(errMsg);
        result.totalErrors.push(errMsg);
        console.error(`[Schedule Sync] ${errMsg}`);
      }
    }

    console.log(
      `[Schedule Sync] ${league} complete: inserted games=${result[resultKey].gamesInserted}, updated games=${result[resultKey].gamesUpdated}`
    );
  }

  console.log(
    `[Schedule Sync] DONE. total games written = ${
      result.mens.gamesInserted +
      result.mens.gamesUpdated +
      result.womens.gamesInserted +
      result.womens.gamesUpdated
    }`
  );

  return result;
}

/**
 * Upsert a team + ensure rollup exists.
 *
 * NOTE: your current Prisma schema has:
 * - TeamSeasonRollup unique by teamId only (teamId String @unique)
 * So we upsert by { teamId }.
 */
async function upsertTeam(
  league: PrismaLeague,
  season: string,
  providerTeamId: string,
  name: string,
  shortName?: string
): Promise<{ team: { id: string }; inserted: boolean }> {
  const existing = await prisma.team.findUnique({
    where: {
      league_season_providerTeamId: { league, season, providerTeamId },
    },
  });

  // Your schema DOES NOT have Team.shortName. Only write fields that exist.
  const team = await prisma.team.upsert({
    where: {
      league_season_providerTeamId: { league, season, providerTeamId },
    },
    create: {
      league,
      season,
      providerTeamId,
      name,
      // conference: null, // optional, exists but nullable
    },
    update: {
      name,
    },
  });

  await prisma.teamSeasonRollup.upsert({
    where: { teamId: team.id },
    create: { teamId: team.id, league, season },
    update: { league, season },
  });

  return { team, inserted: !existing };
}

async function upsertGame(
  league: PrismaLeague,
  season: string,
  event: ESPNEventData,
  homeTeamId: string,
  awayTeamId: string
): Promise<{ inserted: boolean }> {
  const existing = await prisma.game.findUnique({
    where: {
      league_season_providerGameId: { league, season, providerGameId: event.id },
    },
  });

  await prisma.game.upsert({
    where: {
      league_season_providerGameId: { league, season, providerGameId: event.id },
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
      neutralSite: event.neutralSite,
      status: mapGameStatus(event),
      homeScore: event.home.score ?? null,
      awayScore: event.away.score ?? null,
      lastSyncedAt: new Date(),
    },
  });

  return { inserted: !existing };
}
