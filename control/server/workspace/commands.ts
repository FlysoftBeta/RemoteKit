import { readWindowState } from '../../shared/persisted-window-state';
import { RemoteKitError } from '../../shared/errors';
import {
  DEAD_ZONE_MAX,
  isBuiltinApp,
  isLocalTab,
  isSingletonApp,
  placeTab,
  SEARCH_ENGINES,
  SITE_PERMISSIONS,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  type AppDefinition,
  type InstalledApp,
  type PageDialogReply,
  type ProductAction,
  type ProductActionResult,
  type ProductTab,
  type ProductWorkspace,
} from '../../shared/product';
import { resolveNavigation, resolveSearch } from '../navigation-url';
import { cleanUrl } from '../url-clean';
import {
  assertWindowMutable,
  findSpace,
  findTab,
  findWindow,
  focusWindow,
  placeWindow,
  replaceWindow,
  WORKSPACE_LIMITS,
} from './model';
import type { ExecutionContext } from './operations';
import { readClose, validatePageReply } from './page-requests';
import { ensureSite, pruneSite, validProtocol, validSiteOrigin } from './site-policy';
export type CommandEffect =
  | { kind: 'navigate'; tabId: string; url: string; previousKind: ProductTab['kind']; ctx?: ExecutionContext }
  | { kind: 'command'; tabId: string; command: string; ctx?: ExecutionContext }
  | { kind: 'closeWindow' }
  | { kind: 'closeTab'; tabId: string }
  | { kind: 'replyClose'; tabId: string; accept: boolean }
  | { kind: 'replyPage'; dialogId: string; reply: PageDialogReply }
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
    throw new RemoteKitError('invalid_request', '操作来源无效', { detail: 'Invalid action source' });
  let idIndex = 0;
  const now = ctx.now ?? Date.now();
  const nextId = () => ctx.ids[idIndex++];
  const tab = () => findTab(state, action.tabId);
  if (
    typeof action.tabId === 'string' &&
    tab().signIn &&
    action.type !== 'tab.activate' &&
    action.type !== 'tab.close'
  )
    throw new RemoteKitError('forbidden', '登录页面仅支持取消或关闭');
  const window = () => findWindow(state, action.windowId);
  const navigationUrl = (value: unknown, searchOnly = false) => {
    const resolve = searchOnly ? resolveSearch : resolveNavigation;
    return resolve(value, state.settings.browser.searchEngine);
  };
  const createTab = (windowId: string, address: string | undefined = action.url, searchOnly = false) => {
    assertWindowMutable(state, windowId);
    const target = findWindow(state, windowId);
    if (target.appId !== 'browser' && !target.appId.startsWith('web:'))
      throw new RemoteKitError('invalid_request', '此应用不支持标签页', {
        detail: 'This App does not support tabs',
      });
    if (target.appId.startsWith('web:') && state.tabs.some((tab) => tab.windowId === target.id))
      throw new RemoteKitError('conflict', '网页应用只能有一个标签页', {
        detail: 'Web Apps have exactly one tab',
      });
    if (state.tabs.length >= WORKSPACE_LIMITS.tabs)
      throw new RemoteKitError('limit_exceeded', '工作区最多支持 32 个标签页', {
        capacity: 'tabs',
        detail: 'The workspace supports up to 32 tabs',
      });
    const kind = address === undefined ? 'start' : 'remote';
    const next: ProductTab = {
      id: nextId(),
      idleKeepAlive: false,
      windowId,
      webviewId: ctx.viewId,
      kind,
      title: String(action.title ?? 'New tab').slice(0, 120),
      url: kind === 'remote' ? navigationUrl(address, searchOnly) : '',
      ...(action.source === 'launcher' ? { usageSource: 'launcher' as const } : {}),
    };
    state.tabs.push(next);
    target.activeTabId = next.id;
    focusWindow(state, windowId, now);
  };
  const closeWindows = (ids: string[]) => {
    if (state.pendingWindowCloseId || state.pendingClose || state.pendingWindowCloseIds?.length)
      throw new RemoteKitError('conflict', '请先处理待确认的关闭请求', {
        detail: 'Resolve the pending close request first',
      });
    state.pendingWindowCloseIds = [...ids];
    state.pendingWindowCloseId = state.pendingWindowCloseIds.shift() ?? null;
    if (state.pendingWindowCloseId) effects.push({ kind: 'closeWindow' });
  };
  const httpUrl = (value: unknown) => {
    if (typeof value !== 'string') throw new RemoteKitError('invalid_request', '网址格式无效');
    if (Buffer.byteLength(value, 'utf8') > 8192)
      throw new RemoteKitError('limit_exceeded', '网址超过 8192 字节', { capacity: 'field' });
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new RemoteKitError('invalid_request', '请输入 HTTP 或 HTTPS 网址', {
        detail: 'Enter an HTTP or HTTPS URL',
      });
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new RemoteKitError('invalid_request', '请输入 HTTP 或 HTTPS 网址', {
        detail: 'Enter an HTTP or HTTPS URL',
      });
    if (Buffer.byteLength(parsed.href, 'utf8') > 8192)
      throw new RemoteKitError('limit_exceeded', '网址编码后超过 8192 字节', { capacity: 'field' });
    return parsed.href;
  };
  const appDefinition = (value: AppDefinition): Omit<InstalledApp, 'id' | 'createdAt' | 'updatedAt'> => {
    if (typeof value.name === 'string' && value.name.length > 120)
      throw new RemoteKitError('limit_exceeded', '应用名称超过 120 字符', { capacity: 'field' });
    if (typeof value.name !== 'string' || !value.name.trim())
      throw new RemoteKitError('invalid_request', '应用名称应为 1 至 120 个字符', {
        detail: 'App names must contain 1 to 120 characters',
      });
    const startUrl = httpUrl(value.startUrl);
    const scope = httpUrl(value.scope ?? new URL('.', startUrl).href);
    if (new URL(scope).origin !== new URL(startUrl).origin || !startUrl.startsWith(scope))
      throw new RemoteKitError('invalid_request', '启动网址必须位于同源范围内', {
        detail: 'The start URL must be within the same-origin scope',
      });
    if (value.display !== undefined && !['standalone', 'browser'].includes(value.display))
      throw new RemoteKitError('invalid_request', '应用显示模式无效', { detail: 'Invalid App display mode' });
    if (value.themeColor !== undefined && !/^#[0-9a-f]{6}$/i.test(value.themeColor))
      throw new RemoteKitError('invalid_request', '主题颜色应为 #rrggbb 格式', {
        detail: 'Theme color must be #rrggbb',
      });
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
    if (!installed) throw new RemoteKitError('not_found', '应用不存在', { detail: 'App does not exist' });
    return installed;
  };
  let application: ProductActionResult['application'];
  let siteUaChanged = false;
  switch (action.type) {
    case 'window.open': {
      if (isSingletonApp(action.appId)) {
        const existing = state.windows.find((window) => window.appId === action.appId);
        if (existing) {
          focusWindow(state, existing.id, now);
          break;
        }
      }
      if (
        typeof action.appId !== 'string' ||
        (!isBuiltinApp(action.appId) && !action.appId.startsWith('web:'))
      )
        throw new RemoteKitError('invalid_request', '应用信息无效', { detail: 'Invalid App' });
      const installed = action.appId.startsWith('web:') ? app() : undefined;
      if (installed && installed.id === state.pendingAppUninstallId)
        throw new RemoteKitError('conflict', '应用正在卸载', { detail: 'The App is being uninstalled' });
      if (state.windows.length >= WORKSPACE_LIMITS.windows)
        throw new RemoteKitError('limit_exceeded', '工作区最多支持 16 个窗口', {
          capacity: 'windows',
          detail: 'The workspace supports up to 16 windows',
        });
      if (action.url !== undefined && !installed && action.appId !== 'browser')
        throw new RemoteKitError('invalid_request', '此应用不支持网址', {
          detail: 'This App does not support URLs',
        });
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
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RemoteKitError('invalid_request', '窗口状态必须是 JSON 对象', {
          detail: 'Window state must be a JSON object of at most 8 KiB',
        });
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 8192)
        throw new RemoteKitError('limit_exceeded', '窗口状态超过 8 KiB', { capacity: 'field' });
      window().state = readWindowState(value);
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
        throw new RemoteKitError('invalid_request', '参数值无效', { detail: 'Invalid value' });
      const sum = action.weights.reduce((total: number, weight: number) => total + weight, 0);
      if (!Number.isFinite(sum))
        throw new RemoteKitError('invalid_request', '参数值无效', { detail: 'Invalid value' });
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
      if (!url) throw new RemoteKitError('invalid_request', '网址格式无效', { detail: 'Invalid URL' });
      if (typeof action.title !== 'string' || action.title.length > 512)
        throw new RemoteKitError('invalid_request', '参数值无效', { detail: 'Invalid value' });
      const existing = state.favorites.find((favorite) => favorite.url === url);
      if (existing) existing.title = action.title;
      else state.favorites.push({ id: nextId(), url, title: action.title, createdAt: now });
      break;
    }
    case 'favorite.remove': {
      if (!state.favorites.some((favorite) => favorite.id === action.id))
        throw new RemoteKitError('not_found', '项目不存在', { detail: 'Item does not exist' });
      state.favorites = state.favorites.filter((favorite) => favorite.id !== action.id);
      break;
    }
    case 'tab.create':
      if (action.url !== undefined && action.query !== undefined)
        throw new RemoteKitError('invalid_request', '网址和搜索内容不能同时提供', {
          detail: 'URL and query are mutually exclusive',
        });
      createTab(
        window().id,
        action.query === undefined ? action.url : action.query,
        action.query !== undefined,
      );
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
        throw new RemoteKitError('invalid_request', '标签页只能在浏览器窗口之间移动', {
          detail: 'Tabs can only move between browser windows',
        });
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
        throw new RemoteKitError(
          t.lifecycleRecoveryError ? 'unavailable' : 'busy',
          t.lifecycleRecoveryError?.message ?? '页面正在恢复',
        );
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
        throw new RemoteKitError(
          t.lifecycleRecoveryError ? 'unavailable' : 'busy',
          t.lifecycleRecoveryError?.message ?? '页面正在恢复',
        );
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
        !action.dialogId ||
        Object.keys(action).some((key) => !['type', 'dialogId', 'reply'].includes(key))
      )
        throw new RemoteKitError('invalid_request', '无效的页面对话回复');
      validatePageReply(action.reply);
      effects.push({
        kind: 'replyPage',
        dialogId: action.dialogId,
        reply: action.reply,
      });
      break;
    }
    case 'page.exitFullscreen': {
      effects.push({ kind: 'exitFullscreen', target: action.target });
      break;
    }
    case 'tab.setIdleKeepAlive': {
      if (typeof action.enabled !== 'boolean')
        throw new RemoteKitError('invalid_request', '挂机模式设置无效');
      const target = tab();
      if (isLocalTab(target)) throw new RemoteKitError('conflict', '请先打开网页');
      if (target.idleKeepAlive === action.enabled) break;
      target.idleKeepAlive = action.enabled;
      delete target.idleKeepAliveOutcome;
      if (action.enabled) target.idleKeepAliveState = { enabledAt: now };
      else delete target.idleKeepAliveState;
      break;
    }
    case 'tab.ackIdleKeepAliveOutcome': {
      const target = tab();
      if (
        target.idleKeepAliveOutcome?.at === action.at &&
        target.idleKeepAliveOutcome?.returnedAt === action.returnedAt
      )
        delete target.idleKeepAliveOutcome;
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
        throw new RemoteKitError('invalid_request', '项目不存在', { detail: 'Item does not exist' });
      const browser = value.browser;
      if (browser !== undefined) {
        if (
          !browser ||
          typeof browser !== 'object' ||
          Array.isArray(browser) ||
          Object.keys(browser).some((key) => !['searchEngine'].includes(key))
        )
          throw new RemoteKitError('invalid_request', '设置格式无效', { detail: 'Invalid settings' });
        if (
          'searchEngine' in browser &&
          !SEARCH_ENGINES.some((engine) => engine.value === browser.searchEngine)
        )
          throw new RemoteKitError('invalid_request', '参数值无效', { detail: 'Invalid value' });
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
              'autoKeyboard',
              'clipboardSync',
              'avSync',
            ].includes(key),
        )
      )
        throw new RemoteKitError('invalid_request', '设置格式无效', { detail: 'Invalid settings' });
      if ('autoKeyboard' in workspaceSettings && typeof workspaceSettings.autoKeyboard !== 'boolean')
        throw new RemoteKitError('invalid_request', '参数值无效', { detail: 'Invalid value' });
      if ('clipboardSync' in workspaceSettings && typeof workspaceSettings.clipboardSync !== 'boolean')
        throw new RemoteKitError('invalid_request', '无效的剪贴板同步设置');
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
    case 'site.permission':
    case 'site.protocolHandler.remove':
    case 'site.permissions.reset': {
      const keys =
        action.type === 'site.permission'
          ? ['type', 'origin', 'permission', 'setting']
          : action.type === 'site.protocolHandler.remove'
            ? ['type', 'origin', 'protocol']
            : ['type', 'origin'];
      if (
        !validSiteOrigin(action.origin) ||
        Object.keys(action).some((key) => !keys.includes(key)) ||
        (action.type === 'site.permission' &&
          (!SITE_PERMISSIONS.includes(action.permission) ||
            !['ask', 'allow', 'block'].includes(action.setting))) ||
        (action.type === 'site.protocolHandler.remove' && !validProtocol(action.protocol))
      )
        throw new RemoteKitError('invalid_request', '无效的网站权限设置');
      const site =
        action.type === 'site.permission' && action.setting !== 'ask'
          ? ensureSite(state, action.origin)
          : state.sites[action.origin];
      if (site) {
        if (action.type === 'site.permission') {
          if (action.setting === 'ask')
            delete site.permissions?.[action.permission as keyof NonNullable<typeof site.permissions>];
          else
            (site.permissions ??= {})[action.permission as keyof NonNullable<typeof site.permissions>] =
              action.setting;
        } else if (action.type === 'site.protocolHandler.remove') {
          site.protocolHandlers = site.protocolHandlers?.filter(
            (handler) => handler.protocol !== action.protocol,
          );
        } else {
          delete site.permissions;
          delete site.protocolHandlers;
        }
        pruneSite(state, action.origin);
      }
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
      if (
        typeof action.tabletUa !== 'boolean' ||
        Object.keys(action).some((key) => !['type', 'origin', 'tabId', 'tabletUa'].includes(key))
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
        throw new RemoteKitError('limit_exceeded', '站点设置已达上限', { capacity: 'site-settings' });
      const previous = state.sites[origin] ?? { tabletUa: false };
      siteUaChanged = !!previous.tabletUa !== action.tabletUa;
      state.sites[origin] = {
        ...previous,
        tabletUa: action.tabletUa,
      };
      pruneSite(state, origin);
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
