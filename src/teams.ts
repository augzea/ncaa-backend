import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { calculateDifferentials, calculatePerGameAverages } from '../lib/calculations.js';
import { LeagueSchema, SeasonSchema } from '../lib/types.js';
import type { NationalAveragesData } from '../lib/types.js';

export async function teamsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/:league/:season/teams
   * Get all teams for a league/season
   */
  fastify.get<{
    Params: { league: string; season: string };
    Querystring: { search?: string };
  }>('/api/:league/:season/teams', async (request, reply) => {
    const { league, season } = request.params;
    const { search } = request.query;

    const leagueResult = LeagueSchema.safeParse(league.toUpperCase());
    if (!leagueResult.success) {
      return reply.status(400).send({ error: 'Invalid league' });
    }

    const seasonResult = SeasonSchema.safeParse(season);
    if (!seasonResult.success) {
      return reply.status(400).send({ error: 'Invalid season format' });
    }

    const teams = await prisma.team.findMany({
      where: {
        league: leagueResult.data,
        season: seasonResult.data,
        ...(search && {
          name: {
            contains: search,
            mode: 'insensitive',
          },
        }),
      },
      include: {
        seasonRollup: true,
      },
      orderBy: { name: 'asc' },
    });

    return teams.map(team => ({
      id: team.id,
      name: team.name,
      providerTeamId: team.providerTeamId,
      conference: team.conference,
      gamesPlayed: team.seasonRollup?.gamesPlayed ?? 0,
    }));
  });

  /**
   * GET /api/:league/:season/teams/:teamId
   * Get detailed team stats with differentials
   */
  fastify.get<{
    Params: { league: string; season: string; teamId: string };
  }>('/api/:league/:season/teams/:teamId', async (request, reply) => {
    const { league, season, teamId } = request.params;

    const leagueResult = LeagueSchema.safeParse(league.toUpperCase());
    if (!leagueResult.success) {
      return reply.status(400).send({ error: 'Invalid league' });
    }

    const seasonResult = SeasonSchema.safeParse(season);
    if (!seasonResult.success) {
      return reply.status(400).send({ error: 'Invalid season format' });
    }

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: {
        seasonRollup: true,
      },
    });

    if (!team) {
      return reply.status(404).send({ error: 'Team not found' });
    }

    // Get national averages for differential calculation
    const nationals = await prisma.nationalAverages.findUnique({
      where: {
        league_season: {
          league: leagueResult.data,
          season: seasonResult.data,
        },
      },
    });

    const rollup = team.seasonRollup;
    if (!rollup || rollup.gamesPlayed === 0) {
      return {
        id: team.id,
        name: team.name,
        providerTeamId: team.providerTeamId,
        conference: team.conference,
        gamesPlayed: 0,
        stats: null,
        differentials: null,
      };
    }

    const perGameStats = calculatePerGameAverages(rollup);

    let differentials = null;
    if (perGameStats && nationals) {
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
      differentials = calculateDifferentials(perGameStats, nationalsData);
    }

    return {
      id: team.id,
      name: team.name,
      providerTeamId: team.providerTeamId,
      conference: team.conference,
      gamesPlayed: rollup.gamesPlayed,
      stats: perGameStats
        ? {
            offense: {
              twoPtMade: perGameStats.off2ptm,
              twoPtAtt: perGameStats.off2pta,
              threePtMade: perGameStats.off3ptm,
              threePtAtt: perGameStats.off3pta,
              ftMade: perGameStats.offFtm,
              ftAtt: perGameStats.offFta,
            },
            defense: {
              twoPtAllowed: perGameStats.def2ptmAllowed,
              twoPtAttAllowed: perGameStats.def2ptaAllowed,
              threePtAllowed: perGameStats.def3ptmAllowed,
              threePtAttAllowed: perGameStats.def3ptaAllowed,
              ftAllowed: perGameStats.defFtmAllowed,
              ftAttAllowed: perGameStats.defFtaAllowed,
            },
          }
        : null,
      differentials,
    };
  });

  /**
   * GET /api/:league/:season/national-averages
   * Get national averages for a league/season
   */
  fastify.get<{
    Params: { league: string; season: string };
  }>('/api/:league/:season/national-averages', async (request, reply) => {
    const { league, season } = request.params;

    const leagueResult = LeagueSchema.safeParse(league.toUpperCase());
    if (!leagueResult.success) {
      return reply.status(400).send({ error: 'Invalid league' });
    }

    const seasonResult = SeasonSchema.safeParse(season);
    if (!seasonResult.success) {
      return reply.status(400).send({ error: 'Invalid season format' });
    }

    const nationals = await prisma.nationalAverages.findUnique({
      where: {
        league_season: {
          league: leagueResult.data,
          season: seasonResult.data,
        },
      },
    });

    if (!nationals) {
      return reply.status(404).send({ error: 'National averages not found' });
    }

    return {
      league: nationals.league,
      season: nationals.season,
      offense: {
        twoPtMade: nationals.natOff2ptmPg,
        twoPtAtt: nationals.natOff2ptaPg,
        threePtMade: nationals.natOff3ptmPg,
        threePtAtt: nationals.natOff3ptaPg,
        ftMade: nationals.natOffFtmPg,
        ftAtt: nationals.natOffFtaPg,
      },
      defense: {
        twoPtAllowed: nationals.natDef2ptmAllowedPg,
        twoPtAttAllowed: nationals.natDef2ptaAllowedPg,
        threePtAllowed: nationals.natDef3ptmAllowedPg,
        threePtAttAllowed: nationals.natDef3ptaAllowedPg,
        ftAllowed: nationals.natDefFtmAllowedPg,
        ftAttAllowed: nationals.natDefFtaAllowedPg,
      },
      pointsPerTeamPerGame: nationals.natPointsPgPerTeam,
      updatedAt: nationals.updatedAt.toISOString(),
    };
  });
}
