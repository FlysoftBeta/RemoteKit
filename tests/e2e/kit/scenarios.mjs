const standard = [
  'test-focus-close',
  'workspace-ui',
  'web-app-install',
  'failure-presentation',
  'test-admin-announcements',
  'shell-phone-daily',
  'shell-keepalive-return',
  'shell-security-admin',
];
const positional = [
  'test-context-menu',
  'test-touch-selection',
  'test-clipboard',
  'test-file-library',
  'test-camera-scan',
  'test-mobile-ime',
  'test-keyboard-viewport',
  'test-keyboard-recovery',
  'test-fullscreen',
  'test-diagnostic-collection',
  'test-cluster-nodes',
  'test-coordination-reconnect',
];
const touch = new Set([
  'shell-phone-daily',
  'test-touch-selection',
  'test-clipboard',
  'test-mobile-ime',
  'test-keyboard-viewport',
  'test-keyboard-recovery',
  'test-native-gestures',
]);
const serial = new Set([
  'test-node-updater',
  'test-cluster-nodes',
  'cluster-user-journeys',
  'shell-avail-cluster',
  'shell-user-journeys',
  'test-local-selection',
  'test-keyboard-recovery',
  'test-keyboard-viewport',
  'test-clipboard',
  'test-context-menu',
  'test-camera-scan',
  'test-fullscreen',
  'files-user-journeys',
  'input-user-journeys',
  'test-native-gestures',
]);
const chrome89 = new Set([
  'workspace-ui',
  'test-rtc-input-recovery',
  'test-context-menu',
  'test-touch-selection',
  'test-clipboard',
  'test-file-library',
  'test-files-ui',
  'test-learning-sign-in',
  'test-keyboard-recovery',
  'shell-transport-journeys',
  'test-native-gestures',
]);
export const scenarios = [
  ...standard.map((name) => ({ name, kind: 'standard' })),
  ...positional.map((name) => ({ name, kind: 'positional' })),
  ...['test-learning-sign-in', 'test-native-gestures'].map((name) => ({ name, kind: 'standard' })),
  { name: 'test-rtc-input-recovery', kind: 'environment' },
  { name: 'test-files-ui', kind: 'environment' },
  { name: 'test-learning-server', kind: 'learning' },
  { name: 'test-local-selection', kind: 'local' },
  { name: 'files-user-journeys', kind: 'environment' },
  { name: 'input-user-journeys', kind: 'environment' },
  { name: 'cluster-user-journeys', kind: 'cluster' },
  { name: 'shell-avail-cluster', kind: 'output-port' },
  { name: 'shell-user-journeys', kind: 'output' },
  { name: 'shell-transport-journeys', kind: 'output' },
  { name: 'smoke-streaming-product', kind: 'environment' },
  { name: 'test-streaming-package', kind: 'package', serial: true },
  { name: 'test-node-updater', kind: 'node' },
  { name: 'session-import/round-trip', kind: 'node' },
  { name: 'test-cluster-control-config', kind: 'environment' },
  { name: 'drive', kind: 'driver' },
].map((entry) => ({
  ...entry,
  pointer: touch.has(entry.name) ? 'touch' : 'mouse',
  serial: entry.serial || serial.has(entry.name),
  chrome89: chrome89.has(entry.name),
  group:
    entry.name.includes('cluster') || entry.name.includes('coordination') || entry.kind === 'node'
      ? 'cluster'
      : /files|file-library|camera|learning/.test(entry.name)
        ? 'files'
        : /input|keyboard|selection|clipboard|gesture|ime|context-menu/.test(entry.name)
          ? 'input'
          : 'shell',
}));
