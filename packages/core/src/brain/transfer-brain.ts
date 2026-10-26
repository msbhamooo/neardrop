/**
 * Transfer Brain: Adaptive Machine-Loop Flow Control & Congestion Optimization
 *
 * Implements: "Measure → Predict → Probe → Learn → Optimize → Recover → Migrate"
 *
 * Replaces fixed chunk sizes and static 1MB buffer watermarks with:
 * 1. Dynamic Chunk Sizer: Explores 16KB -> 32KB -> 64KB -> 128KB -> 256KB -> 512KB
 *    based on RTT stability, link loss, and NIC throughput.
 * 2. Dynamic Low-Water Threshold: Derived continuously from Bandwidth-Delay Product (BDP)
 *    and receiver storage consumption rate.
 * 3. Closed-Loop Congestion Controller (BBR-inspired state machine):
 *    - STARTUP: Rapidly ramps up throughput to find pipe capacity.
 *    - PROBE_BW: Periodically pulses send window to discover newly opened bandwidth.
 *    - PROBE_RTT: Drains queues briefly to measure baseline latency without buffer bloat.
 *    - DRAIN: Rapidly backs off if the receiver's disk write pipeline falls behind.
 */

import { Emitter, type EventMap } from '../events.js';

export type CongestionPhase = 'STARTUP' | 'PROBE_BW' | 'PROBE_RTT' | 'DRAIN';

export interface BrainTelemetry {
  chunkSize: number;
  lowThresholdBytes: number;
  highWaterBytes: number;
  phase: CongestionPhase;
  rttMs: number;
  jitterMs: number;
  bandwidthMbps: number;
  bdpBytes: number;
  diskBacklogBytes: number;
  pacingDelayMs: number;
}

export interface TransferBrainEvents extends EventMap {
  adaptation: BrainTelemetry;
  phaseChange: { from: CongestionPhase; to: CongestionPhase; reason: string };
}

export class TransferBrain extends Emitter<TransferBrainEvents> {
  // Configurable ladder of chunk sizes
  private static readonly CHUNK_LADDER = [
    16 * 1024,
    32 * 1024,
    64 * 1024,
    128 * 1024,
    256 * 1024,
    512 * 1024,
  ];

  private currentChunkIndex = 2; // Default 64KB
  private phase: CongestionPhase = 'STARTUP';
  private srttMs = 25;
  private minRttMs = 15;
  private rttVarMs = 5;
  private deliveryRateBps = 10 * 1024 * 1024; // 10 MB/s initial estimate
  private bdpBytes = 128 * 1024;
  private diskBacklogBytes = 0;
  private diskWriteSpeedBps = 50 * 1024 * 1024;
  private lastProbeBwAt = 0;
  private lastProbeRttAt = 0;
  private consecutiveGoodWindows = 0;
  private consecutiveNacks = 0;

  constructor(private opts: { initialChunkSize?: number; maxMemoryBudget?: number } = {}) {
    super();
    if (opts.initialChunkSize) {
      const idx = TransferBrain.CHUNK_LADDER.findIndex((s) => s >= opts.initialChunkSize!);
      if (idx >= 0) this.currentChunkIndex = idx;
    }
  }

  get chunkSize(): number {
    return TransferBrain.CHUNK_LADDER[this.currentChunkIndex]!;
  }

  /**
   * Dynamically calculated bufferedAmountLowThreshold:
   * Target is 1.5x to 2x Bandwidth-Delay Product (BDP) so the network pipe never starves,
   * clamped between 64KB and 8MB (or lower if disk write queue is backed up).
   */
  get lowThresholdBytes(): number {
    const memoryBudget = this.opts.maxMemoryBudget ?? 32 * 1024 * 1024;
    let target = Math.max(64 * 1024, Math.round(this.bdpBytes * 1.8));

    // Disk backpressure damping: if receiver disk is congested, clamp send threshold
    if (this.diskBacklogBytes > 4 * 1024 * 1024) {
      target = Math.min(target, 256 * 1024);
    }
    return Math.min(target, memoryBudget / 4, 8 * 1024 * 1024);
  }

  get highWaterBytes(): number {
    return Math.max(this.lowThresholdBytes * 3, 2 * 1024 * 1024);
  }

  get currentPhase(): CongestionPhase {
    return this.phase;
  }

