import { describe, it, expect } from 'vitest';
import { compareSemver, regressionReason } from '../scripts/ci/compute-version.mjs';

// The pipeline shipped NINE beta builds that no user could install. A manual
// dispatch published 2.0.0-next.116; every automatic run afterwards derived its
// base from the latest `v*` tag (still v1.15.0) and published 1.16.0-next.N.
// The updater correctly refused the downgrade, so the builds reached nobody —
// and every job was green each time, because nothing in the pipeline knew what
// the previous run had published.

describe('compareSemver', () => {
  // THE case. A build-number comparison says 125 > 116 and ships a downgrade;
  // a string comparison says "1" < "2" by luck rather than by rule.
  it('ranks by core version before build number', () => {
    expect(compareSemver('1.16.0-next.125', '2.0.0-next.116')).toBe(-1);
    expect(compareSemver('2.0.0-next.116', '1.16.0-next.125')).toBe(1);
  });

  it('compares build numbers NUMERICALLY, not as strings', () => {
    // The trap: '9' > '116' lexically.
    expect(compareSemver('2.0.0-next.116', '2.0.0-next.9')).toBe(1);
    expect(compareSemver('2.0.0-next.9', '2.0.0-next.116')).toBe(-1);
  });

  it('ranks a release above its own prereleases', () => {
    expect(compareSemver('2.0.0', '2.0.0-next.999')).toBe(1);
    expect(compareSemver('2.0.0-next.999', '2.0.0')).toBe(-1);
  });

  it('treats identical versions as equal', () => {
    expect(compareSemver('1.16.0-next.125', '1.16.0-next.125')).toBe(0);
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0);
  });

  it('tolerates a leading v and uneven core lengths', () => {
    expect(compareSemver('v2.0.0', '2.0.0')).toBe(0);
    expect(compareSemver('2.1', '2.0.9')).toBe(1);
  });

  it('orders each core field independently', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
    expect(compareSemver('1.3.0', '1.2.99')).toBe(1);
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
  });
});

describe('regressionReason', () => {
  it('blocks the exact failure that shipped nine invisible builds', () => {
    const why = regressionReason('1.16.0-next.125', '2.0.0-next.116');
    expect(why).toMatch(/LOWER/);
    expect(why).toMatch(/reach nobody/);
  });

  it('blocks republishing the same version', () => {
    expect(regressionReason('2.0.0-next.116', '2.0.0-next.116')).toMatch(/ALREADY published/);
  });

  it('allows a genuine advance', () => {
    expect(regressionReason('2.0.0-next.126', '2.0.0-next.116')).toBeNull();
    expect(regressionReason('2.0.1', '2.0.0')).toBeNull();
    // A stable release supersedes the prerelease line it came from.
    expect(regressionReason('2.0.0', '2.0.0-next.126')).toBeNull();
  });

  // Being unable to READ the published version is not evidence of a regression.
  // The same rule the credential work turned on: a failed read is never an
  // established absence. Blocking every release on a transient GitHub outage
  // would be worse than the rare miss, so the caller warns instead.
  it('does not block when there is nothing to compare against', () => {
    expect(regressionReason('1.0.0-next.1', '')).toBeNull();
    expect(regressionReason('1.0.0-next.1', undefined)).toBeNull();
    expect(regressionReason('1.0.0-next.1', null)).toBeNull();
  });
});
