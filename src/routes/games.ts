import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { calculateGameTotal, calculatePerGameAverages } from '../lib/calculations.js';
import { LeagueSchema, SeasonSchema } from '../lib/types.js';
import type { NationalAveragesData } from '../lib/types.js';

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in format YYYY-MM-DD');

// Format a Date into YYYY-MM-DD in America/New_York (ET)
const fmtET = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function toLocalDateET(d: Date): string {
  // en-CA with those options returns YYYY-MM-DD
  return fmtET.format(d);
}

export async function gamesRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/:league/:season/games
   * Get games for a specific date (optional query param date=YYYY-MM-DD)
   */
  fastify.get<{
    Params: { league: string; season: string };
    Querystring: { date?: string };
  }>('/api/:league/:season/games', async (request, reply) => {
    const { league, season } = request.params;
    const { date } = request.query;

    // Validate params
    const leagueResult = LeagueSchema.safeParse(league.toUpperCase());
    if (!leagueResult.success) {
      return reply.status(400).send({ error: 'Invalid league. Must be MENS or WOMENS' });
    }

    const seasonResult = SeasonSchema.safeParse(season);
    if (!seasonResult.success) {
      return reply.status(400).send({ error: 'Invalid season format. Must be YYYY-YY' });
    }

    let dateFilter: Date | undefined;
    if (date) {
      const dateResult = DateSchema.safeParse(date);
      if (!dateResult.success) {
        return reply.status(400).send({ error: 'Invalid date format. Must be YYYY-MM-DD' });
      }
      // Interpret date as midnight UTC boundary like before
      // (your DB stores DateTime in UTC; this filter is a UTC day filter)
      dateFilter = new Date(date);
    }

    const games = await prisma.game.findMany({
      where: {
        league: leagueResult.data,
        season: seasonResult.data,
        ...(dateFilter && {
          dateTime: {
            gte: dateFilter,
            lt: new Date(dateFilter.getTime() + 24 * 60 * 60 * 1000),
          },
        }),
      },
      include: {
        homeTeam: true,
        awayTeam: true,
      },
      orderBy: { dateTime: 'asc' },
    });

    return games.map(game => {
      const localDate = toLocalDateET(game.dateTime);

      return {
        id: game.id,
        providerGameId: game.providerGameId,
        dateTime: game.dateTime.toISOString(),
        localDate, // ✅ NEW: correct ET day label
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
      };
    });
  });

  /**
   * GET /api/:league/:season/games/week
   * Get games for a week starting from a date (optional query param start=YYYY-MM-DD)
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

    // If provided, validate YYYY-MM-DD
    if (start) {
      const startResult = DateSchema.safeParse(start);
      if (!startResult.success) {
        return reply.status(400).send({ error: 'Invalid start format. Must be YYYY-MM-DD' });
      }
    }

    // Keep your original logic: start at midnight local runtime time,
    // but store/compare as Date objects (UTC-backed).
    const startDate = start ? new Date(start) : new Date();
    startDate.setHours(0, 0, 0, 0);

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

    return games.map(game => {
      const localDate = toLocalDateET(game.dateTime);

      return {
        id: game.id,
        providerGameId: game.providerGameId,
        dateTime: game.dateTime.toISOString(),
        localDate, // ✅ NEW
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
      };
    });
  });

  /**
   * GET /api/:league/:season/games/:gameId/expected
   * Get expected total calculation for a game
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

    // Get the game
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: {
        homeTeam: {
          include: { seasonRollup: true },
        },
        awayTeam: {
          include: { seasonRollup: true },
        },
      },
    });

    if (!game) {
      return reply.status(404).send({ error: 'Game not found' });
    }

    // Get national averages
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

    // Convert rollups to per-game stats
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
