import { render } from 'preact';
import { signal } from '@preact/signals';
import type { DeviceType } from '@neardrop/core';

export const AVATAR_COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#60a5fa'];

export function colorFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!;
}

const glyphs: Record<string, string> = {
  phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  tablet: '<rect x="5" y="3" width="14" height="18" rx="2"/>',
  laptop: '<rect x="4" y="5" width="16" height="10" rx="1"/><path d="M2 19h20"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20l1-4h6l1 4"/>',
  tv: '<rect x="3" y="6" width="18" height="12" rx="1"/><path d="M8 21h8"/>',
  watch: '<rect x="7" y="7" width="10" height="10" rx="3"/><path d="M9 7l1-4h4l1 4M9 17l1 4h4l1-4"/>',
  other: '<circle cx="12" cy="12" r="9"/>',
};

export function iconFor(deviceType: string): DeviceType {
  const t = ['phone', 'tablet', 'laptop', 'desktop', 'tv', 'watch', 'other'];
  return (t.includes(deviceType) ? deviceType : 'other') as DeviceType;
}

export function Avatar({
  name,
  deviceType,
  id,
  progress,
  size = 64,
}: {
  name: string;
  deviceType: string;
  id: string;
  progress?: number; // 0..1 while transferring
  size?: number;
}) {
  const color = colorFor(id);
  const initial = (name || '?').trim()[0]?.toUpperCase() ?? '?';
  const R = 33;
  const C = 2 * Math.PI * R;
  return (
    <div class="avatar" style={`width:${size}px;height:${size}px;color:${color}`}>
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        dangerouslySetInnerHTML={{ __html: glyphs[iconFor(deviceType)] ?? glyphs.other }}
      />
      <span class="initial" style={`color:${color}`}>{initial}</span>
      {progress !== undefined && progress > 0 && (
        <svg class="ring-svg" viewBox="0 0 76 76" style={`top:-6px;left:${size / 2 - 38}px`}>
          <circle cx="38" cy="38" r={R} fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="4" />
          <circle
            cx="38"
            cy="38"
            r={R}
            fill="none"
            stroke="#22d3ee"
            stroke-width="4"
            stroke-linecap="round"
            stroke-dasharray={`${(C * Math.min(1, progress)).toFixed(1)} ${C.toFixed(1)}`}
          />
        </svg>
      )}
    </div>
  );
}

export const showPairedBadge = signal(false);
