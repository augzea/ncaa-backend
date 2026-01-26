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
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  days: number;
  mens: LeagueSyncResult;
  womens: LeagueSyncResult;
  totalErrors: string[];
}

function toYYYYMMDD(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function toYYYYMMDDDash(d: Date): string {
  return d.toISOString().split('T')[0];
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
    case 'post': return 'FINAL';
    case 'in': return 'IN_PROGRESS';
    case 'pre': return 'SCHEDULED';
    default: {
      const statusName = (event.statusName || '').toUpperCase();
      if (statusName.includes('POSTPONED')) return 'POSTPONED';
      if (statusName.includes('CANCEL')) return 'CANCELLED';
      return 'SCHEDULED';
    }
  }
}

/**
 * Default full-season windows (you can adjust later)
 * - Men/Women both: Nov 1 → Apr 15 for that season year span
 */
export function getDefaultSeasonDateRange(season: string): { start: Date; end: Date } {
  // season like "2025-26"
  const startYear = parseInt(season.slice(0, 4), 10);
  const endYear = startYear + 1;

  // Nov 1, startYear (UTC)
  const start = new Date(Date.UTC(startYear, 10, 1)); // month 10 = Nov
  // Apr 15, endYear (UTC)
  const end = new Date(Date.UTC(endYear, 3, 15)); // month 3 = Apr

  return { start, end };
}

/**
 * Sync schedules by explicit date range (UTC days inclusive)
 */
export async function syncSchedulesRange(opts: {
  start: Date;
  end: Date;
  season?: string;        // optional override
  leagues?: League[];     // default both
}): Promise<SyncSchedulesResult> {
  const client = getESPNClient();

  const startDate = new Date(Date.UTC(opts.start.getUTCFullYear(), opts.start.getUTCMonth(), opts.start.getUTCDate()));
  const endDate = new Date(Date.UTC(opts.end.getUTCFullYear(), opts.end.getUTCMonth(), opts.end.getUTCDate()));

  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.floor((endDate.getTime() - startDate.getTime()) / msPerDay) + 1;

  const result: SyncSchedulesResult = {
    startDate: toYYYYMMDDDash(startDate),
    endDate: toYYYYMMDDDash(endDate),
    days,
    mens: { teamsInserted: 0, teamsUpdated: 0, gamesInserted: 0, gamesUpdated: 0, errors: [] },
    womens: { teamsInserted: 0, teamsUpdated: 0, gamesInserted: 0, gamesUpdated: 0, errors: [] },
    totalErrors: [],
  };

  const leagues: Array<{ key: League; resultKey: 'mens' | 'womens' }> =
    (opts.leagues?.length ? opts.leagues : (['MENS', 'WOMENS'] as League[])).map(l => ({
      key: l,
      resultKey: l === 'MENS' ? 'mens' : 'womens',
    }));

  console.log(`[Schedule Sync] ESPN range sync ${result.startDate} → ${result.endDate} (${days} days)`);

  for (const { key: league, resultKey } of leagues) {
    console.log(`[Schedule Sync] Syncing ${league}...`);

    for (let i = 0; i < days; i++) {
      const date = new Date(startDate);
      date.setUTCDate(date.getUTCDate() + i);
      const dateStr = toYYYYMMDD(date);

      try {
        const events = await client.getScoreboard(league, dateStr);

        for (const event of events) {
          try {
            const season = opts.season ?? deriveSeasonFromDate(event.date);

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
            result.totalErrors.push(errMsg);
            console.error(`[Schedule Sync] ${league} ${dateStr} error: ${errMsg}`);
          }
        }
      } catch (dateError) {
        const errMsg = `${league} ${dateStr}: ${String(dateError)}`;
        result[resultKey].errors.push(errMsg);
        result.totalErrors.push(errMsg);
        console.error(`[Schedule Sync] Error: ${errMsg}`);
      }
    }

    console.log(
      `[Schedule Sync] ${league} complete: inserted games=${result[resultKey].gamesInserted}, updated games=${result[resultKey].gamesUpdated}`
    );
  }

  return result;
}

/**
 * Convenience: sync next N days starting today (UTC)
 */
export async function syncSchedules(days: number = 14): Promise<SyncSchedulesResult> {
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + days - 1);
  return syncSchedulesRange({ start, end });
}

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

  const team = await prisma.team.upsert({
    where: {
      league_season_providerTeamId: { league, season, providerTeamId },
    },
    create: {
      league,
      season,
      providerTeamId,
      name,
      shortName: shortName ?? null,
    },
    update: {
      name,
      shortName: shortName ?? null,
    },
  });

  await prisma.teamSeasonRollup.upsert({
    where: {
      teamId_league_season: {
        teamId: team.id,
        league,
        season,
      },
    },
    create: {
      teamId: team.id,
      league,
      season,
    },
    update: {},
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
      status: mapGameStatus(event),
      homeScore: event.home.score ?? null,
      awayScore: event.away.score ?? null,
      lastSyncedAt: new Date(),
    },
  });

  return { inserted: !existing };
}
