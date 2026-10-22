/** jsQR decoding in a dedicated worker (lazy-loaded chunk). */
import jsQR from 'jsqr';

self.onmessage = (e: MessageEvent) => {
  const { data, width, height } = e.data as { data: Uint8ClampedArray; width: number; height: number };
  const result = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
  (self as unknown as Worker).postMessage(result ? { text: result.data } : null);
};
