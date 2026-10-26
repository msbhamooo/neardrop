/** Device type + platform detection for the identity card and avatar icon. */
import type { DeviceType } from '@neardrop/core';

export function detectDeviceType(): DeviceType {
  const ua = navigator.userAgent;
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android.*Mobile|iPhone/i.test(ua)) return 'phone';
  if (/Android/i.test(ua)) return 'tablet';
  if (/TV|SmartTV|AppleTV/i.test(ua)) return 'tv';
  if (/Watch/i.test(ua)) return 'watch';
  if (/Macintosh|Windows NT|Linux.*x86/i.test(ua)) {
    return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1 ? 'tablet' : 'laptop';
  }
  return 'other';
}

import { generateUniqueDeviceName } from './naming.js';

export function friendlyDeviceDefaultName(deviceId?: string): string {
  return generateUniqueDeviceName(navigator.userAgent, deviceId);
}


export function humanDeviceLabel(deviceType: string): string {
  switch (deviceType) {
    case 'phone':
      return 'Phone';
    case 'tablet':
      return 'Tablet';
    case 'laptop':
      return 'Laptop';
    case 'desktop':
      return 'Computer';
    case 'tv':
      return 'TV';
    default:
      return 'Device';
  }
}
