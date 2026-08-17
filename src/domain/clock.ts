/**
 * The clock is a dependency, never an ambient global (ADR-006).
 *
 * No function in `src/domain` may call `Date.now()` or `new Date()` with no
 * argument. Every suppression test has to be able to fast-forward across a
 * month boundary, a leap day and a DST transition, and it can only do that if
 * the clock is something the test hands in.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock the tests drive by hand. */
export class TestClock implements Clock {
  private current: Date;

  constructor(initial: Date | string) {
    this.current = typeof initial === 'string' ? new Date(initial) : new Date(initial);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(instant: Date | string): void {
    this.current = typeof instant === 'string' ? new Date(instant) : new Date(instant);
  }

  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
