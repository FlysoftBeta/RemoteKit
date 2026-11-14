import { matrixDom } from './retry-loop-dom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthView } from '../client/app/product-dialogs';
import { ConfirmDialog } from '../client/app/admin/shared';
import { SessionImportSettings } from '../client/app/session-import';
import { useWindowState } from '../client/app/window-state';
import { Launcher } from '../client/app/launcher';
import { InstallDialog } from '../client/app/app-editor';
import { FileImagePreview } from '../client/files/file-image-preview';
import { DocumentTab } from '../client/files/document-tab';
import { FilePreview } from '../client/files/file-preview';
import { AttachmentRow } from '../client/learning/study/attachment';
import { DocumentViewer } from '../client/documents/document-viewer';
import { AnnouncementDialog } from '../client/app/announcements';
import { UnlockView } from '../client/auth/unlock-view';
import { SecuritySettings } from '../client/auth/security-settings';
import { SelectionUI } from '../client/selection/selection-ui';
import { StudyApp } from '../client/learning/study/study-app';
import { unscaledLayer } from '../client/app/ui-scale';
import { FileChooserDialog } from '../client/files/file-chooser-dialog';
import { ImportQueue } from '../client/files/import-queue';
import { productSnapshot } from './client-fixture';
import { PhotoCapture } from '../client/files/photo-library-capture';
import { FileLibraryContext } from '../client/files/file-library-state';
import { httpStatus, wireError } from '../shared/errors';
import { settle, type OwnerFactory } from './retry-loop-boundary';

