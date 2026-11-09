import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createElement, act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { learningSanitizer, isControlMediaUrl, stripOptionLabel } from '../client/learning/html';
import { QuestionCard } from '../client/learning/question-card';
import { LearningQueries, usePaged } from '../client/learning/queries';
import { useViewerSessionSelector, shallowEqual } from '../client/app/use-viewer-session';
import { Store } from '../client/util/store';
import { SizeIndex } from '../client/ui/virtual-scroll';
import { VirtualScroller, VirtualList } from '../client/ui/virtual-list';
import { StudyApp } from '../client/learning/study/study-app';
import { QuestionsApp } from '../client/learning/questions/questions-app';
import { SignInCard } from '../client/learning/sign-in-card';
import { OverflowText } from '../client/app/overflow-text';
import { LibraryTab } from '../client/files/library-tab';
import { FileLibraryContext, type FileLibrary } from '../client/files/file-library-state';
import { FileChannel } from '../client/files/file-channel';
import { isDocumentFile } from '../client/files/file-preview';
import { filesInView, sourceAppName } from '../client/files/files-app-state';
import { LearningFakeTransport, bankFixtures } from '../client/test-hooks-learning-fixtures';
import { isLocalApp, isSingletonApp, BUILTIN_APP_TITLES } from '../shared/product';
import type { ViewerSession } from '../client/viewer-session';
import { contextMenuItems } from '../client/app/context-menu-items';

const dom = new JSDOM('<html><body><div id="app"></div></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
for (const name of [
  'window',
  'document',
  'HTMLElement',
  'Element',
  'Node',
  'DocumentFragment',
  'MutationObserver',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'getComputedStyle',
] as const)
  Object.defineProperty(globalThis, name, { value: (dom.window as any)[name], configurable: true });
const resizeNotifications = new Set<() => void>();
let viewportHeight = 700;
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    constructor(private readonly update: () => void) {}
    observe() {
      resizeNotifications.add(this.update);
    }
    disconnect() {
      resizeNotifications.delete(this.update);
    }
  },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => 1100 });
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { get: () => viewportHeight });
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
  width: 1100,
  height: 160,
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 1100,
  bottom: 160,
  toJSON() {},
});
const { createRoot } = await import('react-dom/client');

test('built-in learning Apps have local singleton identities', () => {
  for (const app of ['study', 'questions'] as const) {
    assert.ok(isLocalApp(app));
    assert.ok(isSingletonApp(app));
  }
  assert.equal(BUILTIN_APP_TITLES.study, '学习');
  assert.equal(BUILTIN_APP_TITLES.questions, '题库');
});

test('embedded sign-in menus retain editing commands and expose no navigation actions', () => {
  const tab = {
    id: 'sign-in',
    windowId: 'study',
    webviewId: 'view',
    title: '登录',
    url: 'https://example.invalid',
    signIn: 'changyan' as const,
  };
  const groups = contextMenuItems(
    {
      id: 'menu',
      x: 0,
      y: 0,
      source: 'mouse',
      link: { url: 'https://example.invalid/other', text: '其他' },
      editable: { undo: true, redo: false, cut: true, copy: true, paste: true, selectAll: true },
    },
    tab,
    'bing',
  );
  assert.ok(groups.flat().some((item) => item.command === 'paste'));
  assert.ok(groups.flat().every((item) => !item.action));
  const blank = contextMenuItems({ id: 'menu', x: 0, y: 0, source: 'mouse' }, tab, 'bing');
  assert.deepEqual(blank, [[{ label: '关闭菜单', command: 'dismiss' }]]);
});

