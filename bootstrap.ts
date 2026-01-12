import { syncSchedules, type SyncSchedulesResult } from './jobs/schedule-sync.js';

export interface BootstrapStatus {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  isRunning: boolean;
  runCount: number;
  results: SyncSchedulesResult | null;
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

      // Run schedule sync for both leagues (14 days)
      const results = await syncSchedules(14);

      // Log results
      console.log('[Bootstrap] Sync completed successfully');
      console.log(`[Bootstrap] Date range: ${results.startDate} to ${results.endDate}`);
      console.log(`[Bootstrap] MENS: ${results.mens.teamsInserted} teams inserted, ${results.mens.teamsUpdated} updated`);
      console.log(`[Bootstrap] MENS: ${results.mens.gamesInserted} games inserted, ${results.mens.gamesUpdated} updated`);
      console.log(`[Bootstrap] WOMENS: ${results.womens.teamsInserted} teams inserted, ${results.womens.teamsUpdated} updated`);
      console.log(`[Bootstrap] WOMENS: ${results.womens.gamesInserted} games inserted, ${results.womens.gamesUpdated} updated`);

      if (results.totalErrors.length > 0) {
        console.log(`[Bootstrap] Errors: ${results.totalErrors.length}`);
      }

      // Update status
      bootstrapStatus.lastSuccessAt = new Date().toISOString();
      bootstrapStatus.results = results;
      bootstrapStatus.lastError = results.totalErrors.length > 0 ? results.totalErrors.join('; ') : null;

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
 * Run initial bootstrap on server startup (non-blocking)
 */
export function runStartupBootstrap(): void {
  // Don't block server startup - run async
  setImmediate(async () => {
    // Small delay to ensure server is fully ready
    await sleep(2000);

    console.log('[Bootstrap] Starting initial ESPN schedule sync...');
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
