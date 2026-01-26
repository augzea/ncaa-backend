import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from 'dotenv';

import { gamesRoutes } from './routes/games.js';
import { teamsRoutes } from './routes/teams.js';

import { setupJobScheduler } from './scheduler.js';
import {
  syncSchedules,
  syncSchedulesRange,
  getCurrentSeason,
  getDefaultSeasonDateRange,
} from './jobs/schedule-sync.js';

import { processCompletedGames } from './jobs/game-processor.js';
import { buildNationalAverages } from './jobs/national-averages.js';
import { runStartupBootstrap, getBootstrapStatus } from './bootstrap.js';
import { prisma } from './lib/prisma.js';

config();

console.log('*** CLEAN BACKEND INDEX ACTIVE: 2026-01-26 B ***');

const fastify = Fastify({ logger: true });

await fastify.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
});

// Main API routes
await fastify.register(gamesRoutes);
await fastify.register(teamsRoutes);

// -------------------- Health + Version --------------------
fastify.get('/health', async () => ({ ok: true, season: getCurrentSeason() }));
fastify.get('/api/health', async () => ({ ok: true, season: getCurrentSeason() }));

fastify.get('/api/version', async () => ({
  ok: true,
  version: 'CLEAN BACKEND INDEX ACTIVE: 2026-01-26 B',
  season: getCurrentSeason(),
}));

// -------------------- Admin: Bootstrap status --------------------
fastify.get('/api/admin/bootstrap-status', async () => getBootstrapStatus());

// -------------------- Admin: Reset DB --------------------
fastify.get('/api/admin/reset-db', async (request, reply) => {
  const confirm = (request.query as any)?.confirm;

  if (confirm !== 'YES') {
    return reply.status(400).send({
      ok: false,
      error: 'Missing confirm=YES',
      example: '/api/admin/reset-db?confirm=YES',
    });
  }

  const teamGameStatsDeleted = await prisma.teamGameStats.deleteMany({});
  const gamesDeleted = await prisma.game.deleteMany({});
  const rollupsDeleted = await prisma.teamSeasonRollup.deleteMany({});
  const nationalsDeleted = await prisma.nationalAverages.deleteMany({});
  const teamsDeleted = await prisma.team.deleteMany({});

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

// -------------------- Admin: Small-window schedule sync --------------------
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

// -------------------- Admin: FULL SEASON sync (BOTH leagues) --------------------
type SeasonSyncStatus = {
  isRunning: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  lastResult: any | null;
};

let seasonSyncStatus: SeasonSyncStatus = {
  isRunning: false,
  startedAt: null,
  finishedAt: null,
  lastError: null,
  lastResult: null,
};

fastify.get('/api/admin/sync-season-status', async () => seasonSyncStatus);

fastify.get('/api/admin/sync-season', async (request, reply) => {
  const q = request.query as any;
  const season = String(q?.season ?? getCurrentSeason());

  let start: Date;
  let end: Date;

  if (q?.start && q?.end) {
    start = new Date(`${q.start}T00:00:00.000Z`);
    end = new Date(`${q.end}T00:00:00.000Z`);
  } else {
    const def = getDefaultSeasonDateRange(season);
    start = def.start;
    end = def.end;
  }

  if (seasonSyncStatus.isRunning) {
    return reply.status(409).send({
      ok: false,
      error: 'sync-season already running',
      status: seasonSyncStatus,
    });
  }

  seasonSyncStatus = {
    isRunning: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastError: null,
    lastResult: null,
  };

  setImmediate(async () => {
    try {
      console.log(
        `[Admin] sync-season starting for ${season} (${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)})`
      );
      const res = await syncSchedulesRange({ start, end, season });
      seasonSyncStatus.lastResult = res;
      seasonSyncStatus.finishedAt = new Date().toISOString();
      console.log('[Admin] sync-season finished');
    } catch (err) {
      seasonSyncStatus.lastError = String(err);
      seasonSyncStatus.finishedAt = new Date().toISOString();
      console.error('[Admin] sync-season failed:', err);
    } finally {
      seasonSyncStatus.isRunning = false;
    }
  });

  return {
    ok: true,
    message: 'sync-season started in background',
    season,
    range: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
    statusEndpoint: '/api/admin/sync-season-status',
  };
});

// -------------------- Admin: Game processing --------------------
fastify.get('/api/admin/process-completed-games', async (_request, reply) => {
  try {
    const results = await processCompletedGames();
    return { ok: true, results };
  } catch (err) {
    return reply.status(500).send({ ok: false, error: 'process-completed-games failed', details: String(err) });
  }
});

// -------------------- Admin: Build averages --------------------
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
