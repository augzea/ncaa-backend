import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { calculateGameTotal, calculatePerGameAverages } from '../lib/calculations.js';
import { LeagueSchema, SeasonSchema } from '../lib/types.js';
import type { NationalAveragesData } from '../lib/types.js';

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in format YYYY-MM-DD');

// IMPORTANT:
// These helpers interpret YYYY-MM-DD as a *local* date (Railway TZ should be America/New_York).
function startOfLocalDay(dateStr: string): Date {
  // No "Z" => parsed as local time
  return new Date(`${dateStr}T00:00:00`);
}

function startOfNextLocalDay(dateStr: string): Date {
  const d = startOfLocalDay(dateStr);
  d.setDate(d.getDate() + 1);
  return d;
}

function startOfLocalDayFromDate(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export async function gamesRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/:league/:season/games
   * Optional query:
   *   ?date=YYYY-MM-DD   (interpreted as America/New_York day if TZ is set)
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

    let range: { gte: Date; lt: Date } | undefined;
    if (date) {
      const dateResult = DateSchema.safeParse(date);
      if (!dateResult.success) {
        return reply.status(400).send({ error: 'Invalid date format. Must be YYYY-MM-DD' });
      }

      // Local day boundaries (ET if TZ=America/New_York)
      const gte = startOfLocalDay(date);
      const lt = startOfNextLocalDay(date);
      range = { gte, lt };
    }

    const games = await prisma.game.findMany({
      where: {
        league: leagueResult.data,
        season: seasonResult.data,
        ...(range && {
          dateTime: range,
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
   * Optional:
   *   ?start=YYYY-MM-DD   (interpreted as local date; defaults to "today" local)
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

    let startDate: Date;
    if (start) {
      const startResult = DateSchema.safeParse(start);
      if (!startResult.success) {
        return reply.status(400).send({ error: 'Invalid start date format. Must be YYYY-MM-DD' });
      }
      startDate = startOfLocalDay(start);
    } else {
      // local "today"
      startDate = startOfLocalDayFromDate(new Date());
    }

    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 7);

    const games = await prisma.game.findMany({
      where: {
        league: leagueResult.data,
        season: seasonResult.data,
        dateTime: {
          gte: startDate,
          lt: endDate,
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
