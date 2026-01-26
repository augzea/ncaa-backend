console.log("🔥 BACKEND SYNC TEST 🔥");

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from 'dotenv';

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
console.log('*** CLEAN BACKEND INDEX ACTIVE: 2026-01-25 A ***');

const fastify = Fastify({
  logger: true,
});

// Register CORS
await fastify.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
});

// ------------------ ROUTES ------------------

// Register API routes
await fastify.register(gamesRoutes);
await fastify.register(teamsRoutes);

// ------------------ SYSTEM ------------------

// Health (API version)
fastify.get('/api/health', async () => {
  return { ok: true, season: getCurrentSeason() };
});

// Version proof
fastify.get('/api/version', async () => {
  return {
    ok: true,
    version: 'CLEAN BACKEND INDEX ACTIVE: 2026-01-25 A',
    season: getCurrentSeason(),
  };
});

// ------------------ ADMIN ------------------

// Bootstrap status
fastify.get('/api/admin/bootstrap-status', async () => {
  return getBootstrapStatus();
});

// Sync schedules (ESPN)
fastify.get('/api/admin/sync-schedules', async (request: any, reply: any) => {
  try {
    const query = request.query as { days?: string };
    const days = query.days ? parseInt(query.days, 10) : 14;

    if (isNaN(days) || days < 1 || days > 60) {
      return reply.status(400).send({ error: 'Invalid days parameter. Must be 1-60.' });
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

    if (isNaN(days) || days < 1 || days > 60) {
      return reply.status(400).send({ error: 'Invalid days parameter. Must be 1-60.' });
    }

    const results = await syncSchedules(days);
    return { ok: true, days, results };
  } catch (error) {
    return reply.status(500).send({ ok: false, error: 'Schedule sync failed', details: String(error) });
  }
});

// Process completed games
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

// ------------------ DEBUG ------------------

fastify.ready(() => {
  console.log('\n=== REGISTERED ROUTES ===');
  fastify.printRoutes();
});

// ------------------ START ------------------

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
