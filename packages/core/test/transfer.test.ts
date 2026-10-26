import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { TransferSender, TransferReceiver, type SinkHandle } from '../src/index.js';
import { mockPair, MemoryFile, MemorySink, randomBytes, sinkHandle, type MockOptions } from './util.js';

const MB = 1024 * 1024;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

interface Rig {
  sender: TransferSender;
  receiver: TransferReceiver;
  sinks: Map<number, MemorySink>;
  dataA: ReturnType<typeof mockPair>['a'][];
  errors: Error[];
}

function rig(files: MemoryFile[], opts: { channels?: number; link?: MockOptions; config?: object; accept?: boolean } = {}): Rig {
  const channels = opts.channels ?? 4;
  const control = mockPair('ctrl');
  const dataA: Rig['dataA'] = [];
  const dataB: Rig['dataA'] = [];
  for (let i = 0; i < channels; i++) {
    const p = mockPair(`data${i}`, opts.link);
    dataA.push(p.a);
    dataB.push(p.b);
  }
  const sinks = new Map<number, MemorySink>();
  const errors: Error[] = [];
  const config = { parallelChannels: channels, parallelThresholdBytes: 256 * 1024, ...opts.config };
  const receiver = new TransferReceiver({
    sinkFor: async (i): Promise<SinkHandle> => {
      const s = new MemorySink();
      sinks.set(i, s);
      return sinkHandle(s);
    },
    config,
  });
  receiver.attach({ control: control.b, data: dataB });
  receiver.on('error', ({ error }) => errors.push(error));
  receiver.on('offer', () => {
    if (opts.accept === false) receiver.userReject('no thanks');
    else void receiver.userAccept();
  });
  const sender = new TransferSender({ id: 'T1', files, config });
  sender.attach({ control: control.a, data: dataA });
  sender.on('error', ({ error }: { error: Error }) => errors.push(error));
  return { sender, receiver, sinks, dataA, errors };
}

describe('end-to-end transfer over mock channels', () => {
  it('delivers several files byte-for-byte, with verified hashes', async () => {
    const files = [
      new MemoryFile('big.bin', randomBytes(5 * MB, 11)),
      new MemoryFile('small.bin', randomBytes(1234, 12)),
      new MemoryFile('empty.bin', new Uint8Array(0)),
      new MemoryFile('odd.bin', randomBytes(64 * 1024 + 1, 13)),
    ];
    const r = rig(files);
    const verified: boolean[] = [];
    r.receiver.on('fileDone', (f) => verified.push(f.verified));
    expect(await r.sender.run()).toBe('complete');
    files.forEach((f, i) => expect(sha(r.sinks.get(i)!.bytes)).toBe(sha(f.bytes)));
    expect(verified.every(Boolean)).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('works on a single channel and with 16KB chunks (old-Safari profile)', async () => {
    const f = new MemoryFile('safari.bin', randomBytes(3 * MB, 21));
    const r = rig([f], { channels: 1, config: { chunkSize: 16 * 1024 } });
    expect(await r.sender.run()).toBe('complete');
    expect(sha(r.sinks.get(0)!.bytes)).toBe(sha(f.bytes));
  });

  it('transfers text (compressed path) and highly repetitive data (dedup path) intact', async () => {
    const text = new TextEncoder().encode('hello neardrop\n'.repeat(80_000));
    const zeros = new Uint8Array(4 * MB);
    const files = [new MemoryFile('log.txt', text, 'text/plain'), new MemoryFile('zeros.bin', zeros)];
    const r = rig(files);
    expect(await r.sender.run()).toBe('complete');
    expect(sha(r.sinks.get(0)!.bytes)).toBe(sha(text));
    expect(sha(r.sinks.get(1)!.bytes)).toBe(sha(zeros));
  });

  it('respects backpressure: buffered bytes stay near the high-water mark on a slow link', async () => {
    const f = new MemoryFile('slow.bin', randomBytes(24 * MB, 31));
    const r = rig([f], { link: { bytesPerTick: 4 * MB, tickMs: 1 } });
    expect(await r.sender.run()).toBe('complete');
    const peak = Math.max(...r.dataA.map((c) => c.stats.maxBufferedSeen));
    expect(peak).toBeLessThan(8 * MB + 512 * 1024);
    expect(sha(r.sinks.get(0)!.bytes)).toBe(sha(f.bytes));
  });

  it('does not write anything when the receiver declines', async () => {
    const f = new MemoryFile('nope.bin', randomBytes(MB, 41));
    const r = rig([f], { accept: false });
    expect(await r.sender.run()).toBe('rejected');
    expect([...r.sinks.values()].every((s) => s.bytes.length === 0)).toBe(true);
  });

  it('never reports success for a corrupted chunk', async () => {
    const f = new MemoryFile('corrupt.bin', randomBytes(2 * MB, 51));
    const r = rig([f], { channels: 1, link: { corruptFrame: 5 } });
    const verified: boolean[] = [];
    r.receiver.on('fileDone', (x) => verified.push(x.verified));
    const outcome = await Promise.race([
      r.sender.run().then((x) => x, () => 'threw'),
      new Promise<string>((res) => setTimeout(() => res('timeout'), 20_000)),
    ]);
    const flaggedBad = r.errors.length > 0 || verified.includes(false) || outcome !== 'complete';
    expect(flaggedBad).toBe(true);
  });

  it('cancel mid-transfer stops cleanly', async () => {
    const f = new MemoryFile('cancel.bin', randomBytes(32 * MB, 61));
    const r = rig([f], { link: { bytesPerTick: MB, tickMs: 1 } });
    const done = r.sender.run();
    setTimeout(() => r.sender.cancel('changed my mind'), 150);
    expect(await done).toBe('cancelled');
  });

  it('fails (rather than hangs) when the link drops mid-transfer', async () => {
    const f = new MemoryFile('drop.bin', randomBytes(32 * MB, 71));
    const r = rig([f], { link: { bytesPerTick: MB, tickMs: 1 } });
    const done = r.sender.run().then((x) => x, () => 'threw');
    setTimeout(() => r.dataA.forEach((c) => c.close()), 150);
    const out = await Promise.race([done, new Promise<string>((res) => setTimeout(() => res('hung'), 15_000))]);
    expect(out).not.toBe('complete');
    expect(out).not.toBe('hung');
  });
});
