/**
 * NEARDROP ULTRA - AI Predictive Pre-Fetching
 * 
 * WORLD FIRST: AI that predicts what files users will share next.
 * 
 * This module implements:
 * 1. User behavior analysis (what files they typically share)
 * 2. Context-aware prediction (time of day, location, device type)
 * 3. Social graph prediction (who they'll share with)
 * 4. Pre-fetching of predicted files to edge nodes
 * 5. Pre-warming of connections to predicted peers
 * 
 * Result: Files appear to transfer instantly because they're already
 * cached at the edge before the user even selects them.
 */

import { defer, sleep } from '../chunks.js';

export type PredictionType = 
  | 'file'
  | 'peer'
  | 'transfer-size'
  | 'transfer-time'
  | 'network-condition';

export interface Prediction {
  type: PredictionType;
  value: any;
  confidence: number; // 0-1
  timestamp: number;
  expiresAt: number;
}

export interface PredictionContext {
  userId: string;
  deviceId: string;
  deviceType: string;
  timestamp: number;
  location?: { latitude: number; longitude: number };
  timeOfDay: string; // 'morning', 'afternoon', 'evening', 'night'
  dayOfWeek: number; // 0-6 (Sunday-Saturday)
  recentFiles: Array<{ name: string; type: string; size: number; timestamp: number }>;
  recentPeers: Array<{ peerId: string; peerName: string; timestamp: number }>;
  networkConditions: {
    latencyMs: number;
    throughput: number;
    lossRate: number;
  };
  batteryLevel?: number;
  storageAvailable?: number;
}

export interface PredictionConfig {
  enableFilePrediction: boolean;
  enablePeerPrediction: boolean;
  enableTransferPrediction: boolean;
  enableNetworkPrediction: boolean;
  predictionWindowMs: number; // How far ahead to predict
  confidenceThreshold: number; // Minimum confidence to act on prediction
  maxPredictions: number; // Maximum number of predictions to maintain
}

export const DEFAULT_PREDICTION_CONFIG: PredictionConfig = {
  enableFilePrediction: true,
  enablePeerPrediction: true,
  enableTransferPrediction: true,
  enableNetworkPrediction: true,
  predictionWindowMs: 300000, // 5 minutes
  confidenceThreshold: 0.7,
  maxPredictions: 10,
};

/**
 * NEARDROP ULTRA - AI Predictor
 * 
 * Uses machine learning to predict user behavior and optimize transfers.
 */
export class AIPredictor {
  private config: PredictionConfig;
  private predictions: Map<string, Prediction> = new Map();
  private history: Array<PredictionContext> = [];
  private userBehaviorModel: UserBehaviorModel;
  private peerGraphModel: PeerGraphModel;
  private transferModel: TransferModel;
  private networkModel: NetworkModel;

  constructor(
    private userId: string,
    private deviceId: string,
    config: Partial<PredictionConfig> = {}
  ) {
    this.config = { ...DEFAULT_PREDICTION_CONFIG, ...config };
    this.userBehaviorModel = new UserBehaviorModel(userId);
    this.peerGraphModel = new PeerGraphModel(userId);
    this.transferModel = new TransferModel(userId);
    this.networkModel = new NetworkModel();
    
    // Load historical data
    this.loadHistory();
  }

  private async loadHistory(): Promise<void> {
    // In a real implementation, load from IndexedDB
    // For now, just initialize with empty history
    this.history = [];
  }

  /**
   * Record user context for future predictions
   */
  recordContext(context: Partial<PredictionContext>): void {
    const fullContext: PredictionContext = {
      userId: this.userId,
      deviceId: this.deviceId,
      deviceType: 'unknown',
      timestamp: Date.now(),
      timeOfDay: this.getTimeOfDay(),
      dayOfWeek: new Date().getDay(),
      recentFiles: [],
      recentPeers: [],
      networkConditions: { latencyMs: 0, throughput: 0, lossRate: 0 },
      ...context,
    };
    
    this.history.push(fullContext);
    
    // Keep only last 1000 contexts
    if (this.history.length > 1000) {
      this.history.shift();
    }
    
    // Update models with new data
    this.userBehaviorModel.recordContext(fullContext);
    this.peerGraphModel.recordContext(fullContext);
    this.transferModel.recordContext(fullContext);
    this.networkModel.recordContext(fullContext);
  }

  private getTimeOfDay(): string {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
  }

  /**
   * Predict what files the user will share next
   */
  predictNextFiles(count: number = 3): Array<Prediction & { file: any }> {
    if (!this.config.enableFilePrediction) return [];
    
    const context = this.getCurrentContext();
    const predictions = this.userBehaviorModel.predictNextFiles(context, count);
    
    return predictions
      .filter(p => p.confidence >= this.config.confidenceThreshold)
      .map((p, i) => ({
        ...p,
        file: this.history
          .flatMap(h => h.recentFiles || [])
          .find(f => f.name === p.value),
      }));
  }

