import { cleanUrl } from '../url-clean';
import { RemoteKitError } from '../../shared/errors';
import {
  isLocalTab,
  placeTab,
  DEAD_ZONE_MAX,
  SEARCH_ENGINES,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  type ProductAction,
  type ProductActionResult,
  type ProductTab,
  type ProductWorkspace,
  type InstalledApp,
  type AppDefinition,
} from '../../shared/product';
import { resolveNavigation } from '../navigation-url';
import {
  assertWindowMutable,
  findTab,
  findWindow,
  findSpace,
  focusWindow,
  placeWindow,
  replaceWindow,
  WORKSPACE_LIMITS,
} from './model';
import type { ExecutionContext } from './operations';
import { readClose } from './page-requests';
export type CommandEffect =
  | { kind: 'navigate'; tabId: string; url: string; previousKind: ProductTab['kind']; ctx?: ExecutionContext }
  | { kind: 'command'; tabId: string; command: string; ctx?: ExecutionContext }
  | { kind: 'closeWindow' }
  | { kind: 'closeTab'; tabId: string }
  | { kind: 'replyClose'; tabId: string; accept: boolean }
  | { kind: 'replyPage'; dialogId: string; accept: boolean; text?: string }
  | { kind: 'exitFullscreen'; target: string };
export interface CommandContext {
  execution?: ExecutionContext;
  browserIncarnation?: string;
  ids: readonly string[];
  viewId: string;
  now?: number;
  appIcon?: { hash: string };
}
export function applyCommand(workspace: ProductWorkspace, body: ProductAction, ctx: CommandContext) {
  const state = structuredClone(workspace),
    action = body as any;
  const effects: CommandEffect[] = [];
  if (action.source !== undefined && action.source !== 'launcher')
    throw new RemoteKitError('invalid_request', 'Invalid action source');
  let idIndex = 0;
  const now = ctx.now ?? Date.now();
  const nextId = () => ctx.ids[idIndex++];
  const tab = () => findTab(state, action.tabId);
  const window = () => findWindow(state, action.windowId);
  const navigationUrl = (value: unknown) => {
    try {
      return resolveNavigation(value, state.settings.browser.searchEngine);
    } catch (error) {
      throw new RemoteKitError(
        'invalid_request',
        error instanceof Error ? error.message : '无效网址或搜索内容',
      );
    }
  };
  const createTab = (windowId: string, address: string | undefined = action.url) => {
    assertWindowMutable(state, windowId);
    const target = findWindow(state, windowId);
    if (target.appId !== 'browser' && !target.appId.startsWith('web:'))
      throw new RemoteKitError('invalid_request', 'This App does not support tabs');
    if (target.appId.startsWith('web:') && state.tabs.some((tab) => tab.windowId === target.id))
      throw new RemoteKitError('conflict', 'Web Apps have exactly one tab');
    if (state.tabs.length >= WORKSPACE_LIMITS.tabs)
      throw new RemoteKitError('limit_exceeded', 'The workspace supports up to 32 tabs');
    const kind = address === undefined ? 'start' : 'remote';
    const next: ProductTab = {
      id: nextId(),
      windowId,
      webviewId: ctx.viewId,
      kind,
      title: String(action.title ?? 'New tab').slice(0, 120),
      url: kind === 'remote' ? navigationUrl(address) : '',
      ...(action.source === 'launcher' ? { usageSource: 'launcher' as const } : {}),
    };
    state.tabs.push(next);
    target.activeTabId = next.id;
    focusWindow(state, windowId, now);
  };
  const closeWindows = (ids: string[]) => {
    if (state.pendingWindowCloseId || state.pendingClose || state.pendingWindowCloseIds?.length)
      throw new RemoteKitError('conflict', 'Resolve the pending close request first');
    state.pendingWindowCloseIds = [...ids];
    state.pendingWindowCloseId = state.pendingWindowCloseIds.shift() ?? null;
    if (state.pendingWindowCloseId) effects.push({ kind: 'closeWindow' });
  };
  const httpUrl = (value: unknown) => {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 8192)
      throw new RemoteKitError('invalid_request', 'Invalid URL');
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new RemoteKitError('invalid_request', 'Enter an HTTP or HTTPS URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new RemoteKitError('invalid_request', 'Enter an HTTP or HTTPS URL');
    return parsed.href;
  };
  const appDefinition = (value: AppDefinition): Omit<InstalledApp, 'id' | 'createdAt' | 'updatedAt'> => {
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120)
      throw new RemoteKitError('invalid_request', 'App names must contain 1 to 120 characters');
    const startUrl = httpUrl(value.startUrl);
    const scope = httpUrl(value.scope ?? new URL('.', startUrl).href);
    if (new URL(scope).origin !== new URL(startUrl).origin || !startUrl.startsWith(scope))
      throw new RemoteKitError('invalid_request', 'The start URL must be within the same-origin scope');
    if (value.display !== undefined && !['standalone', 'browser'].includes(value.display))
      throw new RemoteKitError('invalid_request', 'Invalid App display mode');
    if (value.themeColor !== undefined && !/^#[0-9a-f]{6}$/i.test(value.themeColor))
      throw new RemoteKitError('invalid_request', 'Theme color must be #rrggbb');
    return {
      name: value.name.trim(),
      startUrl,
      scope,
      display: value.display ?? 'standalone',
      ...(value.themeColor ? { themeColor: value.themeColor.toLowerCase() } : {}),
    };
  };
  const app = () => {
    const installed = state.apps.find((item) => `web:${item.id}` === action.appId);
    if (!installed) throw new RemoteKitError('not_found', 'App does not exist');
    return installed;
  };
  let application: ProductActionResult['application'];
  let siteUaChanged = false;
  switch (action.type) {
    case 'window.open': {
      if (action.appId === 'settings') {
        const existing = state.windows.find((window) => window.appId === 'settings');
        if (existing) {
          focusWindow(state, existing.id, now);
          break;
        }
      }
      if (
        typeof action.appId !== 'string' ||
        (!['browser', 'files', 'settings'].includes(action.appId) && !action.appId.startsWith('web:'))
      )
        throw new RemoteKitError('invalid_request', 'Invalid App');
      const installed = action.appId.startsWith('web:') ? app() : undefined;
      if (installed && installed.id === state.pendingAppUninstallId)
        throw new RemoteKitError('conflict', 'The App is being uninstalled');
      if (state.windows.length >= WORKSPACE_LIMITS.windows)
        throw new RemoteKitError('limit_exceeded', 'The workspace supports up to 16 windows');
      if (action.url !== undefined && !installed && action.appId !== 'browser')
        throw new RemoteKitError('invalid_request', 'This App does not support URLs');
      const id = nextId();
      state.windows.push({ id, appId: action.appId, activeTabId: null, lastActiveAt: now });
      if (action.placement?.mode === 'replace')
        replaceWindow(state, id, action.placement.windowId, nextId(), now);
      else placeWindow(state, id, action.placement, nextId(), now);
      if (installed || action.appId === 'browser') createTab(id, action.url ?? installed?.startUrl);
      break;
    }
    case 'window.focus':
      focusWindow(state, window().id, now);
      break;
    case 'window.place':
      placeWindow(state, window().id, action.placement, nextId(), now);
      break;
    case 'window.state': {
      const value = action.state;
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Buffer.byteLength(JSON.stringify(value), 'utf8') > 4096
      )
        throw new RemoteKitError('invalid_request', 'Window state must be a JSON object of at most 4 KiB');
      window().state = structuredClone(value);
      break;
    }
    case 'space.activate': {
      const space = findSpace(state, action.spaceId);
      if (space.focusedWindowId) focusWindow(state, space.focusedWindowId, now);
      break;
    }
    case 'space.layout': {
      const space = findSpace(state, action.spaceId);
      if (
        !Array.isArray(action.weights) ||
        action.weights.length !== space.windowIds.length ||
        action.weights.some(
          (weight: unknown) => typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0,
        )
      )
        throw new RemoteKitError('invalid_request', 'Invalid value');
      const sum = action.weights.reduce((total: number, weight: number) => total + weight, 0);
      if (!Number.isFinite(sum)) throw new RemoteKitError('invalid_request', 'Invalid value');
      space.weights = action.weights.map((weight: number) => weight / sum);
      break;
    }
    case 'window.close':
      closeWindows([window().id]);
      break;
    case 'space.close':
      closeWindows(findSpace(state, action.spaceId).windowIds);
      break;
    case 'app.install': {
      const id = nextId();
      state.apps.push({
        id,
        ...appDefinition(action),
        createdAt: now,
        updatedAt: now,
        ...(ctx.appIcon
          ? { iconHash: ctx.appIcon.hash, iconUrl: `/api/apps/${id}/icon?h=${ctx.appIcon.hash}` }
          : {}),
      });
      break;
    }
    case 'app.update': {
      const installed = app();
      Object.assign(installed, appDefinition({ ...installed, ...action }), { updatedAt: now });
      if (ctx.appIcon) {
        installed.iconHash = ctx.appIcon.hash;
        installed.iconUrl = `/api/apps/${installed.id}/icon?h=${ctx.appIcon.hash}`;
      }
      break;
    }
    case 'app.uninstall': {
      const installed = app();
      const ids = state.windows.filter((window) => window.appId === action.appId).map((window) => window.id);
      if (ids.length) {
        closeWindows(ids);
        state.pendingAppUninstallId = installed.id;
      } else state.apps = state.apps.filter((item) => item !== installed);
      break;
    }
    case 'favorite.add': {
      const url = cleanUrl(httpUrl(action.url));
      if (!url) throw new RemoteKitError('invalid_request', 'Invalid URL');
      if (typeof action.title !== 'string' || action.title.length > 512)
        throw new RemoteKitError('invalid_request', 'Invalid value');
      const existing = state.favorites.find((favorite) => favorite.url === url);
      if (existing) existing.title = action.title;
      else state.favorites.push({ id: nextId(), url, title: action.title, createdAt: now });
      break;
    }
    case 'favorite.remove': {
      if (!state.favorites.some((favorite) => favorite.id === action.id))
        throw new RemoteKitError('not_found', 'Item does not exist');
      state.favorites = state.favorites.filter((favorite) => favorite.id !== action.id);
      break;
    }
    case 'tab.create':
      createTab(window().id);
      break;
    case 'tab.activate': {
      const t = tab();
      findWindow(state, t.windowId).activeTabId = t.id;
      focusWindow(state, t.windowId, now);
      break;
    }
    case 'tab.move': {
      const t = tab();
      const target = window();
      const old = findWindow(state, t.windowId);
      assertWindowMutable(state, old.id);
      assertWindowMutable(state, target.id);
      if (old.appId !== 'browser' || target.appId !== 'browser')
        throw new RemoteKitError('invalid_request', 'Tabs can only move between browser windows');
      if (action.index !== undefined && !(Number.isInteger(action.index) && action.index >= 0))
        throw new RemoteKitError('invalid_request', '无效的标签页位置');
      placeTab(state.tabs, t.id, target.id, action.index);
      if (old !== target && old.activeTabId === t.id)
        old.activeTabId = state.tabs.find((item) => item.windowId === old.id)?.id ?? null;
      target.activeTabId = t.id;
      focusWindow(state, target.id, now);
      break;
    }
    case 'tab.navigate': {
      const t = tab(),
        address = navigationUrl(action.url),
        previousKind = t.kind ?? 'remote';
      if (t.lifecycleRecovery || t.lifecycleRecoveryError)
        throw new RemoteKitError('conflict', t.lifecycleRecoveryError ?? '页面正在恢复');
      if (ctx.execution) {
        t.navigation = {
          operationId: ctx.execution.operationId,
          operationGeneration: ctx.execution.operationGeneration,
          status: 'applying',
          browserIncarnation: ctx.browserIncarnation,
          previousUrl: t.url,
          previousKind,
        };
        t.kind = 'remote';
        application = { status: 'pending', reason: '导航已受理，等待页面确认' };
      }
      t.pendingUrl = address;
      if (action.source === 'launcher') t.usageSource = 'launcher';
      effects.push({ kind: 'navigate', tabId: t.id, url: address, previousKind, ctx: ctx.execution });
      break;
    }
    case 'tab.command': {
      const t = tab();
      if (!['back', 'forward', 'reload', 'stop'].includes(action.command))
        throw new RemoteKitError('invalid_request', '未知导航命令');
      if (isLocalTab(t)) break;
      if (t.lifecycleRecovery || t.lifecycleRecoveryError)
        throw new RemoteKitError('conflict', t.lifecycleRecoveryError ?? '页面正在恢复');
      if (ctx.execution && action.command !== 'stop')
        t.navigation = {
          operationId: ctx.execution.operationId,
          operationGeneration: ctx.execution.operationGeneration,
          status: 'applying',
          browserIncarnation: ctx.browserIncarnation,
          previousUrl: t.url,
          previousKind: t.kind ?? 'remote',
        };
      effects.push({ kind: 'command', tabId: t.id, command: action.command, ctx: ctx.execution });
      if (ctx.execution) application = { status: 'pending', reason: '导航命令已受理，等待页面确认' };
      break;
    }
    case 'tab.close': {
      const t = tab();
      if (action.confirm === true || action.cancel === true) {
        const close = readClose(state.pendingClose, t.webviewId);
        if (
          close.phase !== 'awaitingUser' ||
          close.tabId !== t.id ||
          !action.requestId ||
          close.requestId !== action.requestId
        )
          throw new RemoteKitError('conflict', '关闭请求已失效');
        effects.push({ kind: 'replyClose', tabId: t.id, accept: action.confirm === true });
      } else effects.push({ kind: 'closeTab', tabId: t.id });
      break;
    }
    case 'page.reply': {
      if (
        typeof action.dialogId !== 'string' ||
        typeof action.accept !== 'boolean' ||
        (action.text !== undefined &&
          (typeof action.text !== 'string' || Buffer.byteLength(action.text, 'utf8') > 16384))
      )
        throw new RemoteKitError('invalid_request', '无效的页面对话回复');
      effects.push({
        kind: 'replyPage',
        dialogId: action.dialogId,
        accept: action.accept,
        text: action.text,
      });
      break;
    }
    case 'page.exitFullscreen': {
      effects.push({ kind: 'exitFullscreen', target: action.target });
      break;
    }
    case 'settings.update': {
      const value = action.settings;
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !['workspace', 'browser'].includes(key))
      )
        throw new RemoteKitError('invalid_request', 'Item does not exist');
      const browser = value.browser;
      if (browser !== undefined) {
        if (
          !browser ||
          typeof browser !== 'object' ||
          Array.isArray(browser) ||
          Object.keys(browser).some((key) => !['searchEngine', 'memorySaverEnabled'].includes(key))
        )
          throw new RemoteKitError('invalid_request', 'Invalid settings');
        if (
          'searchEngine' in browser &&
          !SEARCH_ENGINES.some((engine) => engine.value === browser.searchEngine)
        )
          throw new RemoteKitError('invalid_request', 'Invalid value');
        if ('memorySaverEnabled' in browser && typeof browser.memorySaverEnabled !== 'boolean')
          throw new RemoteKitError('invalid_request', 'Invalid value');
        Object.assign(state.settings.browser, browser);
      }
      if (value.workspace === undefined) break;
      const workspaceSettings = value.workspace;
      if (
        !workspaceSettings ||
        typeof workspaceSettings !== 'object' ||
        Array.isArray(workspaceSettings) ||
        Object.keys(workspaceSettings).some(
          (key) =>
            ![
              'qualityPreference',
              'uiScale',
              'topDeadZone',
              'showStats',
              'audioChannels',
              'autoFullscreen',
              'avSync',
            ].includes(key),
        )
      )
        throw new RemoteKitError('invalid_request', 'Invalid settings');
      if (
        'qualityPreference' in workspaceSettings &&
        !['quality', 'auto', 'smooth'].includes(workspaceSettings.qualityPreference)
      )
        throw new RemoteKitError('invalid_request', '无效的画面质量');
      if (
        'uiScale' in workspaceSettings &&
        (typeof workspaceSettings.uiScale !== 'number' ||
          !Number.isFinite(workspaceSettings.uiScale) ||
          workspaceSettings.uiScale < UI_SCALE_MIN ||
          workspaceSettings.uiScale > UI_SCALE_MAX)
      )
        throw new RemoteKitError('invalid_request', `界面缩放需在 ${UI_SCALE_MIN}–${UI_SCALE_MAX} 之间`);
      if (
        'topDeadZone' in workspaceSettings &&
        workspaceSettings.topDeadZone !== 'off' &&
        workspaceSettings.topDeadZone !== 'auto' &&
        (typeof workspaceSettings.topDeadZone !== 'number' ||
          !Number.isInteger(workspaceSettings.topDeadZone) ||
          workspaceSettings.topDeadZone < 1 ||
          workspaceSettings.topDeadZone > DEAD_ZONE_MAX)
      )
        throw new RemoteKitError('invalid_request', `顶部留空需为 1–${DEAD_ZONE_MAX} px`);
      if ('avSync' in workspaceSettings && typeof workspaceSettings.avSync !== 'boolean')
        throw new RemoteKitError('invalid_request', '无效的音视频同步设置');
      if ('autoFullscreen' in workspaceSettings && typeof workspaceSettings.autoFullscreen !== 'boolean')
        throw new RemoteKitError('invalid_request', '无效的全屏设置');
      if (
        'audioChannels' in workspaceSettings &&
        (!workspaceSettings.audioChannels ||
          typeof workspaceSettings.audioChannels !== 'object' ||
          Array.isArray(workspaceSettings.audioChannels) ||
          Object.keys(workspaceSettings.audioChannels).length !== 2 ||
          typeof workspaceSettings.audioChannels.left !== 'boolean' ||
          typeof workspaceSettings.audioChannels.right !== 'boolean')
      )
        throw new RemoteKitError('invalid_request', '声道设置需同时提供左右开关');
      if ('showStats' in workspaceSettings && typeof workspaceSettings.showStats !== 'boolean')
        throw new RemoteKitError('invalid_request', '无效的统计设置');
      Object.assign(state.settings.workspace, workspaceSettings);
      break;
    }
    case 'site.set': {
      let origin: string;
      try {
        const parsed = new URL(action.origin);
        if (
          !['http:', 'https:'].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.origin.length > 2048
        )
          throw new RemoteKitError('invalid_request', '无效输入');
        origin = parsed.origin;
      } catch {
        throw new RemoteKitError('invalid_request', '站点需有效HTTP(S) origin，最长2048字符');
      }
      const hasTabletUa = Object.prototype.hasOwnProperty.call(action, 'tabletUa');
      const hasManualKeyboard = Object.prototype.hasOwnProperty.call(action, 'manualKeyboard');
      if (
        (!hasTabletUa && !hasManualKeyboard) ||
        (hasTabletUa && typeof action.tabletUa !== 'boolean') ||
        (hasManualKeyboard && typeof action.manualKeyboard !== 'boolean') ||
        Object.keys(action).some(
          (key) => !['type', 'origin', 'tabId', 'tabletUa', 'manualKeyboard'].includes(key),
        )
      ) {
        throw new RemoteKitError('invalid_request', '无效的站点设置');
      }
      let target: ProductTab | undefined;
      if (action.tabId !== undefined) {
        target = tab();
        if (!URL.canParse(target.url) || new URL(target.url).origin !== origin)
          throw new RemoteKitError('invalid_request', '标签页不属于该站点');
      }
      if (!(origin in state.sites) && Object.keys(state.sites).length >= WORKSPACE_LIMITS.sites)
        throw new RemoteKitError('limit_exceeded', '站点设置已达上限');
      const previous = state.sites[origin] ?? { tabletUa: false };
      siteUaChanged = hasTabletUa && previous.tabletUa !== action.tabletUa;
      state.sites[origin] = {
        ...previous,
        ...(hasTabletUa ? { tabletUa: action.tabletUa } : {}),
        ...(hasManualKeyboard ? { manualKeyboard: action.manualKeyboard } : {}),
      };
      if (siteUaChanged) {
        if (target) target.pendingUaReloadOrigin = origin;
        application = { status: 'pending', reason: '设置已保存，正在应用站点身份' };
      }
      break;
    }
    default:
      throw new RemoteKitError('invalid_request', '未知产品操作');
  }
  return { workspace: state, effects, application, siteUaChanged };
}
