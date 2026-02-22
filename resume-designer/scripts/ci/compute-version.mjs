import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.resolve(__dirname, '../../package.json');

function run(command) {
  try {
    return execSync(command, { encoding: 'utf8' }).trim();
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

  const latestTag =
    run("git tag -l 'v*' --sort=-v:refname | head -n 1") || '';
  const taggedVersion = latestTag.replace(/^v/, '');
  const baseVersion = parseVersion(taggedVersion)
    ? taggedVersion
    : fallbackVersion;

  const range = latestTag ? `${latestTag}..HEAD` : 'HEAD';
  const commitLog = run(`git log ${range} --pretty=format:%s%n%b%n---END---`);
  const bumpType = detectBumpType(commitLog);
  const version = bumpVersion(baseVersion, bumpType);

  process.stdout.write(`version=${version}\n`);
  process.stdout.write(`tag=v${version}\n`);
  process.stdout.write(`previous_tag=${latestTag}\n`);
  process.stdout.write(`bump=${bumpType}\n`);
}

main();