test('provider HTML permits proxied media and MathML while removing external URLs and unsafe styles', () => {
  const sanitize = learningSanitizer(dom.window as any);
  const clean = sanitize(
    '<p style="text-align:center;position:fixed;color:red;width:75%">题目<img src="/api/learning/media/item-1" onerror="alert(1)"><img src="https://example.com/x"><a href="javascript:alert(1)">链接</a><script>alert(1)</script><mjx-container class="MathJax" jax="SVG"><svg style="vertical-align: -0.186ex;" xmlns="http://www.w3.org/2000/svg" width="2.009ex" height="1.887ex" role="img" focusable="false" viewBox="0 -833.9 888 833.9" onload="alert(1)"><g stroke="currentColor" fill="currentColor" stroke-width="0" transform="scale(1,-1)"><path d="M52 289Q59 331 106 386Z"></path></g><foreignObject><p>x</p></foreignObject></svg></mjx-container><img src="data:image/png;base64,iVBORw0KGgo="><audio autoplay src="/api/learning/media/audio"></audio></p>',
  );
  assert.match(clean, /<mjx-container[^>]*jax="SVG"/);
  assert.match(clean, /<svg[^>]*viewBox="0 -833.9 888 833.9"/);
  assert.match(clean, /vertical-align: -0.186ex/);
  assert.match(clean, /<path d="M52 289Q59 331 106 386Z"/);
  assert.match(clean, /src="data:image\/png;base64,/);
  assert.doesNotMatch(clean, /foreignObject|onload/);
  assert.match(clean, /text-align:center/);
  assert.match(clean, /width:75%/);
  assert.match(clean, /controls/);
  assert.doesNotMatch(clean, /onerror|position:|color:|https:|javascript:|<script|<a |autoplay/);
  assert.ok(isControlMediaUrl('/api/learning/media/item_1'));
  for (const src of [
    '//evil/api/learning/media/id',
    '/api/learning/media/../auth/me',
    'data:image/png;base64,abc',
    '/api/learning/media/%2fadmin',
  ])
    assert.equal(isControlMediaUrl(src), false);
});

test('normalized composite questions render children, listening transcript and correct option highlighting', () => {
  const html = renderToStaticMarkup(
    createElement(QuestionCard, { question: bankFixtures[0], number: '1', showAnswers: true }),
  );
  assert.match(html, /听力原文/);
  assert.match(html, /\(1\)/);
  assert.match(html, /correct-option/);
  assert.match(html, /答案/);
  assert.match(html, /解析/);
  assert.doesNotMatch(html, /https:\/\/cdn.example/);
});

test('option renderer removes provider labels while preserving option HTML', () => {
  for (const label of ['A.', 'A、', 'A．', '(A)', '（A）']) {
    const option = `<p><span> ${label} </span><mjx-container jax="SVG"><svg viewBox="0 0 10 10"><title>x</title><path d="M0 0"></path></svg></mjx-container> + 1</p>`;
    const html = renderToStaticMarkup(
      createElement(QuestionCard, {
        question: { ...bankFixtures[0], optionsHtml: [option], children: [] },
        number: '1',
      }),
    );
    const rendered = new JSDOM(html).window.document.querySelector('.question-option')!;
    assert.equal(rendered.textContent?.replace(/\s/g, ''), 'Ax+1');
    assert.ok(rendered.querySelector('mjx-container svg path'));
  }
  assert.equal(stripOptionLabel('<p>A molecule</p>'), '<p>A molecule</p>');
});

test('virtual paging fills a short viewport and stops at the true end', async () => {
  const pages: number[] = [];
  function PagedList() {
    const list = usePaged(
      'short-list',
      async (page) => {
        pages.push(page);
        return { items: [String(page)], page, pageSize: 1, pageCount: 3, total: 3, accessibleTotal: 3 };
      },
      true,
    );
    return createElement(VirtualList<string>, {
      items: list.items,
      itemKey: (item) => item,
      renderItem: (item) => item,
      onEnd: list.next,
      label: '短列表',
    });
  }
  const root = createRoot(document.getElementById('app')!);
  await act(async () => root.render(createElement(PagedList)));
  assert.deepEqual(pages, [1, 2, 3]);
  await act(async () => document.querySelector('.learning-list')!.dispatchEvent(new Event('scroll')));
  assert.deepEqual(pages, [1, 2, 3]);
  await act(async () => root.unmount());
});

test('virtual paging triggers within 600 pixels of the list end', async () => {
  let nearEnd = false;
  const root = createRoot(document.getElementById('app')!);
  await act(async () =>
    root.render(
      createElement(VirtualList<string>, {
        items: Array.from({ length: 12 }, (_, index) => String(index)),
        itemKey: (item) => item,
        renderItem: (item) => item,
        onEnd: () => {
          nearEnd = true;
        },
        label: '长列表',
      }),
    ),
  );
  const viewport = document.querySelector<HTMLDivElement>('.learning-list')!;
  assert.equal(nearEnd, false);
  await act(async () => {
    viewport.scrollTop = 619;
    viewport.dispatchEvent(new Event('scroll'));
  });
  assert.equal(nearEnd, false);
  await act(async () => {
    viewport.scrollTop = 620;
    viewport.dispatchEvent(new Event('scroll'));
  });
  assert.equal(nearEnd, true);
  await act(async () => root.unmount());
});

test('virtual paging checks the end when only the viewport height changes', async () => {
  let nearEnd = false;
  const root = createRoot(document.getElementById('app')!);
  await act(async () =>
    root.render(
      createElement(VirtualList<string>, {
        items: Array.from({ length: 12 }, (_, index) => String(index)),
        itemKey: (item) => item,
        renderItem: (item) => item,
        onEnd: () => {
          nearEnd = true;
        },
        label: '可调整列表',
      }),
    ),
  );
  assert.equal(nearEnd, false);
  await act(async () => {
    viewportHeight = 1320;
    resizeNotifications.forEach((update) => update());
  });
  assert.equal(nearEnd, true);
  await act(async () => root.unmount());
  viewportHeight = 700;
});

test('result totals remain visible while the next page is loading', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  function PagedList() {
    const list = usePaged(
      'totals',
      async (page) => {
        if (page === 2) await pending;
        return {
          items: [String(page)],
          page,
          pageSize: 1,
          pageCount: 2,
          total: 12345,
          accessibleTotal: 1000,
        };
      },
      true,
    );
    return createElement(
      'div',
      null,
      createElement('output', null, list.value?.total),
      createElement(VirtualList<string>, {
        items: list.items,
        itemKey: (item) => item,
        renderItem: (item) => item,
        onEnd: list.next,
        label: '分页总数',
      }),
    );
  }
  const root = createRoot(document.getElementById('app')!);
  await act(async () => root.render(createElement(PagedList)));
  assert.equal(document.querySelector('output')?.textContent, '12345');
  await act(async () => finish());
  assert.equal(document.querySelector('output')?.textContent, '12345');
  await act(async () => root.unmount());
});

