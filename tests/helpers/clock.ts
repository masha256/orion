import type { Clock } from '../../src/daemon/daemon.js';

/**
 * A clock that moves only when the test says so. `sleep(ms)` resolves once `advance` has moved the time to or past
 * the sleeper's wake-up time; sleepers wake in wake-up order.
 */
export class FakeClock implements Clock {
  private t: number;
  private sleepers: { at: number; wake: () => void }[] = [];

  constructor(start: string | Date) {
    this.t = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.t);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepers.push({ at: this.t + Math.max(0, ms), wake: resolve });
    });
  }

  /** Moves the time forward and wakes every sleeper now due. */
  advance(ms: number): void {
    this.t += ms;
    const due = this.sleepers.filter((s) => s.at <= this.t).sort((a, b) => a.at - b.at);
    this.sleepers = this.sleepers.filter((s) => s.at > this.t);
    for (const s of due) s.wake();
  }

  /** How many sleeps are waiting. */
  get pending(): number {
    return this.sleepers.length;
  }
}
