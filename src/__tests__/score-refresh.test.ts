import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ESPNClient, getESPNClient, type ESPNEventData } from '../lib/espn.js';
import { syncSchedules, syncSchedulesRange } from '../jobs/schedule-sync.js';
import { processCompletedGames } from '../jobs/game-processor.js';
import { prisma } from '../lib/prisma.js';

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    team: { findUnique: vi.fn(), upsert: vi.fn().mockResolvedValue({ id: 'team' }) },
    teamSeasonRollup: { upsert: vi.fn() },
    game: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    teamGameStats: { upsert: vi.fn(), aggregate: vi.fn().mockResolvedValue({ _count: 1, _sum: {} }) },
  },
}));

beforeEach(() => {
  vi.mocked(prisma.team.upsert).mockResolvedValue({ id: "team" } as never);
  vi.mocked(prisma.teamGameStats.aggregate).mockResolvedValue({ _count: 1, _sum: {} } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const status = { name: 'STATUS_FINAL', state: 'post', completed: true };
const summaryHome = { id: '1', homeAway: 'home', score: '76' } as const;
const summaryAway = { id: '2', homeAway: 'away', score: '81' } as const;
const team = (id: string, score: number | undefined) => ({
  id, name: id, displayName: id, shortDisplayName: id, abbreviation: id, conference: null, score,
});

function fixture(id: string, home: number | undefined, away: number | undefined): ESPNEventData {
  return {
    id, date: '2026-11-21T02:00:00Z', completed: true, statusState: 'post',
    statusName: 'STATUS_FINAL', neutralSite: false, home: team('1', home), away: team('2', away),
  };
}

describe('scoreboard refresh', () => {
  it('revisits three Eastern dates plus today and keeps the requested future window, for both leagues', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T02:00:00Z')); // Friday, Nov 20 in ET
    const scoreboard = vi.spyOn(getESPNClient(), 'getScoreboard').mockResolvedValue([]);

    const result = await syncSchedules(2);

    expect(result).toMatchObject({ startDate: '2026-11-17', endDate: '2026-11-21', days: 5 });
    const dates = ['20261117', '20261118', '20261119', '20261120', '20261121'];
    for (const league of ['MENS', 'WOMENS']) {
      expect(scoreboard.mock.calls.filter(([key]) => key === league).map(([, date]) => date)).toEqual(dates);
    }
  });

  it('parses explicit 0 but rejects missing, non-numeric, and truncated scores', async () => {
    const events = [0, '', 'N/A', '12pts', undefined, '42'].map((score, i) => ({
      id: String(i), date: '2026-11-21T02:00:00Z', competitions: [{
        status: { type: status }, competitors: [{ ...summaryHome, score }, summaryAway],
      }],
    }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events })));

    const result = await new ESPNClient().getScoreboard('MENS', '20261120');

    expect(result.map(event => event.home.score)).toEqual([0, undefined, undefined, undefined, undefined, 42]);
  });

  it('repairs processed finals and writes status without clobbering scores when ESPN lacks a complete result', async () => {
    const day = new Date('2026-11-20T00:00:00Z');
    vi.spyOn(getESPNClient(), 'getScoreboard').mockResolvedValue([
      fixture('repair', 76, 81), fixture('partial', 78, undefined), fixture('placeholder', 0, 0), fixture('live-to-final', 78, undefined),
      { ...fixture('scheduled', 0, 0), statusState: 'pre', statusName: 'STATUS_SCHEDULED', completed: false },
      { ...fixture('live', 0, 2), statusState: 'in', statusName: 'STATUS_IN_PROGRESS', completed: false },
    ]);
    vi.mocked(prisma.game.findUnique).mockImplementation(({ where }) => Promise.resolve({
      homeScore: 42, awayScore: 39, statsProcessed: true,
      status: where.league_season_providerGameId?.providerGameId === 'live-to-final' ? 'IN_PROGRESS' : 'FINAL',
    }) as never);

    const result = await syncSchedulesRange({ start: day, end: day, season: '2026-27' });

    expect(result.mens.gamesUpdated).toBe(6);
    expect(result.womens.gamesUpdated).toBe(6);
    for (const league of ['MENS', 'WOMENS']) {
      const calls = vi.mocked(prisma.game.upsert).mock.calls.map(([input]) => input)
        .filter(input => input.where.league_season_providerGameId?.league === league);
      expect(calls[0].update).toMatchObject({ status: 'FINAL', homeScore: 76, awayScore: 81 });
      expect(calls[0].update).not.toHaveProperty('statsProcessed');
      for (const i of [1, 2, 4]) {
        expect(calls[i].update.status).toBe(i === 4 ? 'SCHEDULED' : 'FINAL');
        for (const data of [calls[i].create, calls[i].update]) {
          expect(data).not.toHaveProperty('homeScore');
          expect(data).not.toHaveProperty('awayScore');
        }
      }
