/**
 * Receive-side storage: OPFS streaming writer (primary), in-memory Blob fallback.
 * Received files land in OPFS `received/` and are offered for "Save to disk"
 * (browsers don't let web pages write into Downloads directly).
 * Partial positions are cached in IndexedDB for crash resume.
 */
import { get, set, del } from 'idb-keyval';
import type { ByteSink, FileMeta, SinkHandle } from '@neardrop/core';

const OPFS_DIR = 'received';
const BLOB_MAX = 512 * 1024 * 1024; // 512MB cap for the in-memory fallback

export interface ReceivedFile {
  name: string;
  size: number;
  verified: boolean;
  saved: boolean;
  save(): Promise<void>;
}

export const received = new Map<string, ReceivedFile>(); // key `${transferId}:${fileIndex}`

function sanitizeName(name: string): string {
  const base = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').trim();
  return (base.length > 0 ? base : 'file').slice(-180);
}

const opfsSupported = (): boolean =>
  typeof navigator !== 'undefined' &&
  !!navigator.storage &&
  typeof navigator.storage.getDirectory === 'function';

async function receivedDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

/** Deduplicate filename inside OPFS dir: photo.jpg → photo (1).jpg */
async function uniqueName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  let candidate = name;
  for (let i = 1; ; i++) {
    try {
      await dir.getFileHandle(candidate, { create: false });
      const dot = name.lastIndexOf('.');
      candidate = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
      if (i > 500) return `${Date.now()}-${name}`;
    } catch {
      return candidate;
    }
  }
}

interface PartialMeta {
  name: string;
  opfsName: string;
  size: number;
  startBytes: number;
  senderId: string;
}

const partialKey = (senderId: string, name: string, size: number): string =>
  `neardrop:partial:${senderId}:${name}:${size}`;

/** Chunks are batched into blocks this big before each OPFS write (each write call costs ~5ms). */
const OPFS_BLOCK = 4 * 1024 * 1024;

class OpfsSink implements ByteSink {
  private buf = new Uint8Array(OPFS_BLOCK);
  private len = 0;
  /** absolute file offset that has really been handed to OPFS (resume must never claim more) */
  private flushedAbs: number;

  constructor(private writable: FileSystemWritableFileStream, private handle: FileSystemFileHandle, startBytes = 0) {
    this.flushedAbs = startBytes;
  }

  get flushed(): number {
    return this.flushedAbs;
  }

  private async flush(): Promise<void> {
    if (this.len === 0) return;
    // write() copies the bytes before returning its promise, so the buffer can be reused at once
    const n = this.len;
    const pending = this.writable.write(this.buf.subarray(0, n) as unknown as BufferSource);
    this.len = 0;
    await pending;
    this.flushedAbs += n;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.len + chunk.length > this.buf.length) await this.flush();
    if (chunk.length >= this.buf.length) {
      await this.writable.write(chunk as unknown as BufferSource);
      this.flushedAbs += chunk.length;
      return;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
  }
  async close(): Promise<void> {
    await this.flush();
    await this.writable.close();
  }
  async abort(): Promise<void> {
    try { await this.writable.abort('cancelled'); } catch { /* already closed */ }
  }
  file(): Promise<File> {
    return this.handle.getFile();
  }
}

class BlobSink implements ByteSink {
  parts: BlobPart[] = [];
  constructor(private handle: { name: string }) {}
  write(chunk: Uint8Array): void {
    this.parts.push(chunk.slice().buffer as ArrayBuffer);
  }
  close(): void { /* kept open until save() */
  }
  abort(): void {
    this.parts = [];
  }
  get name(): string { return this.handle.name; }
}

