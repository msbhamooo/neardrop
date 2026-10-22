/**
 * NearDrop transfer engine benchmark.
 * Runs the full sender→receiver pipeline over mock channels with a drain-rate cap,
 * reporting MB/s, memory growth and buffer bounds.
 *
 *   pnpm bench            → default suite
 * pnpm bench -- --big    → adds a 4GB pass (spec target)
 */
import { performance } from 'node:perf_hooks';
import {
  TransferSender, TransferReceiver, DEFAULT_CONFIG,
  type FileSource, type SinkHandle, type ByteSink,
} from '../src/index.js';
import { mockPair, MemoryFile, CountingSink, sinkHandle } from '../test/util.js';

const MB = 1024 * 1024;

class ZeroCopyFile implements FileSource {
  meta: { name: string; size: number; type: string };
  constructor(name: string, size: number) {
    this.meta = { name, size, type: 'application/octet-stream' };
  }
  stream(start = 0): ReadableStream<Uint8Array> {
    // yields a pre-allocated zero buffer repeatedly: isolates engine cost from content generation
    const block = new Uint8Array(1024 * 1024); // 1MB of zeros, shared
    const size = this.meta.size;
    let pos = start;
    return new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (pos >= size) {
          ctrl.close();
          return;
        }
        const end = Math.min(size, pos + block.length);
        const view = block.subarray(0, end - pos);
        pos = end;
        ctrl.enqueue(view.slice()); // copy 1MB slice so sinks can retain safely
      },
    });
  }
}

async function runScenario(name: string, opts: {
  sizeMB: number;
  channels: number;
  drainBytesPerTick: number;
  chunkSize?: number;
  countSinks?: boolean;
}) {
  const chunkSize = opts.chunkSize ?? DEFAULT_CONFIG.chunkSize;
  const files: FileSource[] = [new ZeroCopyFile(`bench-${name}.bin`, opts.sizeMB * MB)];
  const control = mockPair(`ctrl-${name}`);
  const dataA = [];
  const dataB = [];
  for (let i = 0; i < opts.channels; i++) {
    const p = mockPair(`data-${name}-${i}`, { bytesPerTick: opts.drainBytesPerTick, tickMs: 0 });
    dataA.push(p.a);
    dataB.push(p.b);
  }
  const sinks = new Map<number, ByteSink>();
  const receiver = new TransferReceiver({
    sinkFor: async (i): Promise<SinkHandle> => {
      const s = new CountingSink();
      sinks.set(i, s);
      return sinkHandle(s);
    },
    config: { chunkSize, parallelChannels: opts.channels, parallelThresholdBytes: MB, verifyThresholdBytes: 0 },
  });
  receiver.attach({ control: control.b, data: dataB });
  receiver.on('offer', () => void receiver.userAccept());

  const sender = new TransferSender({
    id: `bench-${name}`,
    files,
    config: { chunkSize, parallelChannels: opts.channels, parallelThresholdBytes: MB, verifyThresholdBytes: 0 },
  });
  sender.attach({ control: control.a, data: dataA });

  global.gc?.();
  const memBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  await sender.run();
  const secs = (performance.now() - t0) / 1000;
  global.gc?.();
  const memGrowthMB = (process.memoryUsage().heapUsed - memBefore) / MB;

  const maxBuffered = Math.max(...dataA.map((c) => (c as any).stats.maxBufferedSeen)) / MB;
  const maxPending = receiver.stats.maxPendingBytes / MB;
  const mbps = opts.sizeMB / secs;
  const result = {
    scenario: name,
    sizeMB: opts.sizeMB,
    channels: opts.channels,
    seconds: +secs.toFixed(2),
    MBps: +mbps.toFixed(1),
    maxBufferedMB: +maxBuffered.toFixed(2),
    maxPendingMB: +maxPending.toFixed(2),
    heapGrowthMB: +memGrowthMB.toFixed(1),
    okBytes: (sinks.get(0) as CountingSink).bytes === opts.sizeMB * MB,
  };
  console.log(
    `${name.padEnd(24)} ${String(opts.sizeMB + 'MB').padStart(7)}  ${mbps.toFixed(1).padStart(8)} MB/s  ` +
    `buf<= ${maxBuffered.toFixed(2).padStart(7)}MB  pend<= ${maxPending.toFixed(2).padStart(6)}MB  ` +
    `heapΔ ${memGrowthMB.toFixed(1).padStart(7)}MB  bytes-ok=${result.okBytes}`,
  );
  return result;
}

const results: unknown[] = [];
console.log('\n=== NearDrop engine benchmark (mock transport) ===\n');
results.push(await runScenario('engine-ceiling-256MB', { sizeMB: 256, channels: 4, drainBytesPerTick: 1 << 30 }));
results.push(await runScenario('cap-25MBps-512MB', { sizeMB: 512, channels: 4, drainBytesPerTick: 25 * MB }));
results.push(await runScenario('single-channel-128MB', { sizeMB: 128, channels: 1, drainBytesPerTick: 512 * MB }));
results.push(await runScenario('small-chunks-64MB', { sizeMB: 64, channels: 2, drainBytesPerTick: 512 * MB, chunkSize: 16 * 1024 }));
if (process.argv.includes('--big')) {
  results.push(await runScenario('spec-4GB', { sizeMB: 4096, channels: 4, drainBytesPerTick: 512 * MB }));
}
console.log('\nPASS targets: buffers stay under highWater bounds; heap growth per GB stays far below the 200MB spec ceiling.');
