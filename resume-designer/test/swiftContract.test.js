import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildDesign, buildOnboarding, buildDocumentOutline,
  buildHistory, buildLibrary, buildChatView, buildSettings, buildDiffReview,
} from '../src/iosShell.js';
import { buildJobs } from '../src/jobsBridge.js';

/**
 * The Swift decoder's required fields must all be emitted by the JS builder.
 *
 * `OPShell.receive` decodes with `try? JSONDecoder().decode(ShellSnapshot.self)`
 * and drops the snapshot WHOLE when it fails. A single missing non-optional
 * field therefore does not degrade one control — it silently stops the entire
 * native UI updating, which reads as a spinner that never resolves and chrome
 * that quietly goes stale.
 *
 * That shipped three times on this branch: `JobsView.revision`,
 * `OnboardingView.keySaves`, and `Design.saveFailed` — the last one broke every
 * design tab on device, because the struct named the field and the projection
 * never emitted it. Nothing caught any of them: the field lives in Swift, the
 * emitter lives in JS, and no test read both.
 *
 * Top-level fields only. Nested types would need a real Swift parser; the drift
 * that has actually happened has all been at the top level, where a new field is
 * added to the struct and the builder is forgotten.
 */
const SWIFT_SOURCES = ['OPShell.swift', 'OPJobs.swift', 'OPProfile.swift', 'OPOnboarding.swift']
  .map((f) => fs.readFileSync(path.join(process.cwd(), 'src-tauri/ios', f), 'utf8'))
  .join('\n');

/** The `var`/`let` fields declared directly inside `name`'s braces. */
function requiredFields(name) {
  const start = SWIFT_SOURCES.indexOf(`struct ${name}: Decodable`);
  expect(start, `Swift struct ${name} not found`).toBeGreaterThan(-1);
  let depth = 0;
  let i = SWIFT_SOURCES.indexOf('{', start);
  const open = i;
  for (; i < SWIFT_SOURCES.length; i += 1) {
    if (SWIFT_SOURCES[i] === '{') depth += 1;
    else if (SWIFT_SOURCES[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  const body = SWIFT_SOURCES.slice(open, i);
  // Only this struct's OWN fields: nested types are indented deeper.
  const indent = name === 'JobsView' || name === 'ProfileView' || name === 'OnboardingView' ? '  ' : '    ';
  const re = new RegExp(`^${indent}(?:var|let) (\\w+):\\s*([^\\n=]+)$`, 'gm');
  const out = [];
  for (const m of body.matchAll(re)) {
    const type = m[2].trim();
    if (!type.endsWith('?')) out.push(m[1]);   // optionals may legitimately be absent
  }
  return out;
}

/**
 * Fields the PUBLISH SITE adds on top of the builder, by spreading its result:
 * `project('document', () => ({ ...deps.getDocument(), saveFailed, revision }))`.
 * They are legitimately absent from the builder, so they are named here rather
 * than reported as drift.
 *
 * Keep this in step with `publish()` in src/iosShell.js. A field listed here
 * that the publish site stops adding is drift this test will NOT catch — but a
 * field in neither place, which is what has actually shipped every time, still
 * fails loudly.
 */
const SUPPLIED_AT_PUBLISH = {
  DocumentOutline: ['saveFailed', 'revision'],
  ChatView: ['saveFailed', 'pendingChanges'],
};

const CONTRACTS = [
  ['Design', () => buildDesign({})],
  ['JobsView', () => buildJobs({})],
  ['OnboardingView', () => buildOnboarding({})],
  ['DocumentOutline', () => buildDocumentOutline({})],
  ['History', () => buildHistory([])],
  ['LibraryView', () => buildLibrary([], {}, [])],
  ['ChatView', () => buildChatView({})],
  ['Settings', () => buildSettings({})],
  ['DiffReview', () => buildDiffReview({})],
];

describe('every Swift decoder field is emitted by its JS builder', () => {
  it.each(CONTRACTS)('%s', (name, build) => {
    const emitted = new Set([...Object.keys(build()), ...(SUPPLIED_AT_PUBLISH[name] ?? [])]);
    const missing = requiredFields(name).filter((f) => !emitted.has(f));
    expect(missing, `${name}: Swift requires these but the builder emits none of them`).toEqual([]);
  });
});
