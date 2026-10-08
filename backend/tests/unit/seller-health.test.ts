/**
 * The seller health rating: Amazon's 0-1,000 scale and bands, with the caps
 * that make the band name the worst open issue.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SIGNALS,
  bandOf,
  compareHealth,
  healthIssues,
  inspectionRecord,
  rateSellerHealth,
  type HealthSignals,
} from '../../src/domain/seller-health.js';

const signals = (overrides: Partial<HealthSignals> = {}): HealthSignals => ({ ...EMPTY_SIGNALS, ...overrides });

describe('bands', () => {
  it('uses Amazon thresholds', () => {
    expect(bandOf(1000)).toBe('HEALTHY');
    expect(bandOf(200)).toBe('HEALTHY');
    expect(bandOf(199)).toBe('AT_RISK');
    expect(bandOf(100)).toBe('AT_RISK');
    expect(bandOf(99)).toBe('UNHEALTHY');
    expect(bandOf(0)).toBe('UNHEALTHY');
  });
});

describe('rateSellerHealth', () => {
  it('gives a clean seller the full score', () => {
    const health = rateSellerHealth(signals());
    expect(health).toMatchObject({ score: 1000, band: 'HEALTHY', issues: [] });
  });

  it('takes points off by severity', () => {
    expect(rateSellerHealth(signals({ documentsExpiring: 2 })).score).toBe(900);
    expect(rateSellerHealth(signals({ minorNcrsOpen: 3 })).score).toBe(970);
  });

  it('holds any critical issue at UNHEALTHY however high the arithmetic', () => {
    const health = rateSellerHealth(signals({ criticalNcrsOpen: 1 }));
    expect(health.score).toBe(99);
    expect(health.band).toBe('UNHEALTHY');
  });

  it('holds any high issue at AT_RISK', () => {
    const health = rateSellerHealth(signals({ documentsExpired: 1 }));
    expect(health.score).toBe(199);
    expect(health.band).toBe('AT_RISK');
  });

  it('never goes below zero', () => {
    expect(rateSellerHealth(signals({ criticalNcrsOpen: 10, lotsHeld: 10 })).score).toBe(0);
  });

  it('lists issues worst first and folds both kinds of changes-requested together', () => {
    const issues = healthIssues(signals({ minorNcrsOpen: 1, casesSuspended: 1, casesChangesRequested: 1, documentsChangesRequested: 2 }));
    expect(issues.map((issue) => issue.kind)).toEqual(['CASE_SUSPENDED', 'MINOR_NCR_OPEN', 'CHANGES_REQUESTED']);
    expect(issues[2]?.count).toBe(3);
  });
});

describe('inspection record', () => {
  it('does not judge a seller on fewer than three reports', () => {
    expect(inspectionRecord(signals({ reportsFailed: 2 })).meetsTarget).toBeNull();
    expect(healthIssues(signals({ reportsFailed: 2 }))).toEqual([]);
  });

  it('counts inconclusive as not passed, since it holds the goods too', () => {
    const record = inspectionRecord(signals({ reportsPassed: 8, reportsFailed: 1, reportsInconclusive: 1 }));
    expect(record).toMatchObject({ reports: 10, notPassed: 2, passRatePercent: 80, meetsTarget: false });
  });

  it('accepts a failure rate exactly on the 10% target', () => {
    expect(inspectionRecord(signals({ reportsPassed: 9, reportsFailed: 1 })).meetsTarget).toBe(true);
  });

  it('raises a HIGH issue above the target', () => {
    const health = rateSellerHealth(signals({ reportsPassed: 2, reportsFailed: 2 }));
    expect(health.issues).toEqual([{ kind: 'INSPECTION_FAILURE_RATE', severity: 'HIGH', count: 1 }]);
    expect(health.band).toBe('AT_RISK');
  });
});

describe('compareHealth', () => {
  it('sorts the riskiest seller first', () => {
    const list = [rateSellerHealth(signals()), rateSellerHealth(signals({ criticalNcrsOpen: 1 })), rateSellerHealth(signals({ documentsExpired: 1 }))];
    expect(list.sort(compareHealth).map((health) => health.band)).toEqual(['UNHEALTHY', 'AT_RISK', 'HEALTHY']);
  });
});
