/**
 * Test clock for canonical-loop deterministic time control (Issue 02).
 *
 * Lets tests advance time without sleeping wall-clock. Useful for the
 * lease-expiry/heartbeat tests in Issue 08. Default mode is "real" — tests
 * opt into fake mode with `useFakeClock(initialMs)`.
 */

export interface TestClock {
  now(): number;
  setNow(ms: number): void;
  advance(ms: number): void;
  isFake(): boolean;
}

class RealClock implements TestClock {
  now(): number { return Date.now(); }
  setNow(): void { throw new Error("RealClock cannot set time — call useFakeClock() first"); }
  advance(): void { throw new Error("RealClock cannot advance — call useFakeClock() first"); }
  isFake(): boolean { return false; }
}

class FakeClock implements TestClock {
  private current: number;
  constructor(initial: number) {
    this.current = initial;
  }
  now(): number { return this.current; }
  setNow(ms: number): void { this.current = ms; }
  advance(ms: number): void { this.current += ms; }
  isFake(): boolean { return true; }
}

let active: TestClock = new RealClock();

export function clock(): TestClock {
  return active;
}

export function useFakeClock(initialMs: number = 0): TestClock {
  active = new FakeClock(initialMs);
  return active;
}

export function useRealClock(): TestClock {
  active = new RealClock();
  return active;
}

/** Convenience: advance the active clock if it's fake; throw otherwise. */
export function advanceClock(ms: number): void {
  active.advance(ms);
}
