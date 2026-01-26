import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { calculateGameTotal, calculatePerGameAverages } from '../lib/calculations.js';
import { LeagueSchema, SeasonSchema } from '../lib/types.js';
import type { NationalAveragesData } from '../lib/types.js';

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in format YYYY-MM-DD');

const ET_TZ = 'America/New_York';

// YYYY-MM-DD in ET
const fmtETDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: ET_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function toLocalDateET(d: Date): string {
  return fmtETDate.format(d); // en-CA => YYYY-MM-DD
}

/**
 * Get timezone offset minutes for a given IANA timezone at a specific instant.
 * Uses timeZoneName: 'shortOffset' (Node 18+).
 * Example part: "GMT-5" or "GMT-4"
 */
function getOffsetMinutes(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const tzPart = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT+0';

  // Parse "GMT-5", "GMT-04", "GMT-4", "GMT+0", "GMT+05"
  const m = tzPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/i);
  if (!m) return 0;

  const sign = m[1] === '-' ? -1 : 1;
  const hours = parseInt(m[2], 10);
  const mins = m[3] ? parseInt(m[3], 10) : 0;

  return sign * (hours * 60 + mins);
}

/**
 * Convert an ET calendar date (YYYY-MM-DD) to a UTC range [start, end)
 * representing that entire ET day.
 */
function etDayToUtcRange(dateStrYYYYMMDD: string): { startUtc: Date; endUtc: Date } {
  const [y, m, d] = dateStrYYYYMMDD.split('-').map(n => parseInt(n, 10));

  // Start with a naive UTC midnight for that calendar date…
  // then shift by the ET offset to get the actual UTC instant that corresponds to ET midnight.
  const approxUtc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));

  // Offset (ET) at that approximate instant (good for essentially all basketball-season dates)
  const offsetMinutes = getOffsetMinutes(ET_TZ, approxUtc);

  // ET midnight = UTC time - offsetMinutes
  const startMs = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMinutes * 60_000;
  const startUtc = new Date(startMs);
  const endUtc = new Date(startMs + 24 * 60 * 60 * 1000);

  return { startUtc, endUtc };
}