/** Build a sink for an incoming file. Honors persisted partials for crash resume. */
export async function makeSink(
  transferId: string,
  fileIndex: number,
  meta: FileMeta,
  senderId: string,
  resumeRequested: { startBytes: number } | null,
): Promise<SinkHandle | null> {
  const key = partialKey(senderId, meta.name, meta.size);
  const partial = await get<PartialMeta>(key);

  if (opfsSupported()) {
    try {
      const dir = await receivedDir();
      let opfsName: string;
      let startBytes = 0;
      let writable: FileSystemWritableFileStream;
      if (partial && partial.size === meta.size && partial.startBytes > 0 && meta.size > 0) {
        // crash resume: reopen with keepExistingData and seek to the persisted boundary
        try {
          const fh = await dir.getFileHandle(partial.opfsName, { create: false });
          writable = await fh.createWritable({ keepExistingData: true });
          await writable.seek(partial.startBytes);
          opfsName = partial.opfsName;
          startBytes = partial.startBytes;
        } catch {
          startBytes = 0;
          opfsName = await uniqueName(dir, sanitizeName(meta.name));
          const fh = await dir.getFileHandle(opfsName, { create: true });
          writable = await fh.createWritable();
        }
      } else {
        opfsName = await uniqueName(dir, sanitizeName(meta.name));
        const fh = await dir.getFileHandle(opfsName, { create: true });
        writable = await fh.createWritable();
      }
      const fh = await dir.getFileHandle(opfsName, { create: false });
      const sink = new OpfsSink(writable, fh, startBytes);
      registerReceived(transferId, fileIndex, meta, sink, opfsName);
      return { sink, startBytes, persist: true };
    } catch {
      /* fall through to blob */
    }
  }

  if (meta.size > BLOB_MAX) return null; // no OPFS + huge file: cannot do
  const blobSink = new BlobSink({ name: sanitizeName(meta.name) });
  registerReceived(transferId, fileIndex, meta, blobSink, '');
  return { sink: blobSink, startBytes: 0, persist: false };
}

interface FileInfo {
  name: string;
  size: number;
  opfsName: string;
  sink?: OpfsSink | BlobSink;
}

const fileInfo = new Map<string, FileInfo>(); // `${transferId}:${fileIndex}`

function registerReceived(
  transferId: string,
  fileIndex: number,
  meta: FileMeta,
  sink: OpfsSink | BlobSink,
  opfsName: string,
): void {
  const mapKey = `${transferId}:${fileIndex}`;
  fileInfo.set(mapKey, { name: meta.name, size: meta.size, opfsName, sink });
  received.set(mapKey, {
    name: meta.name,
    size: meta.size,
    verified: false,
    saved: false,
    async save(): Promise<void> {
      const file: Blob =
        sink instanceof OpfsSink
          ? await sink.file()
          : new Blob(sink.parts, { type: meta.type || 'application/octet-stream' });
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = meta.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      this.saved = true;
    },
  });
}

/**
 * Wire a receiver's onPersist/onForget to the IndexedDB partial cache.
 * onPersist fires at chunk boundaries — throttle IDB writes to one per 8MB.
 */
export function receiverPersistHooks(transferId: string, senderId: string): {
  onPersist: (fileIndex: number, bytes: number) => void;
  onForget: (fileIndex: number) => void;
} {
  const lastPersist = new Map<number, number>();
  return {
    onPersist: (fileIndex, bytes) => {
      const info = fileInfo.get(`${transferId}:${fileIndex}`);
      if (!info || !info.opfsName) return; // blob sinks can't resume across restarts
      // never persist a resume point beyond what has actually been written out of the batch buffer
      if (info.sink instanceof OpfsSink) bytes = Math.min(bytes, info.sink.flushed);
      const last = lastPersist.get(fileIndex) ?? 0;
      const atEnd = bytes >= info.size;
      if (!atEnd && bytes - last < 8 * 1024 * 1024) return;
      lastPersist.set(fileIndex, bytes);
      const key = partialKey(senderId, info.name, info.size);
      void set(key, { name: info.name, opfsName: info.opfsName, size: info.size, startBytes: bytes, senderId });
    },
    onForget: (fileIndex) => {
      const info = fileInfo.get(`${transferId}:${fileIndex}`);
      if (info) void del(partialKey(senderId, info.name, info.size));
    },
  };
}

/** Look up persisted partials for a sender's files: used to seed receiver resume hints. */
export async function lookupPartials(senderId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>(); // `${name}\u0000${size}` -> startBytes
  const keys = await keysWithPrefix('neardrop:partial:');
  for (const [key, value] of keys) {
    if (!key.startsWith(`neardrop:partial:${senderId}:`)) continue;
    const partial = value as PartialMeta;
    out.set(`${partial.name}\u0000${partial.size}`, partial.startBytes);
  }
  return out;
}

async function keysWithPrefix(prefix: string): Promise<Array<[string, unknown]>> {
  const out: Array<[string, unknown]> = [];
  try {
    // idb-keyval exposes a custom store only via createStore; using its `keys()` needs the default store.
    const { keys, get } = await import('idb-keyval');
    const allKeys = (await keys()) as unknown as Array<IDBValidKey>;
    for (const k of allKeys) {
      if (typeof k === 'string' && k.startsWith(prefix)) out.push([k, await get(k)]);
    }
  } catch {
    /* no IDB */
  }
  return out;
}
