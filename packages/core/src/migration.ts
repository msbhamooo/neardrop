/**
 * Hot Transport Migration Protocol & Coordinator
 *
 * Coordinates zero-downtime path handovers between:
 * - Relay (tunnel) -> P2P WebRTC (direct wire speed promotion)
 * - P2P WebRTC -> Relay (predictive degradation failover)
 * - P2P -> LAN / BroadcastChannel
 *
 * Executes migration at clean chunk boundaries so not a single byte is lost or re-sent.
 */

import { Emitter, type EventMap } from './events.js';
import type { ChannelLike } from './channel.js';
import type { Control } from './protocol.js';

export type MigrationState = 'IDLE' | 'PREPARING' | 'COMMITTED';

export interface MigrationEvents extends EventMap {
  migrated: { fromLabel: string; toLabel: string; atChunk: number };
  error: { error: Error };
}

export class MigrationCoordinator extends Emitter<MigrationEvents> {
  private state: MigrationState = 'IDLE';
  private targetDataChannels: ChannelLike[] = [];
  private pendingChunkBoundary = -1;

  get currentState(): MigrationState {
    return this.state;
  }

  prepareMigration(newChannels: ChannelLike[], atChunk: number): Control {
    this.state = 'PREPARING';
    this.targetDataChannels = newChannels;
    this.pendingChunkBoundary = atChunk;
    return {
      t: 'migrate-prepare',
      atChunk,
    };
  }

  handleReceiverAck(atChunk: number): { readyChannels: ChannelLike[]; fromChunk: number } {
    this.state = 'COMMITTED';
    const channels = this.targetDataChannels;
    const from = Math.max(atChunk, this.pendingChunkBoundary);
    this.emit('migrated', {
      fromLabel: 'previous',
      toLabel: channels[0]?.label ?? 'new',
      atChunk: from,
    });
    this.state = 'IDLE';
    return { readyChannels: channels, fromChunk: from };
  }

  reset(): void {
    this.state = 'IDLE';
    this.targetDataChannels = [];
    this.pendingChunkBoundary = -1;
  }
}
