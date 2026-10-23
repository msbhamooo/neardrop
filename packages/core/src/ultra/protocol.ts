/**
 * NEARDROP ULTRA - Extended Protocol Definitions
 * 
 * Extends the base NearDrop protocol with Ultra features:
 * - Multi-transport negotiation
 * - Neural congestion control messages
 * - Zero-RTT resume tokens
 * - Self-optimizing chunk parameters
 * - Holographic distribution metadata
 */

import type { Control } from '../protocol.js';

export type TransportType = 'webrtc' | 'webtransport' | 'http3';

export interface UltraControl extends Control {
  t: 'ultra-handshake' | 'ultra-ack' | 'ultra-probe' | 'ultra-resume' | 'ultra-chunk-meta';
}

export interface UltraHandshake {
  t: 'ultra-handshake';
  id: string;
  deviceId: string;
  capabilities: {
    multiTransport: boolean;
    neuralCongestion: boolean;
    zeroRttResume: boolean;
    selfOptimizingChunks: boolean;
    holographicDistribution: boolean;
    transports: TransportType[];
  };
  zeroRttToken?: string;
}

export interface UltraAck {
  t: 'ultra-ack';
  id: string;
  capabilities: {
    multiTransport: boolean;
    neuralCongestion: boolean;
    zeroRttResume: boolean;
    selfOptimizingChunks: boolean;
    holographicDistribution: boolean;
    transports: TransportType[];
  };
}

export interface UltraProbe {
  t: 'ultra-probe';
  id: string;
  transport: TransportType;
  chunkSize: number;
  latencyMs: number;
  lossRate: number;
}

export interface UltraResume {
  t: 'ultra-resume';
  id: string;
  token: string;
  transports: TransportType[];
}

export interface UltraChunkMeta {
  t: 'ultra-chunk-meta';
  id: string;
  fileIndex: number;
  chunkIndex: number;
  transport: TransportType;
  priority: number;
  holographicPosition: [number, number, number]; // 3D position in holographic space
}

/**
 * Encode Ultra control messages
 */
export function encodeUltraControl(msg: UltraControl): string {
  return JSON.stringify(msg);
}

/**
 * Parse Ultra control messages
 */
export function parseUltraControl(text: string): UltraControl | null {
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && typeof obj.t === 'string' && obj.t.startsWith('ultra-')) {
      return obj as UltraControl;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a control message is an Ultra message
 */
export function isUltraControl(msg: Control): msg is UltraControl {
  return typeof (msg as UltraControl).t === 'string' && 
         (msg as UltraControl).t.startsWith('ultra-');
}

/**
 * Create a Zero-RTT resume token
 */
export function createZeroRttToken(
  deviceId: string,
  peerId: string,
  timestamp: number,
  transportStates: Record<TransportType, any>
): string {
  // In a real implementation, this would be a signed JWT or similar
  // For now, we'll use a simple JSON encoding
  const token = {
    deviceId,
    peerId,
    timestamp,
    transportStates,
    version: 1,
  };
  return btoa(encodeURIComponent(JSON.stringify(token)));
}

/**
 * Parse a Zero-RTT resume token
 */
export function parseZeroRttToken(token: string): any {
  try {
    const decoded = decodeURIComponent(atob(token));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

/**
 * Generate holographic position for a chunk
 */
export function generateHolographicPosition(
  chunkIndex: number,
  totalChunks: number,
  fileIndex: number
): [number, number, number] {
  // Map chunk to 3D space
  // X: file index
  // Y: chunk position within file (0-1)
  // Z: priority/importance
  
  const x = fileIndex;
  const y = chunkIndex / Math.max(1, totalChunks - 1);
  
  // Z is based on chunk importance (early chunks and final chunks are more important)
  let z = 0.5;
  if (chunkIndex < totalChunks * 0.1) {
    z = 1.0; // High priority for early chunks
  } else if (chunkIndex === totalChunks - 1) {
    z = 1.0; // High priority for final chunk
  } else if (chunkIndex % 100 === 0) {
    z = 0.8; // Medium priority for checkpoint chunks
  }
  
  return [x, y, z];
}

/**
 * Calculate optimal chunk size based on network conditions
 */
export function calculateOptimalChunkSize(
  baseChunkSize: number,
  latencyMs: number,
  lossRate: number,
  throughput: number
): number {
  // Base chunk size
  let chunkSize = baseChunkSize;
  
  // Adjust for latency: higher latency = smaller chunks
  if (latencyMs > 200) {
    chunkSize = Math.max(16 * 1024, chunkSize * 0.8);
  } else if (latencyMs > 100) {
    chunkSize = Math.max(16 * 1024, chunkSize * 0.9);
  } else if (latencyMs < 50) {
    chunkSize = Math.min(16 * 1024 * 1024, chunkSize * 1.2);
  }
  
  // Adjust for loss rate: higher loss = smaller chunks
  if (lossRate > 0.05) {
    chunkSize = Math.max(16 * 1024, chunkSize * 0.7);
  } else if (lossRate > 0.01) {
    chunkSize = Math.max(16 * 1024, chunkSize * 0.9);
  }
  
  // Adjust for throughput: higher throughput = larger chunks
  if (throughput > 100 * 1024 * 1024) {
    chunkSize = Math.min(16 * 1024 * 1024, chunkSize * 1.1);
  } else if (throughput < 10 * 1024 * 1024) {
    chunkSize = Math.max(16 * 1024, chunkSize * 0.9);
  }
  
  return Math.round(chunkSize);
}

export {
  TransportType,
};
