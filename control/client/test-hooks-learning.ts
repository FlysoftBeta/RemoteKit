import { ControlSession } from './control/control-session';
import { OperationsStore } from './control/operations-store';
import { AuthorizationScope } from './auth/authorization-scope';
import { RtcSession } from './rtc/rtc-session';
import { FileChannel } from './files/file-channel';
import type { ProductAction, ProductState } from '../shared/product';
import type { AuthState } from '../shared/security';
import type { LearningProvider } from '../shared/learning';
import {
  LearningFakeTransport,
  learningProductFixture,
  documentFixture,
} from './test-hooks-learning-fixtures';

declare global {
  interface Window {
    __remotekitLearning: {
      configure(app: 'study' | 'questions', signed: boolean): void;
      scenario(value: 'normal' | 'empty' | 'error' | 'expired' | 'verification'): void;
      calls(): unknown[];
      geometries(): unknown[];
    };
  }
}
type SessionCallbacks = {
  status(value: string): void;
  auth(value: AuthState): void;
  state(value: ProductState): void;
};

export function installLearningMock() {
  const fake = new LearningFakeTransport();
  const params = new URLSearchParams(location.search);
  fake.state = learningProductFixture(
    params.get('learningMock') === 'questions' ? 'questions' : 'study',
    params.get('signed') !== 'out',
  );
  const callbacks = new Set<SessionCallbacks>();
  const stores = new Set<OperationsStore>();
  const geometries: unknown[] = [];
  const publish = () => {
    fake.state.snapshotSequence = (fake.state.snapshotSequence ?? 0) + 1;
    fake.state.workspace.revision++;
    const state = structuredClone(fake.state);
    callbacks.forEach((session) => session.state(state));
    stores.forEach((store) => store.acceptSnapshot(state));
  };
  fake.changed = publish;
  const auth = (): AuthState => ({
    user: fake.state.user,
    locked: false,
    epoch: 1,
    peerEpoch: 1,
    methods: { password: true, pin: false, face: false },
    settings: {
      lockOnHidden: false,
      lockOnIdle: false,
      idleSeconds: 300,
      lockOnDeparture: false,
      faceEnabled: false,
    },
    face: { available: false, enrolled: false },
    endpointGeneration: 1,
  });
  const connect = ControlSession.prototype.connect;
  const request = ControlSession.prototype.request;
  const rtcConnect = RtcSession.prototype.connect;
  const accept = OperationsStore.prototype.acceptSnapshot;
  const productReady = Object.getOwnPropertyDescriptor(AuthorizationScope.prototype, 'productReady')!;
  const documentOpen = FileChannel.prototype.documentOpen;
  const documentResource = FileChannel.prototype.documentResource;
  const apply = async (command: ProductAction) => {
    if (command.type === 'window.open') {
      const existing = fake.state.workspace.windows.find((win) => win.appId === command.appId);
      const id = existing?.id ?? `mock-window-${fake.state.workspace.windows.length}`;
      if (!existing)
        fake.state.workspace.windows.push({
          id,
          appId: command.appId,
          activeTabId: null,
          lastActiveAt: Date.now(),
        });
      const spaceId = `mock-space-${id}`;
      if (!fake.state.workspace.spaces.some((space) => space.id === spaceId))
        fake.state.workspace.spaces.push({
          id: spaceId,
          windowIds: [id],
          weights: [1],
          focusedWindowId: id,
          lastActiveAt: Date.now(),
        });
      fake.state.workspace.activeSpaceId = spaceId;
    } else if (command.type === 'space.activate') fake.state.workspace.activeSpaceId = command.spaceId;
    else if (command.type === 'window.state') {
      const win = fake.state.workspace.windows.find((win) => win.id === command.windowId);
      if (win) win.state = command.state;
    }
    publish();
    return {
      operationId: 'mock-operation',
      operationGeneration: 'mock-generation',
      status: 'committed' as const,
      revision: fake.state.workspace.revision,
    };
  };
  OperationsStore.prototype.acceptSnapshot = function (state) {
    stores.add(this);
    this.action = apply;
    return accept.call(this, state);
  };
  ControlSession.prototype.connect = function () {
    const session = this as unknown as SessionCallbacks;
    callbacks.add(session);
    session.status('online');
    session.auth(auth());
    publish();
  };
  ControlSession.prototype.request = function (method, params) {
    if (method === 'viewport') geometries.push(params);
    return fake.request(method, params);
  };
  RtcSession.prototype.connect = async () => {};
  Object.defineProperty(AuthorizationScope.prototype, 'productReady', {
    get: () => true,
    configurable: true,
  });
  FileChannel.prototype.documentOpen = async () => ({ state: 'ready', ...documentFixture.info });
  FileChannel.prototype.documentResource = async (_documentId, contentId, offset) => {
    const resource = documentFixture.resources.find((resource) => resource.contentId === contentId);
    if (!resource) throw new Error('文档资源不存在');
    const bytes = atob(resource.base64);
    const chunk = bytes.slice(offset, offset + 16384);
    return { data: btoa(chunk), offset: offset + chunk.length, total: bytes.length, mime: resource.mime };
  };
  window.__remotekitLearning = {
    configure(app, signed) {
      fake.state = learningProductFixture(app, signed);
      const id = `learning-window-${Date.now()}`;
      fake.state.workspace.windows[0].id = id;
      fake.state.workspace.spaces[0].windowIds = [id];
      fake.state.workspace.spaces[0].focusedWindowId = id;
      fake.state.snapshotSequence = Date.now();
      fake.fail = '';
      fake.empty = false;
      publish();
    },
    scenario(value) {
      const win = fake.state.workspace.windows[0];
      const previousId = win.id;
      win.id = `learning-window-${value}-${Date.now()}`;
      for (const space of fake.state.workspace.spaces) {
        space.windowIds = space.windowIds.map((id) => (id === previousId ? win.id : id));
        if (space.focusedWindowId === previousId) space.focusedWindowId = win.id;
      }
      fake.fail =
        value === 'error'
          ? fake.state.workspace.windows[0].appId === 'study'
            ? 'study.homework.list'
            : 'bank.questions'
          : '';
      fake.empty = value === 'empty';
      const provider: LearningProvider =
        fake.state.workspace.windows[0].appId === 'study' ? 'changyan' : 'xinjiaoyu';
      if (value === 'expired')
        fake.state.learning.accounts[provider] = {
          status: 'expired',
          displayName: '同学',
          username: 'student',
        };
      if (value === 'verification') {
        fake.state.learning.accounts[provider] = {
          status: 'signing_in',
          step: provider === 'changyan' ? 'verification' : 'site',
          tabId: 'mock-sign-in',
        };
        fake.state.workspace.windows[0].activeTabId = 'mock-sign-in';
        fake.state.workspace.tabs = [
          {
            id: 'mock-sign-in',
            windowId: fake.state.workspace.windows[0].id,
            webviewId: 'signin-view',
            signIn: provider,
            kind: 'remote',
            title: '登录',
            url: 'https://example.invalid',
          },
        ];
      }
      fake.state.snapshotSequence = Date.now();
      publish();
    },
    calls: () => fake.calls,
    geometries: () => geometries,
  };
  import.meta.hot?.dispose(() => {
    ControlSession.prototype.connect = connect;
    ControlSession.prototype.request = request;
    RtcSession.prototype.connect = rtcConnect;
    OperationsStore.prototype.acceptSnapshot = accept;
    Object.defineProperty(AuthorizationScope.prototype, 'productReady', productReady);
    FileChannel.prototype.documentOpen = documentOpen;
    FileChannel.prototype.documentResource = documentResource;
    delete (window as Partial<Window>).__remotekitLearning;
  });
}
