import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.resolve(__dirname, '../../package.json');

// execFileSync (no shell) instead of exec/execSync: arguments are passed as an
// array, so a maliciously-named git tag can never be interpreted as a command.
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function bumpVersion(version, bumpType) {
  const parsed = parseVersion(version);
  if (!parsed) {
    throw new Error(`Invalid semantic version: ${version}`);
  }

  if (bumpType === 'major') {
    return `${parsed.major + 1}.0.0`;
  }
  if (bumpType === 'minor') {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

// Semver precedence, enough of it for the shapes this pipeline emits
// (`X.Y.Z` and `X.Y.Z-next.N`). Returns -1 / 0 / 1.
//
// Written out rather than pulled from a dependency because this script runs in
// CI with only Node builtins, and because the one comparison that matters here
// — 1.16.0-next.125 vs 2.0.0-next.116 — is exactly the one a naive string or
// build-number comparison gets wrong.
export function compareSemver(a, b) {
  const split = (v) => {
    const [core, pre = ''] = String(v).replace(/^v/, '').split('-', 2);
    return {
      nums: core.split('.').map((n) => Number(n) || 0),
      pre: pre ? pre.split('.') : [],
    };
  };
  const x = split(a);
  const y = split(b);

  for (let i = 0; i < 3; i += 1) {
    if ((x.nums[i] || 0) !== (y.nums[i] || 0)) return (x.nums[i] || 0) > (y.nums[i] || 0) ? 1 : -1;
  }
  // A version WITHOUT a prerelease outranks one with: 2.0.0 > 2.0.0-next.9.
  if (!x.pre.length && y.pre.length) return 1;
  if (x.pre.length && !y.pre.length) return -1;

  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;   // shorter set is lower when all else equal
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    // Numeric identifiers compare numerically and always rank below alphanumeric.
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) > Number(q) ? 1 : -1; continue; }
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

/**
 * Why publishing `computed` would be a regression against what is already
 * live, or null when it is safe.
 *
 * This exists because the pipeline shipped NINE beta builds that no user could
 * install. A manual dispatch had published 2.0.0-next.116; every automatic run
 * afterwards derived its base from the latest `v*` tag (still v1.15.0) and
 * published 1.16.0-next.N — a DOWNGRADE, which the updater correctly refused.
 * Every job was green each time, because nothing in the pipeline knew what the
 * previous run had published.
 *
 * An unreadable `published` is NOT treated as a regression. Being unable to
 * compare is not evidence of one, and blocking every release on a transient
 * GitHub outage is worse than the rare miss — the caller warns instead.
 */
export function regressionReason(computed, published) {
  if (!published) return null;
  const cmp = compareSemver(computed, published);
  if (cmp > 0) return null;
  return cmp === 0
    ? `computed version ${computed} is ALREADY published — the update would be a no-op`
    : `computed version ${computed} is LOWER than the published ${published} — `
      + 'publishing it would be a downgrade, which the updater refuses, so the '
      + 'release would succeed and reach nobody';
}

function detectBumpType(logText) {
  const text = (logText || '').toLowerCase();

  const hasBreaking =
    /breaking change/i.test(logText) ||
    /^\w+(\(.+\))?!:/m.test(logText);
  if (hasBreaking) return 'major';

  const hasFeature = /^feat(\(.+\))?:/m.test(text);
  if (hasFeature) return 'minor';

  return 'patch';
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const fallbackVersion = pkg.version;

  // First line of the version-sorted v* tag list = the latest stable tag.
  const allTags = git(['tag', '-l', 'v*', '--sort=-v:refname']);
  const latestTag = allTags ? allTags.split('\n')[0].trim() : '';
  const taggedVersion = latestTag.replace(/^v/, '');
  const baseVersion = parseVersion(taggedVersion)
    ? taggedVersion
    : fallbackVersion;

  const range = latestTag ? `${latestTag}..HEAD` : 'HEAD';
  const commitLog = git(['log', range, '--pretty=format:%s%n%b%n---END---']);
  const bumpType = detectBumpType(commitLog);
  const computed = bumpVersion(baseVersion, bumpType);

  // RELEASE_CHANNEL=next produces a pre-release version on the rolling `next`
  // tag; anything else is a stable, version-tagged release.
  const channel = process.env.RELEASE_CHANNEL === 'next' ? 'next' : 'stable';
  // RELEASE_VERSION_OVERRIDE (from the workflow_dispatch input) is a deterministic
  // escape hatch: for stable it IS the version, for next it's the base.
  const override = (process.env.RELEASE_VERSION_OVERRIDE || '').trim();

  let version;
  let tag;
  if (channel === 'next') {
    const base = override || computed;
    const runNumber = process.env.GITHUB_RUN_NUMBER || '0';
    version = `${base}-next.${runNumber}`;
    tag = 'next';
  } else {
    version = override || computed;
    tag = `v${version}`;
  }

  // THE GUARD. `PUBLISHED_VERSION` is what is live on this channel right now,
  // fetched by the workflow. Failing here is deliberate: a downgrade published
  // successfully is worse than a red run, because it reaches nobody and says
  // nothing — which is how nine builds went out unnoticed.
  const published = (process.env.PUBLISHED_VERSION || '').trim();
  const reason = regressionReason(version, published);
  if (reason) {
    process.stderr.write(`::error::Refusing to publish: ${reason}.\n`);
    process.stderr.write(
      '::error::Fix the BASE version, not this check. Either tag the stable '
      + 'release so the base derives from it, or re-run with the '
      + '`version` input set to the intended base.\n',
    );
    process.exit(1);
  }
  if (!published) {
    process.stderr.write(
      '::warning::No published version to compare against — the regression '
      + 'guard did not run. Being unable to read it is not evidence of a '
      + 'regression, so the release proceeds.\n',
    );
  }

  process.stdout.write(`version=${version}\n`);
  process.stdout.write(`tag=${tag}\n`);
  process.stdout.write(`channel=${channel}\n`);
  process.stdout.write(`previous_tag=${latestTag}\n`);
  process.stdout.write(`bump=${bumpType}\n`);
}

// Guarded so the exported helpers above can be imported by tests without this
// script computing a version (and calling process.exit) as a side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
