import { useRef } from 'preact/hooks';
import { sessionBus, transfers, pendingShare } from '../transfers.js';
import { received } from '../sinks.js';
import { humanBytes } from './IncomingSheet.js';

export function fmtSpeed(bytesPerSec: number): string {
  return `${humanBytes(bytesPerSec)}/s`;
}

export function fmtEta(eta: number): string {
  if (!isFinite(eta) || eta <= 0) return '—';
  if (eta < 60) return `${eta.toFixed(0)}s`;
  const m = Math.floor(eta / 60);
  const s = Math.round(eta % 60);
  return `${m}m ${s}s`;
}

export function TransfersList() {
  const fileInput = useRef<HTMLInputElement>(null);
  const items = [...transfers.value.values()].slice(-30).reverse();
  const shareFiles = pendingShare.value;

  return (
    <div style="display:flex;flex-direction:column;gap:8px">
      {shareFiles && (
        <div class="transfer-item" style="border-color:rgba(34,211,238,.5)">
          <span>📤</span>
          <div class="tinfo">
            <div class="tname">{shareFiles.length} file{shareFiles.length > 1 ? 's' : ''} from share sheet</div>
            <div class="tmeta"><span>tap a device on the radar to send</span></div>
          </div>
          <button class="ghost" onClick={() => (pendingShare.value = null)}>✕</button>
        </div>
      )}
      {items.map((t) => {
        const pct = t.totalBytes > 0 ? Math.min(100, (t.bytes / t.totalBytes) * 100) : 0;
        const done = t.status === 'done';
        return (
          <div class={`transfer-item${done ? ' done' : ''}`} key={t.id}>
            <span style="opacity:.8">{t.direction === 'send' ? '↑' : '↓'}</span>
            <div class="tinfo">
              <div class="tname">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  {t.files?.map((f) => f.name).join(', ') || 'Transfer'}
                </span>
              </div>
              <div class="progressbar" style="margin-top:5px">
                <i style={`width:${done ? 100 : pct}%`} />
              </div>
              <div class="tmeta">
                <span>{t.peerName}</span>
                <span>
                  {t.status === 'offering'
                    ? 'waiting…'
                    : done
                      ? `done · ${humanBytes(t.totalBytes)}${t.files?.some((f) => f.verified) ? ' · verified ✓' : ''}`
                      : `${humanBytes(t.bytes)} / ${humanBytes(t.totalBytes)}`}
                </span>
                {t.status === 'active' && <span>{fmtSpeed(t.speed)}</span>}
                {t.status === 'active' && <span>ETA {fmtEta(t.eta)}</span>}
                {t.status === 'cancelled' && <span>cancelled</span>}
                {t.status === 'rejected' && <span>declined</span>}
                {t.status === 'error' && <span style="color:var(--danger)">failed</span>}
              </div>
            </div>
            {t.status === 'active' || t.status === 'offering' ? (
              <button class="danger" style="font-size:11px;padding:6px 10px" onClick={() => sessionBus.cancelTransfer(t.id)}>
                Stop
              </button>
            ) : t.status === 'error' ? (
              <button style="font-size:11px;padding:6px 10px" onClick={() => sessionBus.retryTransfer(t.id)}>
                Retry
              </button>
            ) : null}
            {done && t.direction === 'receive' && (
              <button
                class="primary"
                style="font-size:11px;padding:6px 10px"
                onClick={() => {
                  for (let i = 0; i < (t.files?.length ?? 0); i++) {
                    const rec = received.get(`${t.id}:${i}`);
                    if (rec && !rec.saved) void rec.save();
                  }
                }}
              >
                Save
              </button>
            )}
          </div>
        );
      })}
      <input ref={fileInput} type="file" multiple style="display:none" />
    </div>
  );
}
