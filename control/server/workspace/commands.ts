import { RemoteKitError } from '../../shared/errors';
import {
  isLocalTab,
  DEAD_ZONE_MAX,
  SEARCH_ENGINES,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  type ProductAction,
  type ProductActionResult,
  type ProductTab,
  type ProductWorkspace,
} from '../../shared/product';
import { resolveNavigation } from '../navigation-url';
import { findTab, findWindow, reservesFilesTab, WORKSPACE_LIMITS } from './model';
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
}
export function applyCommand(workspace: ProductWorkspace, body: ProductAction, ctx: CommandContext) {
  const state = structuredClone(workspace),
    action = body as any;
  const effects: CommandEffect[] = [];
  let idIndex = 0;
  const tab = () => findTab(state, action.tabId);
  const window = () => findWindow(state, action.windowId);
  const navigationUrl = (value: unknown) => {
    try {
      return resolveNavigation(value, state.settings.searchEngine);
    } catch (error) {
      throw new RemoteKitError(
        'invalid_request',
        error instanceof Error ? error.message : '无效网址或搜索内容',
      );
    }
  };
  const createTab = (windowId: string, files = false) => {
    if (state.tabs.length >= WORKSPACE_LIMITS.tabs)
      throw new RemoteKitError('limit_exceeded', '最多支持32个标签页');
    const kind = files ? 'files' : action.url === undefined ? 'start' : 'remote';
    const next: ProductTab = {
      id: ctx.ids[idIndex++],
      windowId,
      webviewId: ctx.viewId,
      kind,
      title: files ? '我的文件' : String(action.title ?? '新标签页').slice(0, 120),
      url: kind === 'remote' ? navigationUrl(action.url) : '',
    };
    state.tabs.push(next);
    state.windows.find((w) => w.id === windowId)!.activeTabId = next.id;
    state.activeWindowId = windowId;
  };
  let application: ProductActionResult['application'];
  let siteUaChanged = false;
  switch (action.type) {
    case 'window.create': {
      if (state.windows.length >= WORKSPACE_LIMITS.windows)
        throw new RemoteKitError('limit_exceeded', '最多支持8个窗口');
      const id = ctx.ids[idIndex++];
      state.windows.push({ id, activeTabId: null, weight: 1 });
      createTab(id);
      break;
    }
    case 'window.activate':
      state.activeWindowId = window().id;
      break;
    case 'window.layout': {
      if (!['side-by-side', 'focused'].includes(action.mode))
        throw new RemoteKitError('invalid_request', '无效的窗口布局');
      state.layoutMode = action.mode;
      if (action.weights !== undefined) {
        if (
          !Array.isArray(action.weights) ||
          action.weights.length > 8 ||
          new Set(action.weights.map((w: any) => w.windowId)).size !== action.weights.length
        )
          throw new RemoteKitError('invalid_request', '无效的窗口比例');
        for (const entry of action.weights) {
          const w = state.windows.find((w) => w.id === entry.windowId);
          if (
            !w ||
            typeof entry.weight !== 'number' ||
            !Number.isFinite(entry.weight) ||
            entry.weight < 0.1 ||
            entry.weight > 10
          )
            throw new RemoteKitError('invalid_request', '无效的窗口比例');
          w.weight = entry.weight;
        }
      }
      break;
    }
    case 'window.close': {
      const w = window();
      if (state.pendingWindowCloseId && state.pendingWindowCloseId !== w.id)
        throw new RemoteKitError('conflict', '请先处理当前关闭请求');
      state.pendingWindowCloseId = w.id;
      effects.push({ kind: 'closeWindow' });
      break;
    }
    case 'tab.create':
      createTab(window().id);
      break;
    case 'tab.files': {
      const target = window(),
        existing = state.tabs.find((tab) => tab.windowId === target.id && reservesFilesTab(tab));
      if (existing) {
        target.activeTabId = existing.id;
        state.activeWindowId = target.id;
      } else createTab(target.id, true);
      break;
    }
    case 'tab.activate': {
      const t = tab();
      state.windows.find((w) => w.id === t.windowId)!.activeTabId = t.id;
      state.activeWindowId = t.windowId;
      break;
    }
    case 'tab.move': {
      const t = tab(),
        target = window(),
        old = state.windows.find((w) => w.id === t.windowId)!;
      if (
        reservesFilesTab(t) &&
        state.tabs.some(
          (other) => other.id !== t.id && other.windowId === target.id && reservesFilesTab(other),
        )
      )
        throw new RemoteKitError('conflict', '目标窗口已打开我的文件');
      t.windowId = target.id;
      if (old.activeTabId === t.id)
        old.activeTabId = state.tabs.find((item) => item.windowId === old.id)?.id ?? null;
      target.activeTabId = t.id;
      state.activeWindowId = target.id;
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
        Object.keys(value).some(
          (k) =>
            ![
              'qualityPreference',
              'uiScale',
              'topDeadZone',
              'memorySaverEnabled',
              'showStats',
              'audioChannels',
              'searchEngine',
              'autoFullscreen',
              'avSync',
            ].includes(k),
        )
      )
        throw new RemoteKitError('invalid_request', '无效的设置');
      if ('searchEngine' in value && !SEARCH_ENGINES.some((engine) => engine.value === value.searchEngine))
        throw new RemoteKitError('invalid_request', '无效的搜索引擎');
      if ('qualityPreference' in value && !['quality', 'auto', 'smooth'].includes(value.qualityPreference))
        throw new RemoteKitError('invalid_request', '无效的画面质量');
      if (
        'uiScale' in value &&
        (typeof value.uiScale !== 'number' ||
          !Number.isFinite(value.uiScale) ||
          value.uiScale < UI_SCALE_MIN ||
          value.uiScale > UI_SCALE_MAX)
      )
        throw new RemoteKitError('invalid_request', `界面缩放需在 ${UI_SCALE_MIN}–${UI_SCALE_MAX} 之间`);
      if (
        'topDeadZone' in value &&
        value.topDeadZone !== 'off' &&
        value.topDeadZone !== 'auto' &&
        (typeof value.topDeadZone !== 'number' ||
          !Number.isInteger(value.topDeadZone) ||
          value.topDeadZone < 1 ||
          value.topDeadZone > DEAD_ZONE_MAX)
      )
        throw new RemoteKitError('invalid_request', `顶部留空需为 1–${DEAD_ZONE_MAX} px`);
      if ('memorySaverEnabled' in value && typeof value.memorySaverEnabled !== 'boolean')
        throw new RemoteKitError('invalid_request', '无效的内存设置');
      if ('avSync' in value && typeof value.avSync !== 'boolean')
        throw new RemoteKitError('invalid_request', '无效的音视频同步设置');
      if ('autoFullscreen' in value && typeof value.autoFullscreen !== 'boolean')
        throw new RemoteKitError('invalid_request', '无效的全屏设置');
      if (
        'audioChannels' in value &&
        (!value.audioChannels ||
          typeof value.audioChannels !== 'object' ||
          Array.isArray(value.audioChannels) ||
          Object.keys(value.audioChannels).length !== 2 ||
          typeof value.audioChannels.left !== 'boolean' ||
          typeof value.audioChannels.right !== 'boolean')
      )
        throw new RemoteKitError('invalid_request', '声道设置需同时提供左右开关');
      if ('showStats' in value && typeof value.showStats !== 'boolean')
        throw new RemoteKitError('invalid_request', '无效的统计设置');
      Object.assign(state.settings, value);
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
