import { describe, it, expect, beforeEach } from 'vitest';
import {
  startSession, endSession, getChangeSet, getStatus, setStatus,
  setAllPending, pendingPaths, hasPending, subscribe, statusMap,
} from '../src/changeSession.js';

const changeSet = (paths) => ({
  changes: paths.map((p) => ({ path: p, type: 'modify', oldValue: 'a', newValue: 'b' })),
  proposedChanges: Object.fromEntries(paths.map((p) => [p, 'b'])),
  getSummary: () => ({ added: 0, removed: 0, modified: paths.length, total: paths.length }),
});

beforeEach(() => endSession());

describe('changeSession', () => {
  it('starts every change pending', () => {
    startSession(changeSet(['summary', 'name']));
    expect(pendingPaths()).toEqual(['summary', 'name']);
    expect(getStatus('summary')).toBe('pending');
  });

  it('reports unknown paths as pending-by-default only inside a session', () => {
    expect(getStatus('nope')).toBe('pending');
    startSession(changeSet(['summary']));
    expect(getStatus('nope')).toBe('pending');
  });

  it('converges every surface — one status per path', () => {
    startSession(changeSet(['summary', 'name']));
    setStatus('summary', 'applied');
    expect(getStatus('summary')).toBe('applied');
    expect(pendingPaths()).toEqual(['name']);
    expect(hasPending()).toBe(true);
    setStatus('name', 'rejected');
    expect(hasPending()).toBe(false);
  });

  it('setAllPending skips already-decided paths', () => {
    startSession(changeSet(['a', 'b', 'c']));
    setStatus('b', 'rejected');
    setAllPending('applied');
    expect(getStatus('a')).toBe('applied');
    expect(getStatus('b')).toBe('rejected');
    expect(getStatus('c')).toBe('applied');
  });

  it('notifies subscribers on every transition', () => {
    const seen = [];
    const unsub = subscribe(() => seen.push(1));
    startSession(changeSet(['summary']));
    setStatus('summary', 'applied');
    endSession();
    unsub();
    expect(seen.length).toBe(3);
  });

  it('clears state on endSession', () => {
    startSession(changeSet(['summary']));
    endSession();
    expect(getChangeSet()).toBe(null);
    expect(pendingPaths()).toEqual([]);
  });
});

// Supplemental coverage for the semantics tasks 12–14 rely on but the suite
// above does not exercise: session replacement, listener isolation, no-op
// notify discipline, and the statusMap snapshot.
describe('changeSession edge semantics', () => {
  it('startSession replaces an in-flight session without leaking decisions', () => {
    const first = changeSet(['summary', 'name']);
    const second = changeSet(['summary', 'title']);
    startSession(first);
    setStatus('summary', 'applied');
    startSession(second);
    expect(getChangeSet()).toBe(second);
    expect(getStatus('summary')).toBe('pending');
    expect(pendingPaths()).toEqual(['summary', 'title']);
  });

  it('a throwing listener does not prevent later listeners from being notified', () => {
    const origError = console.error;
    console.error = () => {};
    let notified = 0;
    const unsubThrow = subscribe(() => { throw new Error('boom'); });
    const unsubCount = subscribe(() => notified++);
    try {
      startSession(changeSet(['summary']));
      expect(notified).toBe(1);
    } finally {
      // In the finally so a failed assertion cannot leak the throwing
      // listener into every later test in the file.
      unsubThrow();
      unsubCount();
      console.error = origError;
    }
  });

  it('setAllPending notifies exactly once per batch, after every path is decided', () => {
    startSession(changeSet(['a', 'b', 'c']));
    setStatus('a', 'rejected');
    // Record what a subscriber would see: each entry is one notification,
    // its value the pending count at that moment. Moving notify() inside the
    // loop would both multiply the entries and expose a half-decided set.
    const observed = [];
    const unsub = subscribe(() => observed.push(pendingPaths().length));
    try {
      setAllPending('applied');
      expect(observed).toEqual([0]);
      // Nothing left undecided — a second batch must not notify at all.
      setAllPending('applied');
      expect(observed).toEqual([0]);
    } finally {
      unsub();
    }
  });

  it('a no-op setStatus does not notify — one notification per real transition', () => {
    startSession(changeSet(['summary']));
    setStatus('summary', 'applied');
    let notified = 0;
    const unsub = subscribe(() => notified++);
    setStatus('summary', 'applied');
    expect(notified).toBe(0);
    setStatus('summary', 'rejected');
    expect(notified).toBe(1);
    unsub();
  });

  it('statusMap returns a snapshot decoupled from internal state', () => {
    startSession(changeSet(['summary', 'name']));
    setStatus('summary', 'applied');
    const snapshot = statusMap();
    expect(snapshot.get('summary')).toBe('applied');
    expect(snapshot.has('name')).toBe(false);
    snapshot.set('name', 'rejected');
    expect(getStatus('name')).toBe('pending');
  });
});
