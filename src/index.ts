import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from 'dotenv';

import { gamesRoutes } from './routes/games.js';
import { teamsRoutes } from './routes/teams.js';

import { setupJobScheduler } from './scheduler.js';
import { syncSchedules, syncSeasonBothLeagues, getCurrentSeason } from './jobs/schedule-sync.js';
import { processCompletedGames } from './jobs/game-processor.js';
import { buildNationalAverages } from './jobs/national-averages.js';

import { runStartupBootstrap, getBootstrapStatus } from './bootstrap.js';
import { prisma } from './lib/prisma.js';

config();

console.log('*** CLEAN BACKEND INDEX ACTIVE: 2026-01-26 (SYNC-SEASON) ***');

const fastify = Fastify({ logger: true });

await fastify.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
});

// Register main API routes
await fastify.register(gamesRoutes);
await fastify.register(teamsRoutes);

// ---------- Health + Version ----------
fastify.get('/health', async () => ({ ok: true, season: getCurrentSeason() }));
fastify.get('/api/health', async () => ({ ok: true, season: getCurrentSeason() }));

fastify.get('/api/version', async () => ({
  ok: true,
  version: 'CLEAN BACKEND INDEX ACTIVE: 2026-01-26 (SYNC-SEASON)',
  season: getCurrentSeason(),
}));

// ============ Admin Endpoints ============

// Bootstrap status
fastify.get('/api/admin/bootstrap-status', async () => getBootstrapStatus());

/**
 * Reset DB (DANGEROUS): deletes all rows from game/team/stats/rollups/nationals
 * Call: /api/admin/reset-db?confirm=YES
 */
fastify.get('/api/admin/reset-db', async (request: any, reply: any) => {
  const confirm = String((request.query as any)?.confirm ?? '');
  if (confirm !== 'YES') {
    return reply.status(400).send({
      ok: false,
      error: 'Missing confirm=YES',
      example: '/api/admin/reset-db?confirm=YES',
    });
  }

  const [teamGameStatsDeleted, gamesDeleted, rollupsDeleted, nationalsDeleted, teamsDeleted] =
    await prisma.$transaction([
      prisma.teamGameStats.deleteMany({}),
      prisma.game.deleteMany({}),
      prisma.teamSeasonRollup.deleteMany({}),
      prisma.nationalAverages.deleteMany({}),
      prisma.team.deleteMany({}),
    ]);

  return {
    ok: true,
    message: 'Database reset complete',
    result: {
      teamGameStatsDeleted: teamGameStatsDeleted.count,
      gamesDeleted: gamesDeleted.count,
      rollupsDeleted: rollupsDeleted.count,
      nationalsDeleted: nationalsDeleted.count,
      teamsDeleted: teamsDeleted.count,
    },
    nextSteps: [
      '1) /api/admin/sync-season?season=2025-26',
      '2) /api/admin/process-completed-games',
      '3) /api/admin/build-averages',
    ],
  };
});

/**
 * Sync schedules for next N days (both leagues via your syncSchedules(days) helper)
 * Call: /api/admin/sync-schedules?days=14
 */
fastify.get('/api/admin/sync-schedules', async (request: any, reply: any) => {
  try {
    const days = Number((request.query as any)?.days ?? 14);
    if (!Number.isFinite(days) || days < 1 || days > 120) {
      return reply.status(400).send({ ok: false, error: 'Invalid days. Must be 1-120.' });
    }
    const results = await syncSchedules(days);
    return { ok: true, days, results };
  } catch (error) {
    return reply.status(500).send({ ok: false, error: 'Schedule sync failed', details: String(error) });
  }
});

fastify.post('/api/admin/sync-schedules', async (request: any, reply: any) => {
  try {
    const days = Number((request.query as any)?.days ?? 14);
    if (!Number.isFinite(days) || days < 1 || days > 120) {
      return reply.status(400).send({ ok: false, error: 'Invalid days. Must be 1-120.' });
    }
    const results = await syncSchedules(days);
    return { ok: true, days, results };
  } catch (error) {
    return reply.status(500).send({ ok: false, error: 'Schedule sync failed', details: String(error) });
  }
});

/**
 * NEW: Sync FULL SEASON for BOTH leagues (Division I via ESPN groups=50)
 *
 * Call (recommended):
 *   /api/admin/sync-season?season=2025-26
 *
 * Optional overrides:
 *   /api/admin/sync-season?season=2025-26&start=2025-11-01&end=2026-04-15
 */
fastify.get('/api/admin/sync-season', async (request: any, reply: any) => {
  try {
    const season = String((request.query as any)?.season ?? getCurrentSeason());
    const start = (request.query as any)?.start ? String((request.query as any)?.start) : undefined;
    const end = (request.query as any)?.end ? String((request.query as any)?.end) : undefined;

    const results = await syncSeasonBothLeagues(season, start, end);
    return { ok: true, season, start: results.startDate, end: results.endDate, results };
  } catch (error) {
    return reply.status(500).send({ ok: false, error: 'Season sync failed', details: String(error) });
  }
});

fastify.post('/api/admin/sync-season', async (request: any, reply: any) => {
  try {
    const season = String((request.query as any)?.season ?? getCurrentSeason());
    const start = (request.query as any)?.start ? String((request.query as any)?.start) : undefined;
    const end = (request.query as any)?.end ? String((request.query as any)?.end) : undefined;

    const results = await syncSeasonBothLeagues(season, start, end);
    return { ok: true, season, start: results.startDate, end: results.endDate, results };
  } catch (error) {
    return reply.status(500).send({ ok: false, error: 'Season sync failed', details: String(error) });
  }
});

// Process completed games (stats ingestion)
fastify.get('/api/admin/process-completed-games', async (_request: any, reply: any) => {
  try {
    const results = await processCompletedGames();
    return { ok: true, results };
  } catch (error) {
    return reply.status(500).send({ ok: false, error: 'Game processing failed', details: String(error) });
  }
});

fastify.post('/api/admin/process-completed-games', async (_request: any, reply: any) => {
  try {
    const results = await processCompletedGames();
    return { ok: true, results };
  } catch (error) {
    return reply.status(500).send({ ok: false, error: 'Game processing failed', details: String(error) });
  }
});

// Build national averages
fastify.get('/api/admin/build-averages', async (_request: any, reply: any) => {
  try {
    const results = await buildNationalAverages();
    return { ok: true, season: getCurrentSeason(), results };
  } catch (error) {
    return reply.status(500).send({ ok: false, error: 'National averages build failed', details: String(error) });
  }
});

fastify.post('/api/admin/build-averages', async (_request: any, reply: any) => {
  try {
    const results = await buildNationalAverages();
    return { ok: true, season: getCurrentSeason(), results };
  } catch (error) {
    return reply.status(500).send({ ok: false, error: 'National averages build failed', details: String(error) });
  }
});

// Start server
const port = parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '0.0.0.0';

try {
  // Start scheduler (cron jobs)
  setupJobScheduler();

  // Start server
  await fastify.listen({ port, host });
  fastify.log.info(`Server listening at http://${host}:${port}`);

  // Run initial bootstrap (non-blocking)
  runStartupBootstrap();
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