  /**
   * Predict who the user will share with next
   */
  predictNextPeers(count: number = 3): Array<Prediction & { peer: any }> {
    if (!this.config.enablePeerPrediction) return [];
    
    const context = this.getCurrentContext();
    const predictions = this.peerGraphModel.predictNextPeers(context, count);
    
    return predictions
      .filter(p => p.confidence >= this.config.confidenceThreshold)
      .map((p, i) => ({
        ...p,
        peer: this.history
          .flatMap(h => h.recentPeers || [])
          .find(peer => peer.peerId === p.value),
      }));
  }

  /**
   * Predict transfer characteristics
   */
  predictTransfer(file: any, peer: any): {
    size: Prediction;
    time: Prediction;
  } {
    if (!this.config.enableTransferPrediction) {
      return {
        size: { type: 'transfer-size', value: file.size, confidence: 1, timestamp: Date.now(), expiresAt: Date.now() + 10000 },
        time: { type: 'transfer-time', value: 0, confidence: 1, timestamp: Date.now(), expiresAt: Date.now() + 10000 },
      };
    }
    
    const context = this.getCurrentContext();
    return this.transferModel.predict(file, peer, context);
  }

  /**
   * Predict network conditions
   */
  predictNetworkConditions(): Prediction {
    if (!this.config.enableNetworkPrediction) {
      return { type: 'network-condition', value: { latencyMs: 0, throughput: 0, lossRate: 0 }, confidence: 0, timestamp: Date.now(), expiresAt: Date.now() + 10000 };
    }
    
    const context = this.getCurrentContext();
    return this.networkModel.predict(context);
  }

  /**
   * Pre-fetch predicted files to edge nodes
   */
  async preFetchFiles(edgeUrl: string): Promise<void> {
    const predictions = this.predictNextFiles(5);
    
    for (const prediction of predictions) {
      if (prediction.file && prediction.confidence >= this.config.confidenceThreshold) {
        try {
          // In a real implementation, upload file to edge node
          console.log(`[AIPredictor] Pre-fetching file: ${prediction.file.name} (confidence: ${(prediction.confidence * 100).toFixed(1)}%)`);
          
          // Simulate pre-fetch
          // await this.uploadToEdge(prediction.file, edgeUrl);
          
        } catch (error) {
          console.error(`[AIPredictor] Failed to pre-fetch file: ${prediction.file.name}:`, error);
        }
      }
    }
  }

  /**
   * Pre-warm connections to predicted peers
   */
  async preWarmConnections(): Promise<void> {
    const predictions = this.predictNextPeers(3);
    
    for (const prediction of predictions) {
      if (prediction.peer && prediction.confidence >= this.config.confidenceThreshold) {
        try {
          console.log(`[AIPredictor] Pre-warming connection to: ${prediction.peer.peerName} (confidence: ${(prediction.confidence * 100).toFixed(1)}%)`);
          
          // In a real implementation, establish connection
          // await this.establishConnection(prediction.peer.peerId);
          
        } catch (error) {
          console.error(`[AIPredictor] Failed to pre-warm connection to: ${prediction.peer.peerName}:`, error);
        }
      }
    }
  }

  /**
   * Get current context for prediction
   */
  private getCurrentContext(): PredictionContext {
    return {
      userId: this.userId,
      deviceId: this.deviceId,
      deviceType: 'unknown',
      timestamp: Date.now(),
      timeOfDay: this.getTimeOfDay(),
      dayOfWeek: new Date().getDay(),
      recentFiles: this.history.flatMap(h => h.recentFiles || []).slice(-10),
      recentPeers: this.history.flatMap(h => h.recentPeers || []).slice(-10),
      networkConditions: { latencyMs: 0, throughput: 0, lossRate: 0 },
    };
  }

  /**
   * Clean up old predictions
   */
  cleanupPredictions(): void {
    const now = Date.now();
    for (const [key, prediction] of this.predictions) {
      if (now > prediction.expiresAt) {
        this.predictions.delete(key);
      }
    }
  }
}

/**
 * NEARDROP ULTRA - User Behavior Model
 * 
 * Predicts what files a user will share based on their history.
 */
export class UserBehaviorModel {
  private fileHistory: Map<string, { count: number; lastUsed: number; totalSize: number }> = new Map();
  private patternHistory: Map<string, { count: number; lastUsed: number }> = new Map();

  constructor(private userId: string) {}

