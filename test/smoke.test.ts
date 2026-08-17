import { describe, expect, it } from 'vitest';

/**
 * Placeholder for the scaffold commit: proves the harness actually runs, and
 * records the vertical slices still to be built as pending todos.
 *
 * `it.todo` is deliberate. A genuinely failing assertion here would land CI red
 * on the first commit, which trains everyone to ignore a red build — the exact
 * habit that makes a tool used six times a year rot between sessions.
 */
describe('scaffold', () => {
  it('runs the test harness', () => {
    expect(true).toBe(true);
  });

  it.todo('storage: migrations apply, WAL and foreign_keys pragmas verified');
  it.todo('domain: sender identity resolution (ADR-005)');
  it.todo('domain: decision log and suppression projection (ADR-006)');
  it.todo('detection: tiers 1-4 against .eml fixtures');
  it.todo('sync: resumable, idempotent, UIDVALIDITY-aware');
  it.todo('unsubscribe execution: one-click, link, mailto');
});
