import {
  array,
  corruptRecord,
  literal,
  object,
  string,
  union,
  type Codec,
} from '../server/persistence/codec';

const identifier = string({ pattern: /^[a-zA-Z0-9_:-]{1,132}$/ });
const sourceShape = object({ app: identifier, channel: string({ max: 259 }) });
const source: typeof sourceShape = {
  read(value, path) {
    const result = sourceShape.read(value, path);
    if (result.app !== 'download' && result.channel.length > 253)
      throw new Error(`${path} expected bounded source channel`);
    return result;
  },
};
export const filesView = union(
  literal('all', 'recent', 'clipboard', 'settings'),
  object({ partition: identifier }),
  object({ source }),
);
const launchShape = object({ requestId: identifier }, { entryId: identifier, view: filesView });
export const filesLaunch: typeof launchShape = {
  read(value, path) {
    const launch = launchShape.read(value, path);
    if (launch.entryId === undefined && launch.view === undefined)
      throw new Error(`${path} expected entryId or view`);
    return launch;
  },
};
const tabId = string({ pattern: /^[a-z0-9]{8}$/ });
const filesTab = union(
  object({ id: tabId, kind: literal('library'), view: filesView, query: string({ max: 256 }) }),
  object({ id: tabId, kind: literal('document'), entryId: identifier }, { from: filesView }),
);
const filesShape = object(
  { tabs: array(filesTab, { min: 1, max: 16 }), activeTabId: tabId, layout: literal('grid', 'list') },
  { launch: filesLaunch },
);
export const filesState: typeof filesShape = {
  read(value, path) {
    const state = filesShape.read(value, path);
    const ids = new Set(state.tabs.map((tab) => tab.id));
    if (ids.size !== state.tabs.length || !ids.has(state.activeTabId))
      throw new Error(`${path} expected unique tabs and an active tab`);
    return state;
  },
};
const stateShape = union(
  filesState,
  object({
    section: literal(
      'appearance',
      'media',
      'input',
      'security',
      'apps',
      'import',
      'diagnostics',
      'announcements',
      'account',
      'overview',
      'users',
      'nodes',
      'storage',
    ),
  }),
  object({}, { launch: filesLaunch }),
);
export const windowState: Codec<Record<string, unknown>> = {
  read(value, path) {
    const state = stateShape.read(value, path);
    if (new TextEncoder().encode(JSON.stringify(state)).length > 8192)
      throw new Error(`${path} expected at most 8192 bytes`);
    return state;
  },
};
export function readWindowState(value: unknown): Record<string, unknown> {
  try {
    return windowState.read(value, '$');
  } catch (error) {
    throw corruptRecord('workspace_windows.state', error);
  }
}
