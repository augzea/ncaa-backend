import cron from 'node-cron';
import { syncSchedules } from './jobs/schedule-sync.js';
import { processCompletedGames } from './jobs/game-processor.js';
import { buildNationalAverages } from './jobs/national-averages.js';

export function setupJobScheduler(): void {
  const scheduleSyncCron = process.env.SCHEDULE_SYNC_CRON || '0 */3 * * *';
  const gameProcessorCron = process.env.GAME_PROCESSOR_CRON || '*/30 * * * *';
  const nationalAveragesCron = process.env.NATIONAL_AVERAGES_CRON || '0 4 * * *';

  console.log('[Scheduler] Setting up job schedules:');
  console.log(`  - Schedule sync: ${scheduleSyncCron}`);
  console.log(`  - Game processor: ${gameProcessorCron}`);
  console.log(`  - National averages: ${nationalAveragesCron}`);

  // Job A: Schedule sync (every 3 hours by default)
  cron.schedule(scheduleSyncCron, async () => {
    console.log('[Scheduler] Running schedule sync job...');
    try {
      await syncSchedules();
    } catch (error) {
      console.error('[Scheduler] Schedule sync failed:', error);
    }
  });

  // Job B: Game processor (every 30 minutes by default)
  cron.schedule(gameProcessorCron, async () => {
    console.log('[Scheduler] Running game processor job...');
    try {
      await processCompletedGames();
    } catch (error) {
      console.error('[Scheduler] Game processor failed:', error);
    }
  });

  // Job C: National averages builder (daily at 4 AM by default)
  cron.schedule(nationalAveragesCron, async () => {
    console.log('[Scheduler] Running national averages job...');
    try {
      await buildNationalAverages();
    } catch (error) {
      console.error('[Scheduler] National averages build failed:', error);
    }
  });

  console.log('[Scheduler] All jobs scheduled');
}

// Export job functions for manual execution
export { syncSchedules, processCompletedGames, buildNationalAverages };
