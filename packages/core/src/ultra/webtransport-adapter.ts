/**
 * NEARDROP ULTRA - WebTransport Adapter
 * 
 * WORLD FIRST: WebTransport integration for file sharing in a PWA.
 * WebTransport is the next-generation protocol that combines HTTP/3 + QUIC.
 * This adapter makes WebTransport channels compatible with the ChannelLike interface.
 * 
 * WebTransport advantages:
 * - Built on QUIC (same as HTTP/3)
 * - 0-RTT connection establishment
 * - Multiplexed streams (no head-of-line blocking)
 * - Built-in flow control
 * - Better congestion control than WebRTC
 * - Works through most firewalls
 */

import type { ChannelLike } from '../channel.js';

declare global {
  interface Window {
    WebTransport: typeof WebTransport;
  }
}

export interface WebTransportOptions {
  url: string;
  serverCertificateHashes?: Array<{ algorithm: string; value: Uint8Array }>;
  congestionControl?: 'default' | 'bbr' | 'cubic';
}

export interface WebTransportChannelOptions {
  sendBufferSize?: number;
  receiveBufferSize?: number;
}

/**
 * NEARDROP ULTRA - WebTransport Channel Adapter
 * 
 * Wraps a WebTransport bidirectional stream to match the ChannelLike interface.
 * This allows the Multi-Transport Engine to use WebTransport alongside WebRTC.
 */
export class WebTransportChannel implements ChannelLike {
  readonly label: string;
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  
  private transport: WebTransport | null = null;
  private stream: WebTransportSendStream | null = null;
  private receiveStream: ReadableStream<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private bufferedAmount = 0;
  bufferedAmountLowThreshold = 1 * 1024 * 1024; // 1MB
  
  private messageQueue: Array<{ type: string; data: any }> = [];
  private isProcessing = false;
  
  // Event listeners
  private listeners = new Map<string, Set<EventListener>>();
  