test('query cache keys all filters, shares requests, and retries failures without persisting', async () => {
  const transport = new LearningFakeTransport();
  const cache = new LearningQueries(transport.request);
  const params = { subjectId: 'math', sort: 'newest' as const, page: 1, pageSize: 30 };
  await Promise.all([cache.get('bank.questions', params), cache.get('bank.questions', params)]);
  assert.equal(transport.calls.length, 1);
  await cache.get('bank.questions', { ...params, typeIds: ['choice'] });
  assert.equal(transport.calls.length, 2);
  transport.fail = 'bank.questions';
  cache.clear();
  await assert.rejects(cache.get('bank.questions', params));
  transport.fail = '';
  assert.equal((await cache.get('bank.questions', params)).page, 1);
});

test('learning files retain source, detail and supported document detection', () => {
  const transport = new LearningFakeTransport();
  assert.equal(sourceAppName('study'), '学习');
  assert.equal(filesInView(transport.library, { source: { app: 'study', channel: '' } }).length, 1);
  assert.match(transport.library.entries[0].detail!, /二次函数/);
  for (const extension of [
    'pdf',
    'doc',
    'docx',
    'ppt',
    'pptx',
    'xls',
    'xlsx',
    'odt',
    'odp',
    'ods',
    'rtf',
    'txt',
    'wps',
    'et',
    'dps',
  ])
    assert.ok(isDocumentFile({ name: `lesson.${extension}`, type: '' }));
  assert.equal(isDocumentFile({ name: 'archive.zip', type: 'application/zip' }), false);
});