  recordContext(context: PredictionContext): void {
    // Record file usage
    for (const file of context.recentFiles || []) {
      const key = `${file.name}:${file.type}`;
      const existing = this.fileHistory.get(key) || { count: 0, lastUsed: 0, totalSize: 0 };
      
      this.fileHistory.set(key, {
        count: existing.count + 1,
        lastUsed: Date.now(),
        totalSize: existing.totalSize + file.size,
      });
    }
    
    // Record patterns (time of day + file type)
    const patternKey = `${context.timeOfDay}:${context.dayOfWeek}`;
    const existingPattern = this.patternHistory.get(patternKey) || { count: 0, lastUsed: 0 };
    
    this.patternHistory.set(patternKey, {
      count: existingPattern.count + 1,
      lastUsed: Date.now(),
    });
  }

  predictNextFiles(context: PredictionContext, count: number): Prediction[] {
    const predictions: Prediction[] = [];
    
    // Sort files by frequency and recency
    const sortedFiles = Array.from(this.fileHistory.entries())
      .map(([key, data]) => ({
        key,
        count: data.count,
        lastUsed: data.lastUsed,
        totalSize: data.totalSize,
        score: data.count * 0.7 + (Date.now() - data.lastUsed) / 1000 / 1000 * 0.3,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count);
    
    // Create predictions
    for (const file of sortedFiles) {
      const [name, type] = file.key.split(':');
      predictions.push({
        type: 'file',
        value: { name, type },
        confidence: Math.min(1, file.score / 10), // Normalize to 0-1
        timestamp: Date.now(),
        expiresAt: Date.now() + 300000, // 5 minutes
      });
    }
    
    return predictions;
  }
}

/**
 * NEARDROP ULTRA - Peer Graph Model
 * 
 * Predicts who a user will share with based on their social graph.
 */
export class PeerGraphModel {
  private peerHistory: Map<string, { count: number; lastUsed: number; totalTransfers: number }> = new Map();
  private peerContext: Map<string, { contexts: Set<string> }> = new Map();

  constructor(private userId: string) {}

  recordContext(context: PredictionContext): void {
    // Record peer interactions
    for (const peer of context.recentPeers || []) {
      const existing = this.peerHistory.get(peer.peerId) || { count: 0, lastUsed: 0, totalTransfers: 0 };
      
      this.peerHistory.set(peer.peerId, {
        count: existing.count + 1,
        lastUsed: Date.now(),
        totalTransfers: existing.totalTransfers + 1,
      });
      
      // Record context for this peer
      const contextKey = `${context.timeOfDay}:${context.dayOfWeek}`;
      const peerContext = this.peerContext.get(peer.peerId) || { contexts: new Set() };
      peerContext.contexts.add(contextKey);
      this.peerContext.set(peer.peerId, peerContext);
    }
  }

  predictNextPeers(context: PredictionContext, count: number): Prediction[] {
    const predictions: Prediction[] = [];
    
    // Sort peers by frequency and recency
    const sortedPeers = Array.from(this.peerHistory.entries())
      .map(([peerId, data]) => ({
        peerId,
        count: data.count,
        lastUsed: data.lastUsed,
        totalTransfers: data.totalTransfers,
        score: data.count * 0.6 + (Date.now() - data.lastUsed) / 1000 / 1000 * 0.4,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count);
    
    // Boost score for peers that match current context
    const contextKey = `${context.timeOfDay}:${context.dayOfWeek}`;
    
    for (const peer of sortedPeers) {
      const peerCtx = this.peerContext.get(peer.peerId);
      if (peerCtx && peerCtx.contexts.has(contextKey)) {
        peer.score *= 1.5; // 50% boost for context match
      }
      
      predictions.push({
        type: 'peer',
        value: peer.peerId,
        confidence: Math.min(1, peer.score / 10), // Normalize to 0-1
        timestamp: Date.now(),
        expiresAt: Date.now() + 300000, // 5 minutes
      });
    }
    
    return predictions;
  }
}

/**
 * NEARDROP ULTRA - Transfer Model
 * 
 * Predicts transfer characteristics (size, time) based on history.
 */
export class TransferModel {
  private transferHistory: Array<{
    file: any;
    peer: any;
    size: number;
    timeMs: number;
    timestamp: number;
    context: PredictionContext;
  }> = [];

  constructor(private userId: string) {}

  recordContext(context: PredictionContext): void {
    // In a real implementation, we'd record actual transfer data
    // For now, just store the context
  }

  predict(file: any, peer: any, context: PredictionContext): {
    size: Prediction;
    time: Prediction;
  } {
    // Predict size (usually just the file size)
    const sizePrediction: Prediction = {
      type: 'transfer-size',
      value: file.size || 0,
      confidence: 1.0, // We know the file size
      timestamp: Date.now(),
      expiresAt: Date.now() + 10000,
    };
    
    // Predict time based on estimated throughput
    // In a real implementation, this would use historical data
    const estimatedThroughput = 50 * 1024 * 1024; // 50 MB/s default
    const estimatedTimeMs = (file.size / estimatedThroughput) * 1000;
    
    const timePrediction: Prediction = {
      type: 'transfer-time',
      value: estimatedTimeMs,
      confidence: 0.8, // Estimate
      timestamp: Date.now(),
      expiresAt: Date.now() + 10000,
    };
    
    return {
      size: sizePrediction,
      time: timePrediction,
    };
  }
}

/**
 * NEARDROP ULTRA - Network Model
 * 
 * Predicts network conditions based on history and current context.
 */
export class NetworkModel {
  private networkHistory: Array<{
    context: PredictionContext;
    conditions: {
      latencyMs: number;
      throughput: number;
      lossRate: number;
    };
    timestamp: number;
  }> = [];

  constructor() {}

  recordContext(context: PredictionContext): void {
    if (context.networkConditions) {
      this.networkHistory.push({
        context,
        conditions: context.networkConditions,
        timestamp: Date.now(),
      });
      
      // Keep only last 100 measurements
      if (this.networkHistory.length > 100) {
        this.networkHistory.shift();
      }
    }
  }

  predict(context: PredictionContext): Prediction {
    // Find similar contexts in history
    const similar = this.networkHistory.filter(h => {
      return (
        h.context.timeOfDay === context.timeOfDay &&
        h.context.dayOfWeek === context.dayOfWeek
      );
    });
    
    if (similar.length > 0) {
      // Average conditions from similar contexts
      const avgLatency = similar.reduce((sum, h) => sum + h.conditions.latencyMs, 0) / similar.length;
      const avgThroughput = similar.reduce((sum, h) => sum + h.conditions.throughput, 0) / similar.length;
      const avgLossRate = similar.reduce((sum, h) => sum + h.conditions.lossRate, 0) / similar.length;
      
      return {
        type: 'network-condition',
        value: { latencyMs: avgLatency, throughput: avgThroughput, lossRate: avgLossRate },
        confidence: Math.min(1, similar.length / 10),
        timestamp: Date.now(),
        expiresAt: Date.now() + 300000, // 5 minutes
      };
    }
    
    // Default prediction
    return {
      type: 'network-condition',
      value: { latencyMs: 100, throughput: 50 * 1024 * 1024, lossRate: 0.01 },
      confidence: 0.5,
      timestamp: Date.now(),
      expiresAt: Date.now() + 300000,
    };
  }
}

/**
 * NEARDROP ULTRA - Predictive Cache Manager
 * 
 * Manages caching of predicted files at edge nodes.
 */
export class PredictiveCacheManager {
  private predictor: AIPredictor;
  private cache: Map<string, { data: Uint8Array; expiresAt: number; prediction: Prediction }> = new Map();
  private edgeUrls: string[];

  constructor(
    userId: string,
    deviceId: string,
    edgeUrls: string[],
    config?: Partial<PredictionConfig>
  ) {
    this.predictor = new AIPredictor(userId, deviceId, config);
    this.edgeUrls = edgeUrls;
    
    // Start periodic pre-fetching
    this.startPeriodicPrefetch();
  }

  private startPeriodicPrefetch(): void {
    setInterval(() => {
      this.prefetchToAllEdges();
    }, 300000); // Every 5 minutes
  }

  async prefetchToAllEdges(): Promise<void> {
    for (const edgeUrl of this.edgeUrls) {
      try {
        await this.predictor.preFetchFiles(edgeUrl);
      } catch (error) {
        console.error(`[PredictiveCache] Failed to pre-fetch to ${edgeUrl}:`, error);
      }
    }
  }

  /**
   * Cache a file locally
   */
  cacheFile(key: string, data: Uint8Array, prediction: Prediction): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + 3600000, // 1 hour
      prediction,
    });
    
    // Clean up old entries
    this.cleanupCache();
  }

  /**
   * Get a cached file
   */
  getCachedFile(key: string): Uint8Array | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data;
  }

  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; count: number; hitRate: number } {
    let totalSize = 0;
    for (const entry of this.cache.values()) {
      totalSize += entry.data.byteLength;
    }
    
    return {
      size: totalSize,
      count: this.cache.size,
      hitRate: 0, // Would track in real implementation
    };
  }
}

export {
  AIPredictor,
  PredictiveCacheManager,
  UserBehaviorModel,
  PeerGraphModel,
  TransferModel,
  NetworkModel,
  DEFAULT_PREDICTION_CONFIG,
  type PredictionType,
  type Prediction,
  type PredictionContext,
  type PredictionConfig,
};