  /**
   * Called on every chunk ack or progress packet with latest runtime telemetry.
   */
  onFeedback(telemetry: {
    rttMs?: number;
    bytesAcked?: number;
    elapsedSec?: number;
    nack?: boolean;
    diskBacklogBytes?: number;
    diskSpeedBps?: number;
  }): void {
    const now = performance.now();

    // 1. Update RTT & Jitter
    if (telemetry.rttMs !== undefined && telemetry.rttMs > 0) {
      const rtt = telemetry.rttMs;
      if (rtt < this.minRttMs) this.minRttMs = rtt;
      const err = Math.abs(rtt - this.srttMs);
      this.rttVarMs = 0.75 * this.rttVarMs + 0.25 * err;
      this.srttMs = 0.875 * this.srttMs + 0.125 * rtt;
    }

    // 2. Update Delivery Rate & BDP
    if (telemetry.bytesAcked && telemetry.elapsedSec && telemetry.elapsedSec > 0) {
      const instRate = telemetry.bytesAcked / telemetry.elapsedSec;
      this.deliveryRateBps = this.deliveryRateBps * 0.7 + instRate * 0.3;
      const rttSec = Math.max(0.001, this.srttMs / 1000);
      this.bdpBytes = Math.max(32 * 1024, Math.round(this.deliveryRateBps * rttSec));
    }

    // 3. Receiver Storage Pipeline Feedback
    if (telemetry.diskBacklogBytes !== undefined) {
      this.diskBacklogBytes = telemetry.diskBacklogBytes;
    }
    if (telemetry.diskSpeedBps !== undefined && telemetry.diskSpeedBps > 0) {
      this.diskWriteSpeedBps = telemetry.diskSpeedBps;
    }

    // 4. Packet Loss / NACK handling
    if (telemetry.nack) {
      this.consecutiveNacks++;
      this.consecutiveGoodWindows = 0;
      // Step down chunk size if experiencing drops
      if (this.currentChunkIndex > 0) {
        this.currentChunkIndex--;
      }
      this.transitionTo('DRAIN', 'NACK / Packet loss detected');
    } else {
      this.consecutiveNacks = 0;
      this.consecutiveGoodWindows++;
    }

    // 5. Congestion State Machine Transitions
    this.evaluateStateMachine(now);

    this.emit('adaptation', {
      chunkSize: this.chunkSize,
      lowThresholdBytes: this.lowThresholdBytes,
      highWaterBytes: this.highWaterBytes,
      phase: this.phase,
      rttMs: Math.round(this.srttMs),
      jitterMs: Math.round(this.rttVarMs),
      bandwidthMbps: +((this.deliveryRateBps * 8) / (1024 * 1024)).toFixed(1),
      bdpBytes: this.bdpBytes,
      diskBacklogBytes: this.diskBacklogBytes,
      pacingDelayMs: this.phase === 'DRAIN' ? 15 : 0,
    });
  }

  private evaluateStateMachine(now: number): void {
    // If disk write pipeline is overloaded, force DRAIN
    if (this.diskBacklogBytes > 16 * 1024 * 1024) {
      if (this.phase !== 'DRAIN') {
        this.transitionTo('DRAIN', 'Receiver disk queue backlog > 16MB');
      }
      return;
    }

    switch (this.phase) {
      case 'STARTUP':
        if (this.consecutiveGoodWindows >= 12) {
          // Probe next larger chunk size during startup if jitter is low
          if (this.currentChunkIndex < TransferBrain.CHUNK_LADDER.length - 1 && this.rttVarMs < 15) {
            this.currentChunkIndex++;
          }
          this.transitionTo('PROBE_BW', 'Startup ramp complete; pipeline healthy');
        }
        break;

      case 'PROBE_BW':
        if (now - this.lastProbeBwAt > 6000) {
          this.lastProbeBwAt = now;
          // Explore larger chunk size if link has been stable
          if (this.consecutiveGoodWindows > 20 && this.currentChunkIndex < TransferBrain.CHUNK_LADDER.length - 1) {
            this.currentChunkIndex++;
          }
        }
        if (now - this.lastProbeRttAt > 12000) {
          this.transitionTo('PROBE_RTT', 'Periodic min-RTT calibration');
        }
        break;

      case 'PROBE_RTT':
        // Stay in PROBE_RTT briefly (200ms) to allow network queues to clear
        if (now - this.lastProbeRttAt > 300) {
          this.lastProbeRttAt = now;
          this.transitionTo('PROBE_BW', 'RTT calibration complete');
        }
        break;

      case 'DRAIN':
        if (this.diskBacklogBytes < 4 * 1024 * 1024 && this.consecutiveNacks === 0) {
          this.transitionTo('PROBE_BW', 'Backpressure relieved');
        }
        break;
    }
  }

  private transitionTo(next: CongestionPhase, reason: string): void {
    if (this.phase === next) return;
    const prev = this.phase;
    this.phase = next;
    this.emit('phaseChange', { from: prev, to: next, reason });
  }

  reset(): void {
    this.currentChunkIndex = 2; // 64KB
    this.phase = 'STARTUP';
    this.consecutiveGoodWindows = 0;
    this.consecutiveNacks = 0;
  }
}
