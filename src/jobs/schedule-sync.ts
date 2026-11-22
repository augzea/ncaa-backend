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
 * Get the current NCAA basketball season string (e.g., "2025-26")
 */
export function getCurrentSeason(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  // NCAA season typically spans Nov-Apr
  if (month >= 10) {
    return `${year}-${String(year + 1).slice(2)}`;
  }
  if (month <= 4) {
    return `${year - 1}-${String(year).slice(2)}`;
  }
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
  const end = new Date(Date.UTC(endYear, 3, 15));     // Apr 15
  return { start, end };
}

/**
 * Map ESPN game status to our status enum
 * IMPORTANT: handle POSTPONED/CANCELLED before "completed"
 */
function mapGameStatus(event: ESPNEventData): GameStatus {
  const statusName = (event.statusName || '').toUpperCase();

  if (statusName.includes('POSTPON')) return 'POSTPONED';
  if (statusName.includes('CANCEL')) return 'CANCELLED';

  // ESPN state hints
  switch (event.statusState) {
    case 'post':
      return 'FINAL';
    case 'in':
      return 'IN_PROGRESS';
    case 'pre':
      return 'SCHEDULED';
  }

  // Fallback: completed flag
  if (event.completed) return 'FINAL';

  return 'SCHEDULED';
}

const RECENT_SCOREBOARD_DAYS = 3;
const scoreboardDateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

/**
 * Refresh recent results and the next N days (including today) for both leagues.
 * ESPN scoreboard dates are Eastern calendar dates, not UTC game timestamps.
 */
export async function syncSchedules(days: number = 14): Promise<SyncSchedulesResult> {
  const parts = scoreboardDateFormat.formatToParts(new Date());
  const part = (type: 'year' | 'month' | 'day') => Number(parts.find(p => p.type === type)?.value);
  // Use UTC as a date-only counter so ET daylight saving changes don't shift days.
  const today = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - RECENT_SCOREBOARD_DAYS);
  const end = new Date(today);
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
    mens: { teamsInserted: 0, teamsUpdated: 0, gamesInserted: 0, gamesUpdated: 0, errors: [] },
    womens: { teamsInserted: 0, teamsUpdated: 0, gamesInserted: 0, gamesUpdated: 0, errors: [] },
    totalErrors: [],
  };

  const leagues: Array<{ key: League; prismaLeague: PrismaLeague; resultKey: 'mens' | 'womens' }> = [
    { key: 'MENS', prismaLeague: PrismaLeague.MENS, resultKey: 'mens' },
    { key: 'WOMENS', prismaLeague: PrismaLeague.WOMENS, resultKey: 'womens' },
  ];

  for (const { key: league, prismaLeague, resultKey } of leagues) {
    for (let i = 0; i < days; i++) {
      const date = new Date(start.getTime() + i * msPerDay);
      const dateStr = formatDateYYYYMMDD(date);

      try {
        const events = await client.getScoreboard(league, dateStr);

        for (const event of events) {
          try {
            // Upsert teams (including placeholder "TBD" teams if ESPN provides them)
            const homeTeamResult = await upsertTeam(
              prismaLeague,
              season,
              event.home.id,
              event.home.displayName,
            );
            result[resultKey].teamsInserted += homeTeamResult.inserted ? 1 : 0;
            result[resultKey].teamsUpdated += homeTeamResult.inserted ? 0 : 1;

            const awayTeamResult = await upsertTeam(
              prismaLeague,
              season,
              event.away.id,
              event.away.displayName,
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
 * NOTE: TeamSeasonRollup is unique by teamId only in your schema.
 */
async function upsertTeam(
  league: PrismaLeague,
  season: string,
  providerTeamId: string,
  name: string,
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

  await prisma.teamSeasonRollup.upsert({
    where: { teamId: team.id },
    create: { teamId: team.id, league, season },
    update: { league, season },
  });

  return { team, inserted: !existing };
}

/**
 * Upsert a game
 * IMPORTANT FIX: update homeTeamId/awayTeamId so TBD games can become real matchups later.
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

  const status = mapGameStatus(event);
  const { score: homeScore } = event.home;
  const { score: awayScore } = event.away;
  // Treat partial scores and the empty 0-0 placeholder as unavailable. Never mix
  // one side of a new snapshot with a score from a previous snapshot.
  const scores = (status === 'IN_PROGRESS' || status === 'FINAL') &&
    homeScore !== undefined && awayScore !== undefined && (homeScore > 0 || awayScore > 0)
    ? { homeScore, awayScore }
    : undefined;
  // Do not promote a stale in-progress score to a final result. An incomplete
  // follow-up snapshot may only retain scores that were already marked final.
  const scoreUpdate = scores ?? (status === 'FINAL' && existing?.status !== 'FINAL'
    ? { homeScore: null, awayScore: null }
    : undefined);

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
      status,
      ...scores,
      lastSyncedAt: new Date(),
    },
    update: {
      dateTime: new Date(event.date),

      // ✅ THESE are what fixes "TBD vs TBD" not updating:
      homeTeamId,
      awayTeamId,
      neutralSite: event.neutralSite,

      status,
      ...scoreUpdate,
      lastSyncedAt: new Date(),
    },
  });

  return { inserted: !existing };
}
