import { describe, it, expect } from 'vitest';
import {
  calculateDifferentials,
  calculateTeamExpected,
  calculateGameTotal,
  calculateBetProfit,
  derive2ptFromFg,
  calculatePerGameAverages,
} from '../lib/calculations.js';
import type { TeamStats, NationalAveragesData } from '../lib/types.js';

describe('NCAA Basketball Calculations', () => {
  const nationalAverages: NationalAveragesData = {
    natOff2ptmPg: 20,
    natOff2ptaPg: 40,
    natOff3ptmPg: 8,
    natOff3ptaPg: 22,
    natOffFtmPg: 14,
    natOffFtaPg: 20,
    natDef2ptmAllowedPg: 20,
    natDef2ptaAllowedPg: 40,
    natDef3ptmAllowedPg: 8,
    natDef3ptaAllowedPg: 22,
    natDefFtmAllowedPg: 14,
    natDefFtaAllowedPg: 20,
    natPointsPgPerTeam: 75,
  };

  const avgTeamStats: TeamStats = {
    off2ptm: 20,
    off2pta: 40,
    off3ptm: 8,
    off3pta: 22,
    offFtm: 14,
    offFta: 20,
    def2ptmAllowed: 20,
    def2ptaAllowed: 40,
    def3ptmAllowed: 8,
    def3ptaAllowed: 22,
    defFtmAllowed: 14,
    defFtaAllowed: 20,
  };

  describe('calculateDifferentials', () => {
    it('should return zero differentials for average team', () => {
      const diffs = calculateDifferentials(avgTeamStats, nationalAverages);
      expect(diffs.off2ptDiff).toBe(0);
      expect(diffs.off3ptDiff).toBe(0);
      expect(diffs.offFtDiff).toBe(0);
      expect(diffs.def2ptDiff).toBe(0);
      expect(diffs.def3ptDiff).toBe(0);
      expect(diffs.defFtDiff).toBe(0);
    });

    it('should calculate positive differentials for above-average team', () => {
      const aboveAvgTeam: TeamStats = {
        ...avgTeamStats,
        off2ptm: 25, // +5 from avg
        off2pta: 45, // +5 from avg
        off3ptm: 10, // +2 from avg
        off3pta: 25, // +3 from avg
      };
      const diffs = calculateDifferentials(aboveAvgTeam, nationalAverages);
      // 2PT: (25+45) - (20+40) = 70 - 60 = 10
      expect(diffs.off2ptDiff).toBe(10);
      // 3PT: (10+25) - (8+22) = 35 - 30 = 5
      expect(diffs.off3ptDiff).toBe(5);
    });

    it('should calculate negative differentials for below-average team', () => {
      const belowAvgTeam: TeamStats = {
        ...avgTeamStats,
        off2ptm: 15,
        off2pta: 35,
      };
      const diffs = calculateDifferentials(belowAvgTeam, nationalAverages);
      // 2PT: (15+35) - (20+40) = 50 - 60 = -10
      expect(diffs.off2ptDiff).toBe(-10);
    });

    it('should calculate defensive differentials correctly', () => {
      const goodDefense: TeamStats = {
        ...avgTeamStats,
        def2ptmAllowed: 15,
        def2ptaAllowed: 35,
        def3ptmAllowed: 6,
        def3ptaAllowed: 20,
      };
      const diffs = calculateDifferentials(goodDefense, nationalAverages);
      // Good defense allows less, so negative differential
      // 2PT: (15+35) - (20+40) = 50 - 60 = -10
      expect(diffs.def2ptDiff).toBe(-10);
      // 3PT: (6+20) - (8+22) = 26 - 30 = -4
      expect(diffs.def3ptDiff).toBe(-4);
    });
  });

  describe('calculateTeamExpected', () => {
    it('should return national average for two average teams', () => {
      const avgDiffs = calculateDifferentials(avgTeamStats, nationalAverages);
      const result = calculateTeamExpected(avgDiffs, avgDiffs, nationalAverages.natPointsPgPerTeam);
      expect(result.expectedPoints).toBe(75);
      expect(result.adjustments.twoPoint).toBe(0);
      expect(result.adjustments.threePoint).toBe(0);
      expect(result.adjustments.freeThrow).toBe(0);
    });

    it('should increase expected points for good offense vs bad defense', () => {
      const goodOffense = calculateDifferentials({
        ...avgTeamStats,
        off2ptm: 25,
        off2pta: 45,
        off3ptm: 10,
        off3pta: 25,
      }, nationalAverages);

      const badDefense = calculateDifferentials({
        ...avgTeamStats,
        def2ptmAllowed: 25,
        def2ptaAllowed: 45,
        def3ptmAllowed: 10,
        def3ptaAllowed: 25,
      }, nationalAverages);

      const result = calculateTeamExpected(goodOffense, badDefense, nationalAverages.natPointsPgPerTeam);
      expect(result.expectedPoints).toBeGreaterThan(75);
    });

    it('should apply correct weights: 1x for 2PT, 1.5x for 3PT, 0.5x for FT', () => {
      // Team with +10 2PT diff, +10 3PT diff, +10 FT diff
      const teamDiffs = {
        off2ptDiff: 10,
        off3ptDiff: 10,
        offFtDiff: 10,
        def2ptDiff: 0,
        def3ptDiff: 0,
        defFtDiff: 0,
      };

      // Opponent with +10 def diffs (allows more)
      const oppDiffs = {
        off2ptDiff: 0,
        off3ptDiff: 0,
        offFtDiff: 0,
        def2ptDiff: 10,
        def3ptDiff: 10,
        defFtDiff: 10,
      };

      const result = calculateTeamExpected(teamDiffs, oppDiffs, 75);

      // 2PT: avg(10, 10) = 10, weight 1x = 10
      expect(result.adjustments.twoPoint).toBe(10);
      // 3PT: avg(10, 10) = 10, weight 1.5x = 15
      expect(result.adjustments.threePoint).toBe(15);
      // FT: avg(10, 10) = 10, weight 0.5x = 5
      expect(result.adjustments.freeThrow).toBe(5);
      // Total: 75 + 10 + 15 + 5 = 105
      expect(result.expectedPoints).toBe(105);
    });
  });

  describe('calculateGameTotal', () => {
    it('should return double national average for two average teams', () => {
      const result = calculateGameTotal(
        avgTeamStats,
        'Team A',
        avgTeamStats,
        'Team B',
        nationalAverages
      );
      expect(result.expectedTotal).toBe(150); // 75 + 75
      expect(result.team1.expectedPoints).toBe(75);
      expect(result.team2.expectedPoints).toBe(75);
    });

    it('should return asymmetric expected points for different teams', () => {
      const goodTeam: TeamStats = {
        ...avgTeamStats,
        off2ptm: 25,
        off2pta: 45,
        off3ptm: 10,
        off3pta: 25,
        def2ptmAllowed: 15,
        def2ptaAllowed: 35,
      };

      const result = calculateGameTotal(
        goodTeam,
        'Good Team',
        avgTeamStats,
        'Average Team',
        nationalAverages
      );

      // Good team should score more
      expect(result.team1.expectedPoints).toBeGreaterThan(75);
      // Average team should score less against good defense
      expect(result.team2.expectedPoints).toBeLessThan(75);
    });

    it('should include team names in breakdown', () => {
      const result = calculateGameTotal(
        avgTeamStats,
        'Kansas',
        avgTeamStats,
        'Duke',
        nationalAverages
      );
      expect(result.team1.name).toBe('Kansas');
      expect(result.team2.name).toBe('Duke');
    });

    it('should include differentials in breakdown', () => {
      const result = calculateGameTotal(
        avgTeamStats,
        'Team A',
        avgTeamStats,
        'Team B',
        nationalAverages
      );
      expect(result.team1.differentials).toBeDefined();
      expect(result.team2.differentials).toBeDefined();
      expect(result.team1.differentials.off2ptDiff).toBe(0);
    });
  });

  describe('calculateBetProfit', () => {
    it('should return negative stake on loss', () => {
      expect(calculateBetProfit(100, -110, 'loss')).toBe(-100);
      expect(calculateBetProfit(50, 150, 'loss')).toBe(-50);
    });

    it('should return zero on push', () => {
      expect(calculateBetProfit(100, -110, 'push')).toBe(0);
      expect(calculateBetProfit(50, 150, 'push')).toBe(0);
    });

    it('should calculate positive odds profit correctly', () => {
      // +150 odds: $100 stake wins $150
      expect(calculateBetProfit(100, 150, 'win')).toBe(150);
      // +200 odds: $50 stake wins $100
      expect(calculateBetProfit(50, 200, 'win')).toBe(100);
    });

    it('should calculate negative odds profit correctly', () => {
      // -110 odds: $110 stake wins $100
      expect(calculateBetProfit(110, -110, 'win')).toBeCloseTo(100, 2);
      // -150 odds: $150 stake wins $100
      expect(calculateBetProfit(150, -150, 'win')).toBeCloseTo(100, 2);
      // -200 odds: $100 stake wins $50
      expect(calculateBetProfit(100, -200, 'win')).toBe(50);
    });
  });

  describe('derive2ptFromFg', () => {
    it('should correctly derive 2PT from FG and 3PT', () => {
      // FGM=30, FGA=60, 3PTM=8, 3PTA=20
      const result = derive2ptFromFg(30, 60, 8, 20);
      expect(result.twoPtm).toBe(22); // 30 - 8
      expect(result.twoPta).toBe(40); // 60 - 20
    });

    it('should handle zero 3PT attempts', () => {
      const result = derive2ptFromFg(25, 50, 0, 0);
      expect(result.twoPtm).toBe(25);
      expect(result.twoPta).toBe(50);
    });
  });

  describe('calculatePerGameAverages', () => {
    it('should return null for zero games played', () => {
      const result = calculatePerGameAverages({
        gamesPlayed: 0,
        off2ptmTotal: 0,
        off2ptaTotal: 0,
        off3ptmTotal: 0,
        off3ptaTotal: 0,
        offFtmTotal: 0,
        offFtaTotal: 0,
        def2ptmAllowedTotal: 0,
        def2ptaAllowedTotal: 0,
        def3ptmAllowedTotal: 0,
        def3ptaAllowedTotal: 0,
        defFtmAllowedTotal: 0,
        defFtaAllowedTotal: 0,
      });
      expect(result).toBeNull();
    });

    it('should calculate correct per-game averages', () => {
      const result = calculatePerGameAverages({
        gamesPlayed: 10,
        off2ptmTotal: 200,
        off2ptaTotal: 400,
        off3ptmTotal: 80,
        off3ptaTotal: 220,
        offFtmTotal: 140,
        offFtaTotal: 200,
        def2ptmAllowedTotal: 180,
        def2ptaAllowedTotal: 380,
        def3ptmAllowedTotal: 70,
        def3ptaAllowedTotal: 200,
        defFtmAllowedTotal: 130,
        defFtaAllowedTotal: 190,
      });

      expect(result).not.toBeNull();
      expect(result!.off2ptm).toBe(20);
      expect(result!.off2pta).toBe(40);
      expect(result!.off3ptm).toBe(8);
      expect(result!.off3pta).toBe(22);
      expect(result!.offFtm).toBe(14);
      expect(result!.offFta).toBe(20);
      expect(result!.def2ptmAllowed).toBe(18);
      expect(result!.def2ptaAllowed).toBe(38);
    });
  });
});
