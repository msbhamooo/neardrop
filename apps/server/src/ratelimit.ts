/** Token-bucket rate limiter per socket. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(private capacity = 30, private refillPerSecond = 10) {
    this.tokens = capacity;
  }

  /** Returns true if the message is allowed. */
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSecond);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
