import { useEffect, useRef, useState } from 'preact/hooks';
import { peers, showToast } from '../transfers.js';
import { renderQr } from '../qr.js';
import {
  activeShare, linkDraft, linkRoom, linkPasswordFor,
  startShare, stopShare, leaveLinkRoom, submitLinkPassword,
} from '../share.js';

/**
 * Everything about share links that must be visible in any view: choosing options, the live link
 * (with QR), the password prompt for a protected link, and the "waiting for sender" status.
 */
export function LinkBanner() {
  const draft = linkDraft.value;
  const share = activeShare.value;
  const viaLink = linkRoom.value;
  const needsPw = linkPasswordFor.value;

  const [usePw, setUsePw] = useState(false);
  const [pw, setPw] = useState('');
  const [once, setOnce] = useState(false);
  const [recvPw, setRecvPw] = useState('');
  const qr = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (share && qr.current) void renderQr(qr.current, share.url).catch(() => undefined);
  }, [share?.url]);

  if (!draft && !share && !viaLink && !needsPw) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(share!.url);
      showToast('Link copied');
    } catch {
      showToast('Select the link and copy it', true);
    }
  };

  return (
    <div class="link-banner" aria-live="polite">
      {draft && (
        <div class="sh-panel">
          <div class="sh-label">Share by link</div>
          <p>
            {draft.length === 1 ? draft[0]!.name : `${draft.length} files`}. The receiver opens the link and the
            files go straight from your device to theirs.
          </p>
          <label class="sh-check">
            <input type="checkbox" checked={usePw} onChange={(e) => setUsePw((e.target as HTMLInputElement).checked)} />
            <span>Ask for a password</span>
          </label>
          {usePw && (
            <input
              class="sh-input"
              type="text"
              placeholder="Choose a password"
              value={pw}
              onInput={(e) => setPw((e.target as HTMLInputElement).value)}
              aria-label="Link password"
            />
          )}
          <label class="sh-check">
            <input type="checkbox" checked={once} onChange={(e) => setOnce((e.target as HTMLInputElement).checked)} />
            <span>Close the link after the first person receives it</span>
          </label>
          <div class="sh-actions">
            <button
              class="sh-btn primary"
              disabled={usePw && pw.trim().length < 4}
              onClick={() => {
                linkDraft.value = null;
                startShare(draft, { password: usePw ? pw : '', once });
                setPw(''); setUsePw(false); setOnce(false);
              }}
            >
              Create link
            </button>
            <button class="sh-btn" onClick={() => (linkDraft.value = null)}>Cancel</button>
          </div>
          {usePw && <p class="sh-sub">Tell the receiver the password separately. It is never put in the link.</p>}
        </div>
      )}

      {share && (
        <div class="sh-panel">
          <div class="sh-label">Sharing by link</div>
          <p>
            {share.files.length === 1 ? share.files[0]!.name : `${share.files.length} files`}. Anyone with this link
            {share.hasPassword ? ' and the password' : ''} can receive it. Keep this tab open until they have the files.
          </p>
          <div class="link-row">
            <div class="qr-card qr-small"><canvas ref={qr} /></div>
            <div class="link-col">
              <input class="sh-code-input" readOnly value={share.url} onFocus={(e) => (e.target as HTMLInputElement).select()} aria-label="Share link" />
              <div class="sh-actions">
                <button class="sh-btn primary" onClick={copy}>Copy link</button>
                <button class="sh-btn" onClick={stopShare}>Stop sharing</button>
              </div>
            </div>
          </div>
          <p class="sh-sub">
            {share.served === 0 ? 'Nobody has opened it yet.' : `Offered to ${share.served} device${share.served === 1 ? '' : 's'}.`}
            {share.once ? ' The link closes after the first delivery.' : ''}
          </p>
        </div>
      )}

      {needsPw && (
        <div class="sh-panel">
          <div class="sh-label">Password needed</div>
          <p>The sender protected this link. Ask them for the password.</p>
          <div class="sh-actions">
            <input
              class="sh-input"
              type="password"
              placeholder="Password"
              value={recvPw}
              onInput={(e) => setRecvPw((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && recvPw.trim() && submitLinkPassword(recvPw)}
              aria-label="Password"
            />
            <button class="sh-btn primary" disabled={!recvPw.trim()} onClick={() => submitLinkPassword(recvPw)}>Continue</button>
          </div>
        </div>
      )}

      {viaLink && (
        <div class="sh-panel">
          <div class="sh-label">Shared with you</div>
          <p>
            {peers.value.size
              ? 'Connected to the sender. An offer will appear in a moment; tap Accept to receive.'
              : 'Waiting for the sender. They need to keep NearDrop open. If a password was set, check you typed it correctly.'}
          </p>
          <div class="sh-actions"><button class="sh-btn" onClick={leaveLinkRoom}>Leave</button></div>
        </div>
      )}
    </div>
  );
}
