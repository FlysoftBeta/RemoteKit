import { useSyncExternalStore } from 'react';

const KEY = 'remotekit.device.preferences';
type DevicePreferences = { v: 1; compatibility: boolean };
const defaults: DevicePreferences = { v: 1, compatibility: true };
const listeners = new Set<() => void>();
function read(): DevicePreferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (value && value.v === 1 && typeof value.compatibility === 'boolean' && Object.keys(value).length === 2)
      return value;
  } catch {
    return defaults;
  }
  return defaults;
}
let snapshot = read();
export const getSnapshot = () => snapshot;
export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function setCompatibility(compatibility: boolean) {
  snapshot = { v: 1, compatibility };
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    // error-guard: device-preferences
  }
  listeners.forEach((listener) => listener());
}
export function useDevicePreferences() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY && event.key !== null) return;
    const next = read();
    if (next.compatibility === snapshot.compatibility) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  });
