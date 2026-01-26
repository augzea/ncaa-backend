// src/index.ts

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from 'dotenv';

import { prisma } from './lib/prisma.js';

import { gamesRoutes } from './routes/games.js';
import { teamsRoutes } from './routes/teams.js';

import { setupJobScheduler } from './scheduler.js';
import { syncSchedules, getCurrentSeason } from './jobs/schedule-sync.js';
import { processCompletedGames } from './jobs/game-processor.js';
import { buildNationalAverages } from './jobs/national-averages.js';

import { runStartupBootstrap, getBootstrapStatus } from './bootstrap.js';

// Load environment variables
config();

// ========= PROOF THIS FILE IS RUNNING =========
const VERSION_TAG = 'CLEAN BACKEND INDEX ACTIVE: 2026-01-25 RESET-DB';
console.log(`*** ${VERSION_TAG} ***`);

const fastify = Fastify({
  logger: true,
});

// Register CORS
await fastify.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
});

// Register main API routes
await fastify.register(gamesRoutes);
await fastify.register(teamsRoutes);

// ---------- Health + Version ----------
fastify.get('/health', async () => {
  return { ok: true, season: getCurrentSeason() };
});

fastify.get('/api/health', async () => {
  return { ok: true, season: getCurrentSeason() };
});

fastify.get('/api/version', async () => {
  return {
    ok: true,
    version: VERSION_TAG,
    season: getCurrentSeason(),
  };
});

// ============ Admin Endpoints ============

// Bootstrap status
fastify.get('/api/admin/bootstrap-status', async () => {
  return getBootstrapStatus();
});

/**
 * RESET DB (dangerous)
 *
 * Deletes records in a safe order:
 * TeamGameStats -> Games -> TeamSeasonRollup -> NationalAverages -> Teams
 *
 * Notes:
 * - Uses deleteMany (works even if tables are empty).
 * - Uses a transaction for consistency.
 * - You can pass ?confirm=YES to avoid accidental clicks.
 *
 * Example:
 *   GET /api/admin/reset-db?confirm=YES
 */
fastify.get('/api/admin/reset-db', async (request: any, reply: any) => {
  try {
    const confirm = String((request.query as any)?.confirm ?? '');
    if (confirm !== 'YES') {
      return reply.status(400).send({
        ok: false,
        error: 'Missing confirm=YES. This endpoint deletes your data.',
        usage: '/api/admin/reset-db?confirm=YES',
      });
    }

    const result = await prisma.$transaction(async tx => {
      const teamGameStatsDeleted = await tx.teamGameStats.deleteMany({});
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
        '1) /api/admin/sync-schedules?days=60',
        '2) /api/admin/process-completed-games',
        '3) /api/admin/build-averages',
      ],
    };
  } catch (error) {
    return reply.status(500).send({
      ok: false,
      error: 'Reset failed',
      details: String(error),
    });
  }
});

// Sync schedules (ESPN)
fastify.get('/api/admin/sync-schedules', async (request: any, reply: any) => {
  try {
    const query = request.query as { days?: string };
    const days = query.days ? parseInt(query.days, 10) : 14;

    if (isNaN(days) || days < 1 || days > 120) {
      return reply.status(400).send({ ok: false, error: 'Invalid days parameter. Must be 1-120.' });
    }

    const results = await syncSchedules(days);
    return { ok: true, days, results };
  } catch (error) {
    return reply.status(500).send({ ok: false, error: 'Schedule sync failed', details: String(error) });
  }
});

fastify.post('/api/admin/sync-schedules', async (request: any, reply: any) => {
  try {
    const query = request.query as { days?: string };
    const days = query.days ? parseInt(query.days, 10) : 14;

    if (isNaN(days) || days < 1 || days > 120) {
      return reply.status(400).send({ ok: false, error: 'Invalid days parameter. Must be 1-120.' });
    }

    const results = await syncSchedules(days);
    return { ok: true, days, results };
  } catch (error) {
    return reply.status(500).send({ ok: false, error: 'Schedule sync failed', details: String(error) });
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

// ---------- (Optional) Legacy job endpoints ----------
fastify.post('/api/admin/jobs/sync-schedules', async (_request: any, reply: any) => {
  try {
    const results = await syncSchedules(14);
    return { ok: true, results };
  } catch (error) {
    return reply.status(500).send({ ok: false, error: 'Schedule sync failed', details: String(error) });
  }
});

fastify.post('/api/admin/jobs/process-games', async (_request: any, reply: any) => {
  try {
    const results = await processCompletedGames();
    return { ok: true, results };
  } catch (error) {
    return reply.status(500).send({ ok: false, error: 'Game processing failed', details: String(error) });
  }
});

fastify.post('/api/admin/jobs/build-averages', async (_request: any, reply: any) => {
  try {
    const results = await buildNationalAverages();
    return { ok: true, results };
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
