/**
 * Minimal RTCDataChannel-like interface. `RTCDataChannel` satisfies this structurally,
 * as do native transport bridges (Phase 4) and test mocks.
 */
export interface ChannelLike extends EventTarget {
  readonly label: string;
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void | Promise<void>;
}

export function isOpen(ch: ChannelLike): boolean {
  return ch.readyState === 'open';
}

/** Resolves on the channel's `bufferedamountlow` or `close` event (whichever first). */
export function nextLowEvent(ch: ChannelLike): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ch.removeEventListener('bufferedamountlow', finish);
      ch.removeEventListener('close', finish);
      resolve();
    };
    ch.addEventListener('bufferedamountlow', finish);
    ch.addEventListener('close', finish);
    // If already drained below threshold, fire immediately.
    if (ch.readyState !== 'open' || ch.bufferedAmount <= ch.bufferedAmountLowThreshold) finish();
  });
}
