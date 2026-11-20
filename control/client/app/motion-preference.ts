import { useSyncExternalStore } from 'react';

let reduced = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getReduceMotion = () => reduced;
export function setReduceMotion(value: boolean) {
  document.documentElement.toggleAttribute('data-reduce-motion', value);
  if (reduced === value) return;
  reduced = value;
  listeners.forEach((listener) => listener());
}
export function useReduceMotion() {
  return useSyncExternalStore(subscribe, getReduceMotion);
}
