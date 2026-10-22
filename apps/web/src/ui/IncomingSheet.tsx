import { incoming, sessionBus } from '../transfers.js';

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function IncomingSheet() {
  const inc = incoming.value;
  if (!inc) return null;
  return (
    <div class="sheet" role="dialog" aria-label="Incoming transfer">
      <h3>
        {inc.senderName} wants to share {inc.files.length} file{inc.files.length > 1 ? 's' : ''}
      </h3>
      <div class="sub">
        {inc.paired ? 'Paired device ✓' : 'Verify the 4-emoji code on their device matches yours after accepting.'}
      </div>
      <div class="filelist">
        {inc.files.map((f, i) => (
          <div class="file-row" key={i}>
            <svg class="ficon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            <span class="fname">{f.name}</span>
            <span class="fsize">{humanBytes(f.size)}</span>
          </div>
        ))}
      </div>
      <div class="row-actions">
        <button class="danger" onClick={() => sessionBus.rejectIncoming()}>Decline</button>
        <button class="primary" onClick={() => sessionBus.acceptIncoming()}>Accept</button>
      </div>
    </div>
  );
}
