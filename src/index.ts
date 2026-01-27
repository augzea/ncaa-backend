import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from 'dotenv';

import { gamesRoutes } from './routes/games.js';
import { teamsRoutes } from './routes/teams.js';

import { setupJobScheduler } from './scheduler.js';
import { syncSchedules } from './jobs/schedule-sync.js';
import { processCompletedGames } from './jobs/game-processor.js';
import { buildNationalAverages } from './jobs/national-averages.js';

import { runStartupBootstrap, getBootstrapStatus } from './bootstrap.js';
import { prisma } from './lib/prisma.js';
import { getCurrentSeason } from './jobs/schedule-sync.js';

config();

console.log('*** CLEAN BACKEND INDEX ACTIVE: 2026-01-26 ***');

const fastify = Fastify({ logger: true });

await fastify.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
});

// Main API routes (define /api/:league/:season/...)
await fastify.register(gamesRoutes);
await fastify.register(teamsRoutes);

// -------------------- Health + Version --------------------
fastify.get('/health', async () => ({ ok: true, season: getCurrentSeason() }));
fastify.get('/api/health', async () => ({ ok: true, season: getCurrentSeason() }));

fastify.get('/api/version', async () => ({
  ok: true,
  version: 'CLEAN BACKEND INDEX ACTIVE: 2026-01-26',
  season: getCurrentSeason(),
}));

// -------------------- Admin: Bootstrap status --------------------
fastify.get('/api/admin/bootstrap-status', async () => getBootstrapStatus());

// -------------------- Admin: Reset DB (FIXED FK ORDER) --------------------
fastify.get('/api/admin/reset-db', async (request, reply) => {
  const confirm = (request.query as any)?.confirm;

  if (confirm !== 'YES') {
    return reply.status(400).send({
      ok: false,
      error: 'Missing confirm=YES',
      example: '/api/admin/reset-db?confirm=YES',
    });
  }

  try {
    const result = await prisma.$transaction(async tx => {
      // IMPORTANT: delete child tables first, then parents

      const teamGameStatsDeleted = await tx.teamGameStats.deleteMany({});

      // If you ever add other tables that reference games/teams, delete them here first.

      const gamesDeleted = await tx.game.deleteMany({});

      const rollupsDeleted = await tx.teamSeasonRollup.deleteMany({});

      const nationalsDeleted = await tx.nationalAverages.deleteMany({});

      const teamsDeleted = await tx.team.deleteMany({});

      return {
        teamGameStatsDeleted: teamGameStatsDeleted.count,
        gamesDeleted: gamesDeleted.count,
        rollupsDeleted: rollupsDeleted.count,
        nationalsDeleted: nationalsDeleted.count,
        teamsDeleted: teamsDeleted.count,
      };
    });

    return {
      ok: true,
      message: 'Database reset complete',
      result,
      nextSteps: [
        '1) /api/admin/sync-season?season=2025-26  (or /api/admin/sync-schedules?days=60)',
        '2) /api/admin/process-completed-games',
        '3) /api/admin/build-averages',
      ],
    };
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({
      ok: false,
      error: 'Database reset failed',
      details: String(err),
      tip: 'This is usually a FK constraint order issue. If you added new tables, ensure they are deleted before games/teams.',
    });
  }
});

// -------------------- Admin: small window sync --------------------
fastify.get('/api/admin/sync-schedules', async (request, reply) => {
  try {
    const days = Number((request.query as any)?.days ?? 14);
    if (!Number.isFinite(days) || days < 1 || days > 120) {
      return reply.status(400).send({ ok: false, error: 'days must be 1..120' });
    }
    const results = await syncSchedules(days);
    return { ok: true, days, results };
  } catch (err) {
    return reply.status(500).send({ ok: false, error: 'sync-schedules failed', details: String(err) });
  }
});

// -------------------- Admin: process completed games --------------------
fastify.get('/api/admin/process-completed-games', async (_request, reply) => {
  try {
    const results = await processCompletedGames();
    return { ok: true, results };
  } catch (err) {
    return reply.status(500).send({ ok: false, error: 'process-completed-games failed', details: String(err) });
  }
});

// -------------------- Admin: build averages --------------------
fastify.get('/api/admin/build-averages', async (_request, reply) => {
  try {
    const results = await buildNationalAverages();
    return { ok: true, season: getCurrentSeason(), results };
  } catch (err) {
    return reply.status(500).send({ ok: false, error: 'build-averages failed', details: String(err) });
  }
});

// -------------------- Start server --------------------
const port = parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '0.0.0.0';

try {
  setupJobScheduler();
  await fastify.listen({ port, host });
  fastify.log.info(`Server listening at http://${host}:${port}`);

  runStartupBootstrap();
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
