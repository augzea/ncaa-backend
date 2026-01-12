import { prisma } from './lib/prisma.js';
import { syncSchedules } from './jobs/schedule-sync.js';
import { League } from '@prisma/client';

export interface BootstrapStatus {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  isRunning: boolean;
  runCount: number;
  results: {
    mens: LeagueResult;
    womens: LeagueResult;
  } | null;
}

interface LeagueResult {
  teamsInserted: number;
  teamsUpdated: number;
  gamesInserted: number;
  gamesUpdated: number;
}

// In-memory status tracking
let bootstrapStatus: BootstrapStatus = {
  lastRunAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  isRunning: false,
  runCount: 0,
  results: null,
};

/**
 * Get current bootstrap status
 */
export function getBootstrapStatus(): BootstrapStatus {
  return { ...bootstrapStatus };
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run bootstrap with retries
 */
async function runBootstrapWithRetries(maxRetries: number = 3, delayMs: number = 5000): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Bootstrap] Attempt ${attempt}/${maxRetries}...`);

      // Get counts before sync
      const beforeCounts = await getCounts();

      // Run schedule sync for both leagues
      await syncSchedules();

      // Get counts after sync
      const afterCounts = await getCounts();

      // Calculate deltas
      const results = {
        mens: {
          teamsInserted: Math.max(0, afterCounts.mensTeams - beforeCounts.mensTeams),
          teamsUpdated: Math.min(beforeCounts.mensTeams, afterCounts.mensTeams),
          gamesInserted: Math.max(0, afterCounts.mensGames - beforeCounts.mensGames),
          gamesUpdated: Math.min(beforeCounts.mensGames, afterCounts.mensGames),
        },
        womens: {
          teamsInserted: Math.max(0, afterCounts.womensTeams - beforeCounts.womensTeams),
          teamsUpdated: Math.min(beforeCounts.womensTeams, afterCounts.womensTeams),
          gamesInserted: Math.max(0, afterCounts.womensGames - beforeCounts.womensGames),
          gamesUpdated: Math.min(beforeCounts.womensGames, afterCounts.womensGames),
        },
      };

      // Log results
      console.log('[Bootstrap] Sync completed successfully');
      console.log(`[Bootstrap] MENS: ${results.mens.teamsInserted} teams inserted, ${results.mens.teamsUpdated} updated`);
      console.log(`[Bootstrap] MENS: ${results.mens.gamesInserted} games inserted, ${results.mens.gamesUpdated} updated`);
      console.log(`[Bootstrap] WOMENS: ${results.womens.teamsInserted} teams inserted, ${results.womens.teamsUpdated} updated`);
      console.log(`[Bootstrap] WOMENS: ${results.womens.gamesInserted} games inserted, ${results.womens.gamesUpdated} updated`);
      console.log(`[Bootstrap] Total: ${afterCounts.mensTeams + afterCounts.womensTeams} teams, ${afterCounts.mensGames + afterCounts.womensGames} games in DB`);

      // Update status
      bootstrapStatus.lastSuccessAt = new Date().toISOString();
      bootstrapStatus.results = results;
      bootstrapStatus.lastError = null;

      return; // Success!
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`[Bootstrap] Attempt ${attempt} failed:`, lastError.message);

      if (attempt < maxRetries) {
        console.log(`[Bootstrap] Retrying in ${delayMs / 1000} seconds...`);
        await sleep(delayMs);
        delayMs *= 2; // Exponential backoff
      }
    }
  }

  // All retries failed
  bootstrapStatus.lastErrorAt = new Date().toISOString();
  bootstrapStatus.lastError = lastError?.message || 'Unknown error';
  console.error(`[Bootstrap] All ${maxRetries} attempts failed. Last error: ${lastError?.message}`);
}

/**
 * Get current counts from database
 */
async function getCounts(): Promise<{
  mensTeams: number;
  womensTeams: number;
  mensGames: number;
  womensGames: number;
}> {
  const [mensTeams, womensTeams, mensGames, womensGames] = await Promise.all([
    prisma.team.count({ where: { league: League.MENS } }),
    prisma.team.count({ where: { league: League.WOMENS } }),
    prisma.game.count({ where: { league: League.MENS } }),
    prisma.game.count({ where: { league: League.WOMENS } }),
  ]);

  return { mensTeams, womensTeams, mensGames, womensGames };
}

/**
 * Run initial bootstrap on server startup (non-blocking)
 */
export function runStartupBootstrap(): void {
  // Don't block server startup - run async
  setImmediate(async () => {
    // Small delay to ensure server is fully ready
    await sleep(2000);

    console.log('[Bootstrap] Starting initial schedule sync...');
    bootstrapStatus.isRunning = true;
    bootstrapStatus.lastRunAt = new Date().toISOString();
    bootstrapStatus.runCount++;

    try {
      await runBootstrapWithRetries(3, 5000);
    } finally {
      bootstrapStatus.isRunning = false;
    }
  });
}
