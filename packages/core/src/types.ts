export type DeviceType = 'phone' | 'tablet' | 'laptop' | 'desktop' | 'tv' | 'watch' | 'other';

export interface DeviceInfo {
  deviceId: string;
  name: string;
  deviceType: DeviceType;
}

export interface FileMeta {
  /** sanitized display name */
  name: string;
  /** byte length of the (uncompressed) file */
  size: number;
  /** MIME type; '' when unknown */
  type: string;
  /** SHA-256 hex of the raw (uncompressed) bytes; present when the sender precomputed it */
  hash?: string;
}

/**
 * Platform-agnostic file input. Web wraps File/Blob via `file.slice(start).stream()`.
 */
export interface FileSource {
  meta: FileMeta;
  /** Read bytes starting at `start` (0-based), yielding exactly size-start bytes. */
  stream(start?: number): ReadableStream<Uint8Array>;
}

/** Where the receiver writes reassembled bytes (OPFS writer, Blob parts, test memory...). */
export interface ByteSink {
  write(chunk: Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
  abort?(reason?: unknown): Promise<void> | void;
}

/** Result of the sink factory. `startBytes` = actual resume point (must be a multiple of chunkSize). */
export interface SinkHandle {
  sink: ByteSink;
  /** bytes already present in the sink that will NOT be re-sent; 0 for a fresh sink */
  startBytes: number;
  /** whether the sink persists across app restarts (enables crash-resume) */
  persist?: boolean;
}

export interface TransferProgress {
  transferId: string;
  direction: 'send' | 'receive';
  fileIndex: number;
  fileName: string;
  /** contiguous committed bytes (receiver) or bytes handed to the wire (sender) */
  bytes: number;
  totalBytes: number;
  /** bytes per second (rolling window) */
  speed: number;
  /** seconds; Infinity when unknown */
  eta: number;
}

export interface FileResult {
  transferId: string;
  fileIndex: number;
  name: string;
  size: number;
  /** SHA-256 verified against sender's hash */
  verified: boolean;
}
