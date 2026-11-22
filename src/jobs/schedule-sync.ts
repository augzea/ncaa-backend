import { prisma } from '../lib/prisma.js';
import { getESPNClient, type ESPNEventData } from '../lib/espn.js';
import type { League } from '../lib/types.js';
import { League as PrismaLeague, GameStatus } from '@prisma/client';

/**
 * Sync results for a single league
 */
export interface LeagueSyncResult {
  teamsInserted: number;
  teamsUpdated: number;
  gamesInserted: number;
  gamesUpdated: number;
  errors: string[];
}

/**
 * Full sync results
 */
export interface SyncSchedulesResult {
  startDate: string;
  endDate: string;
  days: number;
  mens: LeagueSyncResult;
  womens: LeagueSyncResult;
  totalErrors: string[];
}

/**
 * Format date as YYYYMMDD for ESPN API
 */
function formatDateYYYYMMDD(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Get the current NCAA basketball season string (e.g., "2025-26")
 */
export function getCurrentSeason(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  // NCAA season typically spans Nov-Apr
  if (month >= 10) {
    return `${year}-${String(year + 1).slice(2)}`;
  }
  if (month <= 4) {
    return `${year - 1}-${String(year).slice(2)}`;
  }
  // Off-season: default to upcoming season
  return `${year}-${String(year + 1).slice(2)}`;
}

/**
 * Default range for a given season string "YYYY-YY"
 * (Nov 1 -> Apr 15)
 */
export function getDefaultSeasonDateRange(season: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(season);
  if (!m) {
    const cur = getCurrentSeason();
    return getDefaultSeasonDateRange(cur);
  }

  const startYear = Number(m[1]);
  const endYear = startYear + 1;

  const start = new Date(Date.UTC(startYear, 10, 1)); // Nov 1
  const end = new Date(Date.UTC(endYear, 3, 15));     // Apr 15
  return { start, end };
}

/**
 * Map ESPN game status to our status enum
 * IMPORTANT: handle POSTPONED/CANCELLED before "completed"
 */
function mapGameStatus(event: ESPNEventData): GameStatus {
  const statusName = (event.statusName || '').toUpperCase();

  if (statusName.includes('POSTPON')) return 'POSTPONED';
  if (statusName.includes('CANCEL')) return 'CANCELLED';

  // ESPN state hints
  switch (event.statusState) {
    case 'post':
      return 'FINAL';
    case 'in':
      return 'IN_PROGRESS';
    case 'pre':
      return 'SCHEDULED';
  }
