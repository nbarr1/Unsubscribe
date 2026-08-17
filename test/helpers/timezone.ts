/**
 * Run a block with a specific local timezone.
 *
 * ADR-006 requires holds to be computed on the *user's* calendar, so the tests
 * have to be able to be somewhere other than UTC. Node re-reads `process.env['TZ']`
 * for each `Date` operation, so setting it here is enough.
 */
export function withTimeZone<T>(tz: string, fn: () => T): T {
  const previous = process.env['TZ'];
  process.env['TZ'] = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env['TZ'];
    } else {
      process.env['TZ'] = previous;
    }
  }
}
