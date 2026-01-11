import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from 'dotenv';
import { gamesRoutes } from './routes/games.js';
import { teamsRoutes } from './routes/teams.js';
import { setupJobScheduler, syncSchedules, processCompletedGames, buildNationalAverages } from './scheduler.js';

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
  return { ok: true };
});

// Manual job trigger endpoints (for admin/testing)
fastify.post('/api/admin/jobs/sync-schedules', async (_request, reply) => {
  try {
    await syncSchedules();
    return { success: true, message: 'Schedule sync completed' };
  } catch (error) {
    return reply.status(500).send({ error: 'Schedule sync failed', details: String(error) });
  }
});

fastify.post('/api/admin/jobs/process-games', async (_request, reply) => {
  try {
    await processCompletedGames();
    return { success: true, message: 'Game processor completed' };
  } catch (error) {
    return reply.status(500).send({ error: 'Game processor failed', details: String(error) });
  }
});

fastify.post('/api/admin/jobs/build-averages', async (_request, reply) => {
  try {
    await buildNationalAverages();
    return { success: true, message: 'National averages build completed' };
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
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