export function driveUi(
  path:
    | 'identity'
    | 'operation'
    | 'window'
    | 'camera'
    | 'imports'
    | 'launcher'
    | 'inspect'
    | 'image'
    | 'snippet'
    | 'media'
    | 'attachment'
    | 'document'
    | 'page'
    | 'progress'
    | 'progress-save'
    | 'announcement'
    | 'login'
    | 'unlock'
    | 'security'
    | 'selection'
    | 'study-action'
    | 'study-material'
    | 'study-material-save'
    | 'attachment-save'
    | 'import-action'
    | 'security-pin'
    | 'security-remove-pin'
    | 'security-policy'
    | 'security-remove-face'
    | 'chooser',
): OwnerFactory {
  return async (boundary, t) => {
    const dom = matrixDom();
    Object.defineProperty(dom.window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    if (
      ['document', 'page', 'progress', 'progress-save', 'study-material', 'study-material-save'].includes(
        path,
      )
    ) {
      Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get: () => 800,
      });
      Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get: () => 600,
      });
      Object.defineProperty(dom.window.document, 'fonts', {
        configurable: true,
        value: { ready: Promise.resolve() },
      });
    }
    const restore: (() => void)[] = [];
    class Observer {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const track = { stop() {}, getSettings: () => ({}) };
    Object.defineProperty(dom.window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: (input: unknown) =>
          boundary.call(input, { getTracks: () => [track], getVideoTracks: () => [track] }),
        enumerateDevices: async () => [],
        addEventListener() {},
        removeEventListener() {},
      },
    });
    t.mock.method(dom.window.HTMLMediaElement.prototype, 'play', async () => {});
    t.mock.method(dom.window.HTMLMediaElement.prototype, 'pause', () => {});
    Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
    for (const [name, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      ShadowRoot: dom.window.ShadowRoot,
      DocumentFragment: dom.window.DocumentFragment,
      ResizeObserver: Observer,
      innerWidth: 1024,
      innerHeight: 768,
      getComputedStyle: dom.window.getComputedStyle,
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async (url: string) => {
        try {
          if (path !== 'login' || !url.endsWith('/setup')) await boundary.call({ url }, undefined);
          return new Response(
            JSON.stringify({ required: false, user: { id: 'user', username: 'viewer', isAdmin: false } }),
            { status: 200 },
          );
        } catch (error) {
          return new Response(JSON.stringify({ error: wireError(error as never) }), {
            status: httpStatus[boundary.code!],
          });
        }
      },
    })) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, { configurable: true, value });
      restore.push(() => {
        if (previous) Object.defineProperty(globalThis, name, previous);
        else Reflect.deleteProperty(globalThis, name);
      });
    }
    const root = createRoot(dom.window.document.getElementById('root')!);
    const callbacks: (() => void)[] = [];
    const interval = setInterval;
    t.mock.method(globalThis, 'setInterval', (callback: () => void, ms: number) => {
      callbacks.push(callback);
      return interval(callback, ms);
    });
    const noop = () => {};
    let error: unknown;
    let closed = false;
    const close = () => {
      closed = true;
      root.render(null);
    };
    let update: (value: unknown) => void = noop;
    const report = (value: unknown) => {
      error = value;
    };
    const action = (input: unknown) => boundary.call(input, {});
    const call = (method: string, params: unknown) => {
      if (path === 'progress' && method.endsWith('.set')) return Promise.resolve({});
      if (path === 'progress-save' && method.endsWith('.get')) return Promise.resolve({ page: 0, offset: 0 });
      if (path === 'import-action' && method === 'sessionImport.state')
        return Promise.resolve({ devices: [], timeline: [], receiving: true, pairing: { open: false } });
      if (path === 'attachment-save' && method === 'study.attachment.save')
        return boundary.call({ method, params }, { entryId: 'entry' });
      if (path === 'study-material' || path === 'study-material-save') {
        if (method === 'study.subjects')
          return Promise.resolve({ subjects: [{ code: 'math', name: 'Math' }] });
        if (method === 'study.materials.list')
          return Promise.resolve({
            items: [
              {
                id: 'material',
                name: 'Material',
                learningState: 'pending',
                attachment: {
                  key: 'attachment',
                  name: 'file',
                  save:
                    path === 'study-material' ? { state: 'saved', entryId: 'entry' } : { state: 'not_saved' },
                },
              },
            ],
            total: 1,
          });
        if (method === 'study.attachment.save')
          return boundary.call({ method, params }, { entryId: 'entry' });
        return Promise.resolve({ items: [], total: 0 });
      }
      if (path === 'study-action' && method !== 'study.sync')
        return Promise.resolve(method === 'study.subjects' ? { subjects: [] } : { items: [] });
      return boundary.call(
        { method, params },
        ['progress', 'progress-save'].includes(path)
          ? { page: 0, offset: 0 }
          : path === 'launcher'
            ? { items: [] }
            : path === 'inspect'
              ? { name: 'Example', startUrl: 'https://example.test', display: 'standalone' }
              : { devices: [], timeline: [], receiving: false, pairing: { open: false } },
      );
    };
    const entry = {
      kind: path === 'snippet' ? 'snippet' : 'file',
      id: 'entry',
      assetId: 'a'.repeat(64),
      name: path === 'media' ? 'file.mp3' : 'file.jpg',
      size: 1,
      type:
        path === 'progress' || path === 'progress-save'
          ? 'application/pdf'
          : path === 'media'
            ? 'audio/mpeg'
            : 'image/jpeg',
      available: true,
      collected: true,
      createdAt: 0,
      partitionId: null,
      origin: { kind: 'device' },
      preview: 'snippet',
    };
    const info = {
      documentId: 'document',
      shared: ['css'],
      pages: [{ id: 'page', ordinal: 0, width: 600, height: 800, document: 'html', dependencies: [] }],
    };
    const resource = (id: string) => ({
      mime: id === 'css' ? 'text/css' : 'text/html',
      data: new Blob([id === 'css' ? 'p{color:black}' : '<main class="page"><p>Page</p></main>']),
    });
    const source = {
      open: () =>
        path === 'document' ? boundary.call({ document: boundary.version }, info) : Promise.resolve(info),
      resource: (id: string) =>
        path === 'page' && id === 'html'
          ? boundary.call({ document: boundary.version, id }, resource(id))
          : Promise.resolve(resource(id)),
    };
    const auth = {
      user: { id: 'user', username: 'viewer', isAdmin: false },
      locked: true,
      methods: { password: true, pin: path === 'security-remove-pin', face: false },
      face: { available: true, enrolled: path === 'security-remove-face' },
      settings: {
        lockOnIdle: false,
        lockOnHidden: false,
        idleSeconds: 300,
        lockOnDeparture: false,
        faceEnabled: false,
      },
    };
    const authRequest = async (method: string, params: unknown) => {
      await boundary.call({ method, params }, undefined);
      if (path === 'unlock') close();
      return auth;
    };
    const queue = new ImportQueue(
      {
        rpc: {
          uploadAsset: async () => ({ assetId: 'a'.repeat(64), size: 1, type: 'application/octet-stream' }),
        },
        mutate: async () => ({
          revision: 0,
          entries: [],
          basket: [],
          partitions: [],
          sources: [],
          excludedSources: [],
          basketPartitionId: null,
        }),
      },
      'basket',
    );
    const cancellations: Record<string, string> = {};
    const library = {
      online: true,
      snapshot: {
        revision: 0,
        entries: path === 'study-material' ? [] : [entry],
        basket: [],
        partitions: [],
        sources: [],
        excludedSources: [],
        basketPartitionId: null,
      },
      photos: { jobs: [] },
      importQueue: () => queue,
      cancellations,
      checkout: () => undefined,
      cancelSelection: async (requestId: string) => {
        const result = await boundary.call({ requestId }, 'cancelled');
        cancellations[requestId] = result;
        return result;
      },
      snippet: (id: string) => boundary.call({ id }, { text: 'text' }),
      refresh: () =>
        path === 'attachment' || path === 'study-material'
          ? boundary.call({ entryId: 'entry' }, { entries: [entry] })
          : Promise.resolve({ entries: [entry] }),
      rpc: {
        readPhoto: (asset: unknown) =>
          path === 'image'
            ? boundary.call({ asset }, new Blob(['image']))
            : Promise.resolve(new Blob(['image'])),
        readAsset: (asset: unknown) =>
          path === 'media'
            ? boundary.call({ asset }, new Blob(['media']))
            : Promise.resolve(new Blob(['media'])),
        documentOpen: async () => ({ ...info, state: 'ready' }),
        documentResource: async (_doc: string, id: string) => {
          const text = await resource(id).data.text();
          return { mime: resource(id).mime, data: btoa(text), offset: text.length, total: text.length };
        },
      },
      apps: [],
    };
    function WindowOwner() {
      [, update] = useWindowState({ id: 'window', state: {} } as never, action as never, report);
      return null;
    }
    const component = () => {
      if (path === 'identity' || path === 'login')
        return createElement(AuthView, {
          key: boundary.version,
          onLogin: close,
          close: noop,
          notice: undefined,
        });
      if (path === 'unlock')
        return createElement(UnlockView, {
          key: boundary.version,
          auth: auth as never,
          request: authRequest as never,
          camera: {} as never,
          close: noop,
        });
      if (path.startsWith('security'))
        return createElement(SecuritySettings, {
          key: boundary.version,
          auth: auth as never,
          online: true,
          request: authRequest as never,
          camera: {} as never,
          idle: {} as never,
          lock: noop,
        });
      if (path === 'announcement')
        return createElement(AnnouncementDialog, {
          key: boundary.version,
          announcements: [
            { id: 'notice-' + boundary.version, title: 'Notice', body: 'text', publishedAt: 1, read: false },
          ],
          read: (id) => boundary.call({ id }, undefined),
        });
      if (path === 'selection')
        return createElement(SelectionUI, {
          key: boundary.version,
          target: {
            handles: () => ({}),
            anchor: () => ({ left: 100, top: 100, width: 20, height: 10 }),
            commands: () => ['copy' as const],
            alive: () => true,
            collapse: noop,
            dragHandle: noop,
            run: (command) => boundary.call({ command, selection: boundary.version }, undefined),
          },
          close,
          dismiss: noop,
        });
      if (path === 'operation')
        return createElement(ConfirmDialog, {
          key: boundary.version,
          title: 'Confirm',
          open: true,
          retryIdentity: 'operation-' + boundary.version,
          onConfirm: () => boundary.call({ identity: 'operation-' + boundary.version }, undefined),
          onClose: () => {
            closed = true;
            root.render(null);
          },
          children: null,
        });
      if (path === 'window') return createElement(WindowOwner, { key: boundary.version });
      if (path === 'imports' || path === 'import-action')
        return createElement(SessionImportSettings, {
          key: boundary.version,
          online: true,
          call: call as never,
          action: noop as never,
          windowId: null,
          opened: noop,
        });
      if (path === 'inspect')
        return createElement(InstallDialog, {
          key: boundary.version,
          tabId: 'tab',
          state: productSnapshot(),
          call: call as never,
          action: noop as never,
          onClose: noop,
        });
      if (path === 'document' || path === 'page')
        return createElement(DocumentViewer, { key: boundary.version, source, title: 'Document' });
      const provided = (child: ReturnType<typeof createElement>) =>
        createElement(FileLibraryContext.Provider, { value: library as never }, child);
      if (path === 'study-action' || path === 'study-material' || path === 'study-material-save') {
        const state = productSnapshot();
        state.learning.accounts.changyan = {
          status: 'signed_in',
          displayName: 'viewer',
          username: 'viewer',
          updatedAt: 0,
        } as never;
        return provided(
          createElement(StudyApp, {
            key: boundary.version,
            state,
            call: call as never,
            online: true,
            windowId: 'window',
            tab: {} as never,
            action: noop as never,
            openFiles: async () => {},
          } as never),
        );
      }
      if (path === 'chooser')
        return provided(
          createElement(FileChooserDialog, {
            key: boundary.version,
            request: {
              id: 'chooser-' + boundary.version,
              tabId: 'tab',
              windowId: 'window',
              origin: 'https://example.test',
              multiple: true,
              accept: [],
              state: 'pending',
              limits: { maxFiles: 10, maxFileBytes: 100, maxBatchBytes: 100 },
            },
            transport: {} as never,
          } as never),
        );
      if (path === 'launcher')
        return provided(
          createElement(Launcher, {
            key: boundary.version,
            state: productSnapshot(),
            call: call as never,
            online: true,
            close: noop,
            activate: async () => {},
            navigate: async () => {},
            audio: null,
            sync: null,
            lock: noop,
            fullscreen: false,
            toggleFullscreen: noop,
            snapshots: {} as never,
            action: noop as never,
            report: noop,
          }),
        );
      if (path === 'image')
        return provided(
          createElement(FileImagePreview, {
            key: boundary.version,
            entry: entry as never,
            inline: true,
            showRotation: false,
            onClose: noop,
          }),
        );
      if (path === 'snippet')
        return provided(
          createElement(DocumentTab, {
            key: boundary.version,
            tab: { kind: 'document', entryId: 'entry' } as never,
            windowId: 'window',
            onBack: noop,
            onClose: noop,
          }),
        );
      if (path === 'media')
        return provided(createElement(FilePreview, { key: boundary.version, entry: entry as never }));
      if (path === 'progress' || path === 'progress-save')
        return provided(
          createElement(FilePreview, { key: boundary.version, entry: entry as never, call: call as never }),
        );
      if (path === 'attachment' || path === 'attachment-save')
        return provided(
          createElement(AttachmentRow, {
            key: boundary.version,
            attachment: {
              key: 'attachment',
              name: 'file',
              save: path === 'attachment' ? { state: 'saved', entryId: 'entry' } : { state: 'not_saved' },
            } as never,
            call: call as never,
            open: () => {
              closed = true;
              root.render(null);
            },
          }),
        );
      return createElement(
        FileLibraryContext.Provider,
        { value: library as never },
        createElement(PhotoCapture, { key: boundary.version, onClose: noop }),
      );
    };
    const begin = async () => {
      error = undefined;
      closed = false;
      await act(async () => {
        root.render(component());
        await settle();
      });
      if (path === 'launcher') {
        t.mock.timers.tick(0);
        await act(settle);
      }
      if (path === 'window')
        await act(async () => {
          update({ position: boundary.version });
        });
      if (path === 'operation' || path === 'imports' || path === 'import-action') {
        await act(async () => {
          const buttons = dom.window.document.querySelectorAll<HTMLButtonElement>('button');
          const button = path === 'operation' ? buttons[buttons.length - 1]! : buttons[0]!;
          button.click();
          await settle();
        });
      }
      if (path === 'attachment' || path === 'attachment-save')
        await act(async () => {
          dom.window.document.querySelector<HTMLButtonElement>('button.material-row')!.click();
          await settle();
        });
      if (path === 'announcement')
        await act(async () => {
          dom.window.document.querySelector<HTMLButtonElement>('button.MuiButton-contained')!.click();
          await settle();
        });
      if (path.startsWith('security'))
        await act(async () => {
          const buttons = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')];
          if (path === 'security-policy') {
            dom.window.document
              .querySelector<HTMLInputElement>('.setting-toggle:not(.disabled) input[type=checkbox]')!
              .click();
            await settle();
            [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')]
              .find((button) => button.textContent?.includes('\u4fdd\u5b58\u5b89\u5168\u8bbe\u7f6e'))!
              .click();
          } else if (path === 'security-remove-pin' || path === 'security-remove-face')
            buttons.find((button) => button.textContent === '\u5220\u9664')!.click();
          else if (path === 'security-pin')
            buttons.find((button) => button.textContent === '\u8bbe\u7f6e')!.click();
          else buttons[1]!.click();
          await settle();
        });
      if (path === 'import-action')
        await act(async () => {
          dom.window.document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
          await settle();
        });
      if (path === 'study-material' || path === 'study-material-save') {
        await act(async () => {
          [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')]
            .find((button) => button.textContent === '\u73ed\u7ea7\u8d44\u6599')!
            .click();
          await settle();
        });
        await act(async () => {
          const row = dom.window.document.querySelector<HTMLButtonElement>('button.material-row');
          if (row && !row.classList.contains('selected-card')) row.click();
          await settle();
        });
      }
      if (path === 'selection')
        await act(async () => {
          unscaledLayer().querySelector<HTMLButtonElement>('button.selection-menu-command')!.click();
          await settle();
        });
      if (path === 'study-action')
        await act(async () => {
          dom.window.document
            .querySelector<HTMLButtonElement>('button:has([data-testid="SyncOutlinedIcon"])')!
            .click();
          await settle();
        });
      if (path === 'chooser')
        await act(async () => {
          (dom.window.document.querySelector<HTMLButtonElement>('button:has([data-testid="CloseIcon"])') ??
            unscaledLayer().querySelector<HTMLButtonElement>(
              'button:has([data-testid="CloseIcon"])',
            ))!.click();
          await settle();
        });
      if (['login', 'unlock'].includes(path) || path.startsWith('security'))
        await act(async () => {
          dom.window.document
            .querySelector('form')!
            .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
          await settle();
        });
    };
    return {
      advance: (milliseconds) =>
        act(async () => {
          t.mock.timers.tick(milliseconds);
          await settle();
        }),
      start: begin,
      drive: () =>
        act(async () => {
          if (path === 'imports') callbacks.forEach((callback) => callback());
          await settle();
        }),
      changeInput: async () => {
        boundary.version++;
        await begin();
      },
      error: () =>
        path === 'window'
          ? error
          : closed
            ? undefined
            : (
                (path === 'selection' ? unscaledLayer() : dom.window.document).querySelector(
                  '.failure-note',
                ) ?? (path === 'chooser' ? unscaledLayer().querySelector('.failure-note') : null)
              )?.textContent || undefined,
      dispose: async () => {
        await act(async () => {
          root.unmount();
          queue.dispose();
          await settle();
        });
        restore.forEach((reset) => reset());
      },
    };
  };
}
