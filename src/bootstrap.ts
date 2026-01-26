import { syncSchedules } from './jobs/schedule-sync.js';

export interface BootstrapStatus {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  isRunning: boolean;
  runCount: number;
}

let bootstrapStatus: BootstrapStatus = {
  lastRunAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  isRunning: false,
  runCount: 0,
};

export function getBootstrapStatus(): BootstrapStatus {
  return { ...bootstrapStatus };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runBootstrapWithRetries(maxRetries: number = 3): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Bootstrap] Attempt ${attempt}/${maxRetries}...`);
      await syncSchedules(7); // small window so startup is quick
      bootstrapStatus.lastSuccessAt = new Date().toISOString();
      bootstrapStatus.lastError = null;
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[Bootstrap] Attempt ${attempt} failed: ${lastError.message}`);

      if (attempt < maxRetries) {
        const delay = 2000 * attempt;
        console.log(`[Bootstrap] Retrying in ${delay / 1000}s...`);
        await sleep(delay);
      }
    }
  }

  bootstrapStatus.lastErrorAt = new Date().toISOString();
  bootstrapStatus.lastError = lastError?.message || 'Unknown error';
  console.error(`[Bootstrap] All attempts failed: ${bootstrapStatus.lastError}`);
}

export function runStartupBootstrap(): void {
  setImmediate(async () => {
    await sleep(1500);

    console.log('[Bootstrap] Starting initial schedule sync...');
    bootstrapStatus.isRunning = true;
    bootstrapStatus.lastRunAt = new Date().toISOString();
    bootstrapStatus.runCount++;

    try {
      await runBootstrapWithRetries(3);
    } finally {
      bootstrapStatus.isRunning = false;
    }
  });
}