export async function gamesRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/:league/:season/games
   * Optional: ?date=YYYY-MM-DD (interpreted as ET day)
   */
  fastify.get<{
    Params: { league: string; season: string };
    Querystring: { date?: string };
  }>('/api/:league/:season/games', async (request, reply) => {
    const { league, season } = request.params;
    const { date } = request.query;

    const leagueResult = LeagueSchema.safeParse(league.toUpperCase());
    if (!leagueResult.success) {
      return reply.status(400).send({ error: 'Invalid league. Must be MENS or WOMENS' });
    }

    const seasonResult = SeasonSchema.safeParse(season);
    if (!seasonResult.success) {
      return reply.status(400).send({ error: 'Invalid season format. Must be YYYY-YY' });
    }

    let range: { startUtc: Date; endUtc: Date } | null = null;

    if (date) {
      const dateResult = DateSchema.safeParse(date);
      if (!dateResult.success) {
        return reply.status(400).send({ error: 'Invalid date format. Must be YYYY-MM-DD' });
      }
      // ✅ interpret as ET day boundaries
      range = etDayToUtcRange(date);
    }

    const games = await prisma.game.findMany({
      where: {
        league: leagueResult.data,
        season: seasonResult.data,
        ...(range && {
          dateTime: {
            gte: range.startUtc,
            lt: range.endUtc,
          },
        }),
      },
      include: {
        homeTeam: true,
        awayTeam: true,
      },
      orderBy: { dateTime: 'asc' },
    });

    return games.map(game => ({
      id: game.id,
      providerGameId: game.providerGameId,
      dateTime: game.dateTime.toISOString(),
      localDate: toLocalDateET(game.dateTime), // ✅ ET calendar date
      homeTeam: {
        id: game.homeTeam.id,
        name: game.homeTeam.name,
        providerTeamId: game.homeTeam.providerTeamId,
      },
      awayTeam: {
        id: game.awayTeam.id,
        name: game.awayTeam.name,
        providerTeamId: game.awayTeam.providerTeamId,
      },
      neutralSite: game.neutralSite,
      status: game.status,
      homeScore: game.homeScore,
      awayScore: game.awayScore,
    }));
  });

  /**
   * GET /api/:league/:season/games/week
   * Optional: ?start=YYYY-MM-DD (interpreted as ET week start)
   */
  fastify.get<{
    Params: { league: string; season: string };
    Querystring: { start?: string };
  }>('/api/:league/:season/games/week', async (request, reply) => {
    const { league, season } = request.params;
    const { start } = request.query;

    const leagueResult = LeagueSchema.safeParse(league.toUpperCase());
    if (!leagueResult.success) {
      return reply.status(400).send({ error: 'Invalid league' });
    }

    const seasonResult = SeasonSchema.safeParse(season);
    if (!seasonResult.success) {
      return reply.status(400).send({ error: 'Invalid season format' });
    }

    const startDateStr = start ?? toLocalDateET(new Date());

    const startResult = DateSchema.safeParse(startDateStr);
    if (!startResult.success) {
      return reply.status(400).send({ error: 'Invalid start format. Must be YYYY-MM-DD' });
    }

    // ✅ ET week range: [ET start midnight, +7 days)
    const { startUtc } = etDayToUtcRange(startDateStr);
    const endUtc = new Date(startUtc.getTime() + 7 * 24 * 60 * 60 * 1000);

    const games = await prisma.game.findMany({
      where: {
        league: leagueResult.data,
        season: seasonResult.data,
        dateTime: {
          gte: startUtc,
          lt: endUtc,
        },
      },
      include: {
        homeTeam: true,
        awayTeam: true,
      },
      orderBy: { dateTime: 'asc' },
    });

    return games.map(game => ({
      id: game.id,
      providerGameId: game.providerGameId,
      dateTime: game.dateTime.toISOString(),
      localDate: toLocalDateET(game.dateTime),
      homeTeam: {
        id: game.homeTeam.id,
        name: game.homeTeam.name,
        providerTeamId: game.homeTeam.providerTeamId,
      },
      awayTeam: {
        id: game.awayTeam.id,
        name: game.awayTeam.name,
        providerTeamId: game.awayTeam.providerTeamId,
      },
      neutralSite: game.neutralSite,
      status: game.status,
      homeScore: game.homeScore,
      awayScore: game.awayScore,
    }));
  });

  /**
   * GET /api/:league/:season/games/:gameId/expected
   */
  fastify.get<{
    Params: { league: string; season: string; gameId: string };
  }>('/api/:league/:season/games/:gameId/expected', async (request, reply) => {
    const { league, season, gameId } = request.params;

    const leagueResult = LeagueSchema.safeParse(league.toUpperCase());
    if (!leagueResult.success) {
      return reply.status(400).send({ error: 'Invalid league' });
    }

    const seasonResult = SeasonSchema.safeParse(season);
    if (!seasonResult.success) {
      return reply.status(400).send({ error: 'Invalid season format' });
    }

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: {
        homeTeam: { include: { seasonRollup: true } },
        awayTeam: { include: { seasonRollup: true } },
      },
    });

    if (!game) return reply.status(404).send({ error: 'Game not found' });

    const nationals = await prisma.nationalAverages.findUnique({
      where: {
        league_season: {
          league: leagueResult.data,
          season: seasonResult.data,
        },
      },
    });

    if (!nationals) {
      return reply.status(404).send({ error: 'National averages not available for this league/season' });
    }

    const homeRollup = game.homeTeam.seasonRollup;
    const awayRollup = game.awayTeam.seasonRollup;

    if (!homeRollup || !awayRollup || homeRollup.gamesPlayed === 0 || awayRollup.gamesPlayed === 0) {
      return reply.status(400).send({ error: 'Insufficient team data for calculation' });
    }

    const homeStats = calculatePerGameAverages(homeRollup);
    const awayStats = calculatePerGameAverages(awayRollup);

    if (!homeStats || !awayStats) {
      return reply.status(400).send({ error: 'Unable to calculate team statistics' });
    }

    const nationalsData: NationalAveragesData = {
      natOff2ptmPg: nationals.natOff2ptmPg,
      natOff2ptaPg: nationals.natOff2ptaPg,
      natOff3ptmPg: nationals.natOff3ptmPg,
      natOff3ptaPg: nationals.natOff3ptaPg,
      natOffFtmPg: nationals.natOffFtmPg,
      natOffFtaPg: nationals.natOffFtaPg,
      natDef2ptmAllowedPg: nationals.natDef2ptmAllowedPg,
      natDef2ptaAllowedPg: nationals.natDef2ptaAllowedPg,
      natDef3ptmAllowedPg: nationals.natDef3ptmAllowedPg,
      natDef3ptaAllowedPg: nationals.natDef3ptaAllowedPg,
      natDefFtmAllowedPg: nationals.natDefFtmAllowedPg,
      natDefFtaAllowedPg: nationals.natDefFtaAllowedPg,
      natPointsPgPerTeam: nationals.natPointsPgPerTeam,
    };

    const breakdown = calculateGameTotal(
      homeStats,
      game.homeTeam.name,
      awayStats,
      game.awayTeam.name,
      nationalsData
    );

    return {
      gameId: game.id,
      providerGameId: game.providerGameId,
      homeTeam: game.homeTeam.name,
      awayTeam: game.awayTeam.name,
      ...breakdown,
    };
  });
}
