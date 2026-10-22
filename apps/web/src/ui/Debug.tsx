import { useEffect, useRef } from 'preact/hooks';
import { sessionBus, transfers } from '../transfers.js';
import { peers } from '../transfers.js';

/** Sparkline + ICE state for the first active link. */
export function DebugPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samplesRef = useRef<number[]>([]);

  useEffect(() => {
    const timer = setInterval(() => {
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
  return (
    <div class="debug-panel">
      <div>
        <span class="k">ice pair</span>{' '}
        {info ? `${info.localType} ↔ ${info.remoteType} · ${info.selectedPair}` : 'connecting…'}
      </div>
      <div>
        <span class="k">channels</span>{' '}
        <span class="kv">
          {(info?.channels ?? []).map((c) => (
            <span key={c.label}>
              {c.label}:{(c.buffered / 1024).toFixed(0)}KB
            </span>
          ))}
        </span>
      </div>
      <div>
        <span class="k">peers</span> {peers.value.size} · <span class="k">transfers</span> {transfers.value.size}
      </div>
      <canvas ref={canvasRef} aria-label="live speed graph" />
      <div style="opacity:.7">speed graph (0.5s samples)</div>
    </div>
  );
}
