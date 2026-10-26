import { useEffect, useRef, useState } from 'preact/hooks';
import { sessionBus, transfers, peers } from '../transfers.js';

/**
 * Real-Time Telemetry Dashboard for Connection Brain & Adaptive Transfer Brain
 */
export function DebugPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samplesRef = useRef<number[]>([]);
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
      const active = [...transfers.value.values()].find((t) => t.status === 'active');
      const speed = active?.speed ?? 0;
      const arr = samplesRef.current;
      arr.push(speed);
      if (arr.length > 120) arr.shift();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = (canvas.width = canvas.clientWidth * 2);
      const h = (canvas.height = 120);
      ctx.clearRect(0, 0, w, h);
      const max = Math.max(1024 * 1024, ...arr);
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 3;
      ctx.beginPath();
      arr.forEach((v, i) => {
        const x = (i / Math.max(arr.length - 1, 1)) * w;
        const y = h - (v / max) * (h - 8) - 4;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const link = sessionBus.activeLink?.();
  const info = link?.lastDebug;
  const brain = link?.brain;
  const activeTransport = brain?.getActiveTransport();
  const standbyTransport = brain?.getStandbyTransport();
  const sender = sessionBus.activeSender?.();
  const transferBrain = sender?.brain;

  return (
    <div class="debug-panel" style={{ fontSize: '11px', lineHeight: '1.5' }}>
      <div style={{ fontWeight: 600, color: '#38bdf8', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        ⚡ Connection & Transfer Brain
      </div>

      <div>
        <span class="k">active transport</span>{' '}
        <span style={{ color: activeTransport?.type === 'relay' ? '#fbbf24' : '#34d399', fontWeight: 600 }}>
          {activeTransport ? activeTransport.type.toUpperCase() : 'SEARCHING…'}
        </span>
        {standbyTransport && (
          <span style={{ opacity: 0.75, marginLeft: '6px' }}>
            (standby: {standbyTransport.type})
          </span>
        )}
      </div>

      <div>
        <span class="k">path metrics</span>{' '}
        {activeTransport ? (
          <span class="kv">
            RTT: {Math.round(activeTransport.metrics.srttMs)}ms · Jitter: {Math.round(activeTransport.metrics.rttVarMs)}ms · BDP: {(activeTransport.metrics.bdpBytes / 1024).toFixed(0)}KB
          </span>
        ) : (
          'measuring…'
        )}
      </div>

      {transferBrain && (
        <>
          <div>
            <span class="k">adaptive flow</span>{' '}
            <span class="kv">
              Chunk: {(transferBrain.chunkSize / 1024).toFixed(0)}KB · Threshold: {(transferBrain.lowThresholdBytes / 1024).toFixed(0)}KB · Phase:{' '}
              <span style={{ color: transferBrain.currentPhase === 'DRAIN' ? '#f87171' : '#67e8f9' }}>
                {transferBrain.currentPhase}
              </span>
            </span>
          </div>
        </>
      )}

      <div>
        <span class="k">ice candidate pair</span>{' '}
        <span style={{ opacity: 0.9 }}>
          {info ? `${info.localType} ↔ ${info.remoteType} · ${info.selectedPair}` : 'connecting…'}
        </span>
      </div>

      <div>
        <span class="k">channels</span>{' '}
        <span class="kv">
          {(info?.channels ?? []).map((c) => (
            <span key={c.label} style={{ marginRight: '6px' }}>
              {c.label}:{(c.buffered / 1024).toFixed(0)}KB
            </span>
          ))}
        </span>
      </div>

      <div>
        <span class="k">peers active</span> {peers.value.size} · <span class="k">transfers</span> {transfers.value.size}
      </div>

      <div style={{ marginTop: '6px' }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '60px', borderRadius: '4px', background: 'rgba(0,0,0,0.25)' }} aria-label="live speed graph" />
      </div>
      <div style={{ opacity: 0.6, fontSize: '10px', textAlign: 'right' }}>real-time throughput (MB/s)</div>
    </div>
  );
}