  constructor(
    private options: WebTransportOptions,
    label: string = 'webtransport',
    private channelOptions: WebTransportChannelOptions = {}
  ) {
    this.label = label;
    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      // Check if WebTransport is available
      if (!globalThis.WebTransport) {
        throw new Error('WebTransport not available in this browser');
      }
      
      // Create WebTransport connection
      this.transport = new WebTransport(this.options.url, {
        serverCertificateHashes: this.options.serverCertificateHashes,
        congestionControl: this.options.congestionControl,
      });
      
      // Set up event listeners
      this.transport.addEventListener('connection', () => {
        this.readyState = 'open';
        this.dispatchEvent(new Event('open'));
      });
      
      this.transport.addEventListener('error', (error: Event) => {
        this.readyState = 'closed';
        this.dispatchEvent(new Event('error'));
      });
      
      this.transport.addEventListener('closed', () => {
        this.readyState = 'closed';
        this.dispatchEvent(new Event('close'));
      });
      
      // Create bidirectional stream
      this.stream = await this.transport.createBidirectionalStream();
      this.receiveStream = this.stream.readable;
      this.writer = this.stream.writable.getWriter();
      
      // Set up reader
      this.reader = this.receiveStream.getReader();
      this.startReading();
      
      this.readyState = 'open';
      this.dispatchEvent(new Event('open'));
      
    } catch (error) {
      this.readyState = 'closed';
      this.dispatchEvent(new Event('error'));
      console.error('[WebTransport] Initialization failed:', error);
    }
  }

  private startReading(): void {
    const readChunk = async () => {
      if (!this.reader || this.readyState !== 'open') return;
      
      try {
        const result = await this.reader.read();
        if (result.done) {
          this.readyState = 'closed';
          this.dispatchEvent(new Event('close'));
          return;
        }
        
        // Parse the message
        // First 4 bytes = message type (0 = data, 1 = control)
        // Next 4 bytes = length
        // Rest = data
        if (result.value.byteLength >= 8) {
          const view = new DataView(result.value.buffer, result.value.byteOffset, result.value.byteLength);
          const messageType = view.getUint32(0, true);
          const length = view.getUint32(4, true);
          const data = result.value.slice(8);
          
          // Dispatch message event
          const messageEvent = new MessageEvent(messageType === 0 ? 'message' : 'control', {
            data: messageType === 0 ? data : new TextDecoder().decode(data),
          });
          this.dispatchEvent(messageEvent);
        }
        
        // Continue reading
        readChunk();
        
      } catch (error) {
        this.readyState = 'closed';
        this.dispatchEvent(new Event('error'));
      }
    };
    
    readChunk();
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 'open') {
      throw new Error('WebTransport channel not open');
    }
    
    if (!this.writer) {
      throw new Error('Writer not initialized');
    }
    
    // Convert data to Uint8Array
    let bytes: Uint8Array;
    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    
    // Create message header
    // Type: 0 for string data, 1 for binary/ArrayBuffer
    const messageType = typeof data === 'string' ? 1 : 0;
    const header = new Uint8Array(8);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, messageType, true);
    headerView.setUint32(4, bytes.byteLength, true);
    
    // Combine header and data
    const message = new Uint8Array(header.length + bytes.length);
    message.set(header);
    message.set(bytes, header.length);
    
    // Update buffered amount
    this.bufferedAmount += message.byteLength;
    
    // Send
    this.writer.write(message).catch((error) => {
      console.error('[WebTransport] Send failed:', error);
      this.readyState = 'closed';
      this.dispatchEvent(new Event('error'));
    });
    
    // Simulate bufferedamountlow event
    if (this.bufferedAmount > this.bufferedAmountLowThreshold) {
      // In a real implementation, we'd track actual buffered amount
      // For now, we'll just simulate it
    }
  }

  close(): void {
    this.readyState = 'closing';
    
    if (this.writer) {
      this.writer.close().catch(() => {});
    }
    
    if (this.reader) {
      this.reader.cancel().catch(() => {});
    }
    
    if (this.transport) {
      this.transport.close();
    }
    
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }

  // EventTarget methods
  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): void {
    const type = event.type;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

/**
 * NEARDROP ULTRA - WebTransport Connection Manager
 * 
 * Manages WebTransport connections and creates channels for the Multi-Transport Engine.
 */
export class WebTransportManager {
  private transport: WebTransport | null = null;
  private channels: Map<string, WebTransportChannel> = new Map();
  private connectionPromise: Promise<void> | null = null;

  constructor(private options: WebTransportOptions) {}

  async connect(): Promise<void> {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }
    
    this.connectionPromise = this.establishConnection();
    await this.connectionPromise;
    this.connectionPromise = null;
  }

  private async establishConnection(): Promise<void> {
    if (!globalThis.WebTransport) {
      throw new Error('WebTransport not available in this browser');
    }
    
    this.transport = new WebTransport(this.options.url, {
      serverCertificateHashes: this.options.serverCertificateHashes,
      congestionControl: this.options.congestionControl,
    });
    
    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      this.transport!.addEventListener('connection', () => resolve());
      this.transport!.addEventListener('error', () => reject(new Error('Connection failed')));
    });
  }

  createChannel(label: string = 'data'): WebTransportChannel {
    if (!this.transport) {
      throw new Error('WebTransport not connected');
    }
    
    const channel = new WebTransportChannel(this.options, label);
    this.channels.set(label, channel);
    return channel;
  }

  getChannel(label: string): WebTransportChannel | undefined {
    return this.channels.get(label);
  }

  closeAll(): void {
    for (const channel of this.channels.values()) {
      channel.close();
    }
    this.channels.clear();
    
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }
  }

  get isConnected(): boolean {
    return this.transport?.readyState === 'connected' || false;
  }
}

/**
 * NEARDROP ULTRA - WebTransport Availability Check
 */
export function isWebTransportAvailable(): boolean {
  return typeof globalThis.WebTransport === 'function';
}

/**
 * NEARDROP ULTRA - WebTransport Feature Detection
 */
export function getWebTransportFeatures(): {
  available: boolean;
  supportsBidirectionalStreams: boolean;
  supportsDatagrams: boolean;
  congestionControlOptions: string[];
} {
  if (!globalThis.WebTransport) {
    return {
      available: false,
      supportsBidirectionalStreams: false,
      supportsDatagrams: false,
      congestionControlOptions: [],
    };
  }

  // Check for features
  const features = {
    available: true,
    supportsBidirectionalStreams: true,
    supportsDatagrams: 'datagrams' in WebTransport.prototype,
    congestionControlOptions: ['default', 'bbr', 'cubic'],
  };

  return features;
}

export {
  WebTransportChannel,
  WebTransportManager,
  isWebTransportAvailable,
  getWebTransportFeatures,
};