test('Apps issue typed requests through a fake transport and react to subject and homework filters', async () => {
  const transport = new LearningFakeTransport();
  const rpc = new FileChannel(() => null);
  const library = {
    online: true,
    snapshot: transport.library,
    apps: [],
    rpc,
    refresh: async () => transport.library,
    thumbnails: { get: () => undefined, subscribe: () => () => {} },
  } as unknown as FileLibrary;
  const container = document.getElementById('app')!;
  const root = createRoot(container);
  const props = {
    windowId: 'learning-window',
    state: transport.state,
    call: transport.request,
    online: true,
    transport: {} as ViewerSession,
    action: async () => ({ operationId: 'x', operationGeneration: 'x', status: 'committed' as const }),
    openFiles: async () => {},
  };
  await act(async () => {
    root.render(
      createElement(FileLibraryContext.Provider, { value: library }, createElement(StudyApp, props)),
    );
  });
  assert.ok(transport.calls.some((call) => call.method === 'study.homework.list'));
  assert.ok(transport.calls.some((call) => call.method === 'study.homework.detail'));
  assert.equal(container.querySelectorAll('.study-master').length, 1);
  assert.ok(!container.textContent?.includes('返回列表'));
  assert.ok(![...container.querySelectorAll('button')].some((button) => button.textContent === '加载更多'));
  const completed = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === '已完成',
  )!;
  await act(async () => {
    completed.click();
  });
  assert.ok(
    transport.calls.some(
      (call) => call.method === 'study.homework.list' && (call.params as any).bucket === 'completed',
    ),
  );
  const materials = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === '班级资料',
  )!;
  await act(async () => {
    materials.click();
  });
  assert.ok(
    transport.calls.some(
      (call) => call.method === 'study.materials.list' && (call.params as any).subjectCode === '02',
    ),
  );
  await act(async () => {
    root.render(createElement(QuestionsApp, props));
  });
  assert.ok(transport.calls.some((call) => call.method === 'bank.questions'));
  const english = [...container.querySelectorAll('[role="button"], button')].find(
    (button) => button.textContent?.includes('英语') && button.textContent?.includes('高中'),
  ) as HTMLElement;
  await act(async () => {
    english.click();
  });
  assert.ok(
    transport.calls.some(
      (call) => call.method === 'bank.questions' && (call.params as any).subjectId === 'english',
    ),
  );
  await act(async () => root.unmount());
});

test('sign-in card sends credentials once and clears the password after submission', async () => {
  const container = document.getElementById('app')!;
  const root = createRoot(container);
  let credentials: unknown;
  await act(async () =>
    root.render(
      createElement(SignInCard, {
        provider: 'changyan',
        account: { status: 'signed_out' },
        windowId: 'w',
        online: true,
        call: (async (_method: string, params: unknown) => {
          credentials = params;
          return { started: true };
        }) as any,
      }),
    ),
  );
  const inputs = container.querySelectorAll('input');
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(inputs[0], 'student');
    inputs[0].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    setter.call(inputs[1], 'secret');
    inputs[1].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(inputs[1].value, '');
  assert.ok(credentials);
  assert.deepEqual(credentials, {
    provider: 'changyan',
    windowId: 'w',
    username: 'student',
    password: 'secret',
  });
  assert.equal(localStorageAvailable(), false);
  await act(async () => root.unmount());
});

function localStorageAvailable() {
  return dom.window.localStorage.length > 0;
}

test('session selectors isolate stats ticks and cache object selections', async () => {
  class TestStore<T> extends Store<T> {
    update(value: T) {
      this.publish(value);
    }
  }
  const rtc = new TestStore({ phase: 'connected' });
  const observations = new TestStore({ framesDecoded: 0 });
  let observationSubscribers = 0;
  const subscribeObservations = observations.subscribe;
  observations.subscribe = (listener) => {
    observationSubscribers++;
    const remove = subscribeObservations(listener);
    return () => {
      observationSubscribers--;
      remove();
    };
  };
  const other = new TestStore({});
  const session = {
    rtc,
    observations,
    presentation: other,
    editing: other,
    authorization: other,
  } as unknown as ViewerSession;
  let stageRenders = 0,
    statsRenders = 0;
  function StageSelection() {
    const value = useViewerSessionSelector(
      session,
      (snapshot) => ({ phase: snapshot.rtc.phase }),
      shallowEqual,
    );
    stageRenders++;
    return createElement('span', null, value.phase);
  }
  function StatsSelection() {
    useViewerSessionSelector(session, (snapshot) => snapshot.observations);
    statsRenders++;
    return null;
  }
  const root = createRoot(document.getElementById('app')!);
  await act(async () =>
    root.render(createElement('div', null, createElement(StageSelection), createElement(StatsSelection))),
  );
  await act(async () => observations.update({ framesDecoded: 1 }));
  assert.equal(stageRenders, 1);
  assert.equal(observationSubscribers, 1);
  assert.equal(statsRenders, 2);
  await act(async () => rtc.update({ phase: 'exhausted' }));
  assert.equal(stageRenders, 2);
  function ConditionalSelection() {
    const frames = useViewerSessionSelector(session, (snapshot) =>
      snapshot.rtc.phase === 'connected' ? (snapshot.observations.framesDecoded ?? 0) : 0,
    );
    return createElement('span', null, frames);
  }
  await act(async () => root.render(createElement(ConditionalSelection)));
  assert.equal(observationSubscribers, 0);
  await act(async () => observations.update({ framesDecoded: 0 }));
  await act(async () => rtc.update({ phase: 'connected' }));
  assert.equal(observationSubscribers, 1);
  await act(async () => observations.update({ framesDecoded: 2 }));
  assert.equal(document.getElementById('app')!.textContent, '2');
  await act(async () => root.unmount());
});

