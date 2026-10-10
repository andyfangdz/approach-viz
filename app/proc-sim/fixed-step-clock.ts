/** Wall time scheduling only; all flight computation remains in Rust. */
export class FixedStepClock {
  private lastTime: number;
  private remainder = 0;
  constructor(
    now: number,
    private readonly dt: number
  ) {
    this.lastTime = now;
  }
  steps(now: number, paused: boolean, speed: number): number {
    const elapsed = Math.max(0, Math.min((now - this.lastTime) / 1000, 0.25));
    this.lastTime = now;
    if (paused) return 0;
    this.remainder += elapsed * speed;
    const steps = Math.floor((this.remainder + 1e-9) / this.dt);
    this.remainder = Math.max(0, this.remainder - steps * this.dt);
    return steps;
  }
}
