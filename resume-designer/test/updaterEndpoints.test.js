import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The updater endpoint exists in two places that must not drift:
//
//   - src-tauri/src/commands/updater.rs  — AUTHORITATIVE. Compiled into every
//     shipped binary; this is where installed apps actually look.
//   - src-tauri/tauri.conf.json          — inert at runtime, but it's the
//     greppable one, so it's what a renamer will find first.
//
// Without this test, updating only the config produces a green build that
// changes nothing about where users check for updates (and updating only the
// Rust constants, without actually moving the release, 404s every install).
// See "Where the endpoint actually lives" in TAURI.md.

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const updaterRs = read('../src-tauri/src/commands/updater.rs');
const tauriConf = JSON.parse(read('../src-tauri/tauri.conf.json'));

function rustConst(name) {
  const m = updaterRs.match(new RegExp(`const ${name}: &str =\\s*"([^"]+)"`));
  if (!m) throw new Error(`could not find ${name} in updater.rs`);
  return m[1];
}

const STABLE_ENDPOINT = rustConst('STABLE_ENDPOINT');
const BETA_ENDPOINT = rustConst('BETA_ENDPOINT');

// github.com/<owner>/<repo>/releases/...
const slugOf = (url) => url.match(/github\.com\/([^/]+\/[^/]+)\//)?.[1] ?? null;

describe('updater endpoints', () => {
  it('resolves both Rust constants', () => {
    expect(STABLE_ENDPOINT).toMatch(/^https:\/\//);
    expect(BETA_ENDPOINT).toMatch(/^https:\/\//);
    expect(STABLE_ENDPOINT).not.toBe(BETA_ENDPOINT);
  });

  it('points both channels at the same repo', () => {
    // A half-finished rename shows up here first.
    expect(slugOf(BETA_ENDPOINT)).toBe(slugOf(STABLE_ENDPOINT));
    expect(slugOf(STABLE_ENDPOINT)).not.toBeNull();
  });

  it('keeps tauri.conf.json from drifting away from the Rust constants', () => {
    const configured = tauriConf.plugins?.updater?.endpoints ?? [];
    expect(configured.length).toBeGreaterThan(0);
    // release.yml rewrites the config endpoint to the beta URL for beta builds,
    // so accept either constant — but nothing else.
    for (const endpoint of configured) {
      expect([STABLE_ENDPOINT, BETA_ENDPOINT]).toContain(endpoint);
    }
  });

  it('reads the stable channel from /releases/latest and beta from the next tag', () => {
    // GitHub excludes prereleases from /releases/latest, which is the whole
    // reason stable users never see beta builds.
    expect(STABLE_ENDPOINT).toContain('/releases/latest/download/latest.json');
    expect(BETA_ENDPOINT).toContain('/releases/download/next/latest.json');
  });
});
