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
import { getCurrentSeason } from './jobs/schedule-sync.js';

// Load environment variables
config();

const fastify = Fastify({
  logger: true,
});

// Register CORS
await fastify.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
});

// Register routes
await fastify.register(gamesRoutes);
await fastify.register(teamsRoutes);

// Health check endpoint
fastify.get('/health', async () => {
  return { ok: true, season: getCurrentSeason() };
});

// ============ Admin Endpoints ============

// Sync schedules from ESPN
fastify.post('/api/admin/sync-schedules', async (request: any, reply: any) => {
  try {
    const query = request.query as { days?: string };
    const days = query.days ? parseInt(query.days, 10) : 14;

    if (isNaN(days) || days < 1 || days > 60) {
      return reply.status(400).send({ error: 'Invalid days parameter. Must be 1-60.' });
    }

    const results = await syncSchedules(days);
    return {
      success: true,
      message: 'Schedule sync completed',
      ...results,
    };
  } catch (error) {
    return reply.status(500).send({ error: 'Schedule sync failed', details: String(error) });
  }
});

// Process completed games (stats ingestion)
fastify.post('/api/admin/process-completed-games', async (_request: any, reply: any) => {
  try {
    const results = await processCompletedGames();
    return {
      success: true,
      message: 'Game processing completed',
      ...results,
    };
  } catch (error) {
    return reply.status(500).send({ error: 'Game processing failed', details: String(error) });
  }
});

// Build national averages
fastify.post('/api/admin/build-averages', async (_request: any, reply: any) => {
  try {
    const results = await buildNationalAverages();
    return {
      success: true,
      message: 'National averages build completed',
      season: getCurrentSeason(),
      ...results,
    };
  } catch (error) {
    return reply.status(500).send({ error: 'National averages build failed', details: String(error) });
  }
});

// Bootstrap status endpoint
fastify.get('/api/admin/bootstrap-status', async () => {
  return getBootstrapStatus();
});

// Legacy endpoints for backwards compatibility
fastify.post('/api/admin/jobs/sync-schedules', async (_request: any, reply: any) => {
  try {
    const results = await syncSchedules(14);
    return { success: true, message: 'Schedule sync completed', ...results };
  } catch (error) {
    return reply.status(500).send({ error: 'Schedule sync failed', details: String(error) });
  }
});

fastify.post('/api/admin/jobs/process-games', async (_request: any, reply: any) => {
  try {
    const results = await processCompletedGames();
    return { success: true, message: 'Game processor completed', ...results };
  } catch (error) {
    return reply.status(500).send({ error: 'Game processor failed', details: String(error) });
  }
});

fastify.post('/api/admin/jobs/build-averages', async (_request: any, reply: any) => {
  try {
    const results = await buildNationalAverages();
    return { success: true, message: 'National averages build completed', ...results };
  } catch (error) {
    return reply.status(500).send({ error: 'National averages build failed', details: String(error) });
  }
});

// Start server
const port = parseInt(process.env.PORT || '3001', 10);
const host = process.env.HOST || '0.0.0.0';

try {
  // Set up job scheduler
  setupJobScheduler();

  // Start the server
  await fastify.listen({ port, host });
  console.log(`Server running at http://${host}:${port}`);

  // Run initial bootstrap (non-blocking)
  runStartupBootstrap();
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