test('fixed virtual rows bound mounts, retain keyboard focus and reach the final item', async () => {
  const items = Array.from({ length: 320 }, (_, index) => String(index));
  const sizes = new SizeIndex(items.map(() => 74));
  const root = createRoot(document.getElementById('app')!);
  await act(async () =>
    root.render(
      createElement(VirtualScroller<string>, {
        viewportRef: null,
        items,
        sizes,
        enabled: true,
        contentWidth: 0,
        itemKey: (item) => item,
        renderItem: (item) => createElement('button', null, item),
        onWidth: () => {},
        onScroll: () => {},
        className: 'fixed-virtual-test',
        label: 'Files',
      }),
    ),
  );
  const viewport = document.querySelector<HTMLElement>('.fixed-virtual-test')!;
  const first = viewport.querySelector<HTMLButtonElement>('button')!;
  await act(async () => first.focus());
  await act(async () => {
    viewport.scrollTop = 20000;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  assert.strictEqual(document.activeElement, first);
  assert.ok(first.isConnected);
  assert.ok(viewport.querySelectorAll('button').length < 40);
  await act(async () => {
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  assert.equal(document.activeElement?.textContent, '1');
  await act(async () => {
    viewport.scrollTop = sizes.total - viewport.clientHeight;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  assert.ok([...viewport.querySelectorAll('button')].some((button) => button.textContent === '319'));
  await act(async () => root.unmount());
});

test('library virtual rows keep selection and basket actions scoped to entry ids', async () => {
  const transport = new LearningFakeTransport();
  const entries = Array.from({ length: 320 }, (_, index) => ({
    id: 'file-' + index,
    name: 'File ' + index + '.txt',
    type: 'text/plain',
    assetId: 'asset-' + index,
    size: 12,
    createdAt: Date.now() - index * 86400000,
    source: null,
    partitionId: null,
    collected: true,
  }));
  const mutations: { method: string; params: any }[] = [];
  const library = {
    online: true,
    apps: [],
    snapshot: { ...transport.library, entries, basket: [] },
    photos: { jobs: [] },
    rpc: new FileChannel(() => null),
    thumbnails: { get: () => undefined, subscribe: () => () => {} },
    mutate: async (method: string, params: unknown) => {
      mutations.push({ method, params });
    },
  } as unknown as FileLibrary;
  const props = {
    windowId: 'files',
    view: 'all' as const,
    query: '',
    layout: 'list' as const,
    onView: () => {},
    onQuery: () => {},
    onLayout: () => {},
    onOpen: () => {},
  };
  const root = createRoot(document.getElementById('app')!);
  await act(async () =>
    root.render(
      createElement(FileLibraryContext.Provider, { value: library }, createElement(LibraryTab, props)),
    ),
  );
  assert.ok(document.querySelectorAll('[data-file-row]').length < 40);
  const first = document.querySelector('[data-file-row]')!;
  const id = first.getAttribute('data-file-row');
  const basket = first.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
  await act(async () => basket.click());
  assert.equal(mutations[0].method, 'library.basket');
  assert.deepEqual(mutations[0].params.ids, [id]);
  const checkbox = first.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => checkbox.click());
  assert.equal(checkbox.checked, true);
  const controls = first.querySelectorAll<HTMLButtonElement>('button');
  const lastControl = controls[controls.length - 1];
  await act(async () => lastControl.focus());
  await act(async () => {
    lastControl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  assert.notEqual(document.activeElement?.closest('[data-file-row]')?.getAttribute('data-file-row'), id);
  assert.ok(document.activeElement?.closest('[data-file-row]'));
  await act(async () => root.unmount());
});

test('overflow tooltips measure the mounted text after the opening delay', async () => {
  const root = createRoot(document.getElementById('app')!);
  await act(async () => root.render(createElement(OverflowText, null, 'Full file name')));
  const text = document.querySelector<HTMLElement>('#app .MuiTypography-root')!;
  Object.defineProperty(text, 'scrollWidth', { value: 2000 });
  await act(async () => {
    text.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  assert.equal(document.querySelector('[role="tooltip"]')?.textContent, 'Full file name');
  await act(async () => root.unmount());
});
