// Client-half smoke test — **not** a visual check.
//
// It answers one question only: does the generated `client.js` initialise, register the two
// slots, and render its component tree without throwing? Typo-level defects (an undefined
// helper, a bad property access, a hook called outside a component) show up here instead of
// as a white panel in the browser.
//
//   node test/client.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = await readFile(path.join(here, '..', 'client.js'), 'utf8');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    console.error('  ✗ ' + name);
    console.error('    ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n    ') : error));
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    console.error('  ✗ ' + name);
    console.error('    ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n    ') : error));
    process.exitCode = 1;
  }
}

/* ── a React just real enough to render once ───────────────────────────── */

const effectQueue = [];

const React = {
  createElement(type, props, ...children) {
    // real React folds children into props.children; the error boundaries rely on it
    const merged = Object.assign({}, props || {});
    if (children.length > 0 && merged.children === undefined) {
      merged.children = children.length === 1 ? children[0] : children;
    }
    return { type, props: merged, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect(fn) {
    effectQueue.push(fn);
    return undefined;
  },
  useMemo(fn) {
    return fn();
  },
  useCallback(fn) {
    return fn;
  },
  useRef(initial) {
    return { current: initial };
  },
  Component: class Component {
    constructor(props) {
      this.props = props || {};
      this.state = {};
    }

    setState() {}
  },
  Fragment: Symbol('react.fragment'),
};

// real React marks class components this way; our renderer relies on it
React.Component.prototype.isReactComponent = {};

/* ── a window/document just real enough to not explode ─────────────────── */

const styleElements = [];
const storage = new Map();

const fakeElement = () => ({
  setAttribute() {},
  remove() {},
  appendChild() {},
  textContent: '',
  style: {},
  className: '',
});

const fakeDocument = {
  createElement: () => {
    const element = fakeElement();
    styleElements.push(element);
    return element;
  },
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
};

const fakeWindow = {
  __ModuleLoader__: { load(definition) { fakeWindow.__loaded = definition; } },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  setTimeout: (fn) => {
    void fn;
    return 0;
  },
  clearTimeout: () => {},
  addEventListener() {},
  removeEventListener() {},
  getSelection: () => null,
  innerWidth: 1600,
  innerHeight: 900,
};

const jsonResponse = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.window = fakeWindow;
globalThis.document = fakeDocument;
globalThis.fetch = async (url) => {
  const text = String(url);
  if (text.includes('/docs') && !text.includes('/doc/')) {
    return jsonResponse({
      ok: true,
      dataDir: 'C:/data/docmate',
      docs: [
        { id: 'd1', name: 'a.md', ext: 'md', size: 120, chars: 120, hasText: true, sessionId: 'sess-1' },
        { id: 'd2', name: 'b.docx', ext: 'docx', size: 900, chars: 800, hasText: true, sessionId: 'sess-2' },
      ],
    });
  }
  if (text.includes('/doc/session')) return jsonResponse({ ok: true, sessionId: 'sess-1', injected: true, chars: 120, hasText: true });
  if (text.includes('/doc/memory')) return jsonResponse({ ok: true, memory: '- 一条记忆', chars: 6 });
  if (text.includes('/doc/docx')) return jsonResponse({ ok: true, html: '<h1>标题</h1><p>正文</p>', title: 't', warnings: [] });
  if (text.includes('/ask')) return jsonResponse({ ok: true });
  if (text.includes('/doc/raw')) return new Response('# 标题\n\n正文', { status: 200 });
  return jsonResponse({ ok: true });
};

/* ── load the bundle ───────────────────────────────────────────────────── */

console.log('bundle');
{
  const run = new Function('window', 'document', 'fetch', 'Response', 'console', bundle);
  run(fakeWindow, fakeDocument, globalThis.fetch, Response, console);
  check('调用 window.__ModuleLoader__.load 一次', () => assert.ok(fakeWindow.__loaded));
  check('id 是 dsh-docmate', () => assert.equal(fakeWindow.__loaded.id, 'dsh-docmate'));
}

const factory = fakeWindow.__loaded.factory;
const requireStub = (name) => {
  assert.equal(name, 'react', '客户端只允许 require("react")，实际：' + name);
  return React;
};

let plugin = null;
check('factory(require) 返回插件面', () => {
  plugin = factory(requireStub);
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(Array.isArray(plugin.inject));
  assert.ok(plugin.inject.includes('slots'));
});

/* ── apply ─────────────────────────────────────────────────────────────── */

const registrations = [];
const effects = [];
const services = {
  sessions: { retain: () => ({ release() {} }) },
  uiWorkspace: { pickDirectory: async () => null },
};

const ctx = {
  get: (name) => services[name],
  effect(fn, label) {
    effects.push({ label, dispose: fn() });
  },
  slots: {
    inject(key, callback) {
      registrations.push({ kind: 'inject', key });
      callback();
      return () => {};
    },
    register(options, component) {
      registrations.push({ kind: 'register', options, component });
      return () => {};
    },
  },
};

console.log('apply()');
{
  plugin.apply(ctx);
  check('注入 stylesheet 一个 effect', () => assert.ok(effects.some((entry) => entry.label === 'docmate: stylesheet')));
  check('stylesheet 真的写进了 <style>', () => {
    const style = styleElements.find((element) => String(element.textContent).includes('.dm-root'));
    assert.ok(style, 'no .dm-root rule found');
    assert.ok(String(style.textContent).includes('.dm-selbar'));
  });
  check('注册了 main（key=docmate）', () => {
    const entry = registrations.find((item) => item.kind === 'register' && item.options.name === 'main');
    assert.ok(entry, 'no main registration');
    assert.equal(entry.options.key, 'docmate');
    assert.equal(typeof entry.component, 'function');
  });
  check('main 声明了非 root 子座位（否则拿不到 SessionProvider）', () => {
    const entry = registrations.find((item) => item.kind === 'register' && item.options.name === 'main');
    const children = entry.options.children || {};
    const seats = Object.entries(children);
    assert.ok(seats.length > 0, 'children is empty');
    assert.ok(seats.some(([, seat]) => seat.scope !== 'root'), 'no non-root child seat');
  });
  check('注册了 sidebar.panellist（id=docmate）', () => {
    const entry = registrations.find((item) => item.kind === 'register' && item.options.name === 'sidebar.panellist');
    assert.ok(entry, 'no panellist registration');
    assert.equal(entry.options.id, 'docmate');
    assert.equal(entry.options.label, '伴读');
    assert.equal(typeof entry.component, 'function');
  });
}

/* ── render once (crash smoke, not a visual check) ─────────────────────── */

function render(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return null;
  if (typeof element === 'string' || typeof element === 'number') return String(element);
  if (Array.isArray(element)) return element.map(render);
  if (typeof element.type === 'function') {
    const isClass = element.type.prototype && element.type.prototype.isReactComponent;
    if (isClass) {
      const instance = new element.type(element.props);
      return render(instance.render());
    }
    return render(element.type(element.props));
  }
  return { tag: element.type, props: element.props, children: (element.children || []).map(render) };
}

function drainEffects() {
  const queue = effectQueue.splice(0, effectQueue.length);
  for (const fn of queue) {
    try {
      fn();
    } catch (error) {
      throw new Error('effect threw: ' + (error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error));
    }
  }
}

console.log('渲染冒烟（只查崩溃，不查外观）');
{
  const mainEntry = registrations.find((item) => item.kind === 'register' && item.options.name === 'main');
  const iconEntry = registrations.find((item) => item.kind === 'register' && item.options.name === 'sidebar.panellist');

  check('侧栏图标可渲染（含 ownerProps size/active）', () => {
    const tree = render(React.createElement(iconEntry.component, { size: 22, active: true }));
    assert.ok(tree && tree.tag === 'svg', 'icon did not render an <svg>');
    assert.equal(tree.props.width, 22);
    assert.equal(tree.props.strokeWidth, 2);
  });

  check('主面板可渲染（SessionProvider 缺失时降级，不抛）', () => {
    const tree = render(React.createElement(mainEntry.component, {}));
    assert.ok(tree, 'app rendered nothing');
    const html = JSON.stringify(tree);
    assert.ok(html.includes('dm-root'), 'no .dm-root in tree');
    assert.ok(html.includes('研究区'), 'no research-area column');
  });

  check('主面板在拿到 hostKit 时渲染 SessionProvider', () => {
    const SessionProvider = function SessionProvider() {
      return React.createElement('div', { className: 'fake-session' });
    };
    const renderFactorySlot = () => React.createElement('div', { className: 'fake-content' });
    const tree = render(React.createElement(mainEntry.component, { SessionProvider, renderFactorySlot }));
    const html = JSON.stringify(tree);
    assert.ok(html.includes('dm-chat'), 'no chat column');
    assert.ok(html.includes('dm-side'), 'no research-area column');
  });

  check('挂载期 effect 不抛（loadTree / 选区监听 / 会话解析）', () => {
    drainEffects();
  });
}

/* ── the workspace column, rendered on its own ─────────────────────────── */

console.log('研究区组件（左栏）');
{
  // The fragment is CJS-guarded, but the package is ESM, so evaluate it in a tiny CJS
  // wrapper instead of require().
  const source = await readFile(path.join(here, '..', 'src', 'client', '55-workspace.js'), 'utf8');
  const shim = { exports: {} };
  new Function('module', 'exports', source)(shim, shim.exports);
  const { createWorkspace } = shim.exports;
  check('片段导出了 createWorkspace', () => assert.equal(typeof createWorkspace, 'function'));

  const workspace = createWorkspace(React, utilForWorkspace());
  check('导出了三个组件与 css', () => {
    assert.equal(typeof workspace.DocList, 'function');
    assert.equal(typeof workspace.MemoryPanel, 'function');
    assert.equal(typeof workspace.DropOverlay, 'function');
    assert.ok(String(workspace.css).includes('.dm-doclist'));
    assert.ok(String(workspace.css).includes('.dm-mem'));
  });

  const docs = [
    { id: 'd1', name: 'a.md', ext: 'md', size: 120, chars: 120, hasText: true, sessionId: 's1' },
    { id: 'd2', name: 'b.docx', ext: 'docx', size: 900, chars: 0, hasText: false, sessionId: 's2' },
  ];

  check('空列表给出引导文案', () => {
    const tree = render(React.createElement(workspace.DocList, { docs: [], activeId: null, compareId: null }));
    assert.ok(JSON.stringify(tree).includes('拖进来'));
  });

  check('有文档时每篇一行，选中行带 is-active', () => {
    const tree = render(
      React.createElement(workspace.DocList, {
        docs,
        activeId: 'd1',
        compareId: 'd2',
        onSelect() {},
        onRemove() {},
        onCompare() {},
      }),
    );
    const html = JSON.stringify(tree);
    assert.ok(html.includes('a.md'));
    assert.ok(html.includes('b.docx'));
    assert.ok(html.includes('is-active'));
    assert.ok(html.includes('is-compare'));
  });

  check('研究记忆面板可渲染（有文档 / 无文档）', () => {
    const withDoc = render(
      React.createElement(workspace.MemoryPanel, {
        doc: docs[0],
        memory: '- 一条记忆',
        loading: false,
        error: null,
        onSave() {},
        onRefresh() {},
      }),
    );
    assert.ok(JSON.stringify(withDoc).includes('研究记忆'));
    const without = render(
      React.createElement(workspace.MemoryPanel, {
        doc: null,
        memory: '',
        loading: false,
        error: null,
        onSave() {},
        onRefresh() {},
      }),
    );
    assert.ok(JSON.stringify(without).includes('先打开'));
  });

  check('拖拽覆盖层只在 visible 时渲染', () => {
    assert.equal(render(React.createElement(workspace.DropOverlay, { visible: false })), null);
    assert.ok(JSON.stringify(render(React.createElement(workspace.DropOverlay, { visible: true }))).includes('dm-drop'));
  });
}

/* ── marks: engine + list ──────────────────────────────────────────────── */

console.log('划线');
{
  const load = async (file) => {
    const source = await readFile(path.join(here, '..', 'src', 'client', file), 'utf8');
    const shim = { exports: {} };
    new Function('module', 'exports', source)(shim, shim.exports);
    return shim.exports;
  };
  const engineExports = await load('52-highlights.js');
  const uiExports = await load('56-highlights-ui.js');
  const util = utilForWorkspace();

  check('引擎导出齐全', () => {
    assert.equal(typeof engineExports.createHighlights, 'function');
    const engine = engineExports.createHighlights(React, util);
    assert.equal(engine.COLORS.length, 3);
    assert.deepEqual(
      engine.COLORS.map((color) => color.id),
      ['key', 'question', 'review'],
    );
    assert.equal(typeof engine.computeAnchor, 'function');
    assert.equal(typeof engine.applyHighlights, 'function');
    assert.equal(typeof engine.scrollToHighlight, 'function');
    assert.ok(String(engine.css).includes('::highlight(dm-hl-key)'));
  });

  check('没有 CSS.highlights 时 applyHighlights 不抛', () => {
    const engine = engineExports.createHighlights(React, util);
    engine.applyHighlights(null, []);
    engine.applyHighlights({ querySelector: () => null }, [{ id: 'x', color: 'key', anchor: { scope: 'doc', start: 0, end: 3 } }]);
    assert.equal(engine.scrollToHighlight(null, { anchor: { scope: 'doc', start: 0, end: 3 } }), false);
  });

  check('UI 导出齐全且 CSS 有内容', () => {
    assert.equal(typeof uiExports.createHighlightsUi, 'function');
    const ui = uiExports.createHighlightsUi(React, util);
    assert.equal(typeof ui.HighlightList, 'function');
    assert.ok(String(ui.HighlightsCss).length > 200);
  });

  check('划线列表：空态 / 有内容 / 引用标记', () => {
    const ui = uiExports.createHighlightsUi(React, util);
    const empty = render(React.createElement(ui.HighlightList, { items: [], activeId: null }));
    assert.ok(JSON.stringify(empty).includes('划线'));

    const items = [
      {
        id: 'h1',
        color: 'key',
        text: '注意力的瓶颈不在算力',
        note: '',
        anchor: { scope: 'doc', page: null, start: 0, end: 10 },
        kind: 'mark',
        createdAt: Date.now(),
      },
      {
        id: 'q1',
        color: 'question',
        text: '上下文窗口',
        note: '',
        anchor: { scope: 'page', page: 2, start: 0, end: 5 },
        kind: 'quote',
        createdAt: Date.now(),
      },
    ];
    const tree = render(
      React.createElement(ui.HighlightList, {
        items,
        activeId: 'h1',
        onJump() {},
        onDelete() {},
        onNote() {},
        onAskAbout() {},
        onAskAll() {},
      }),
    );
    const html = JSON.stringify(tree);
    assert.ok(html.includes('注意力的瓶颈不在算力'), 'mark text missing');
    assert.ok(html.includes('上下文窗口'), 'quote text missing');
  });
}

/** The same helper surface `10-util.js` exposes, without re-parsing the bundle. */
function utilForWorkspace() {
  const h = React.createElement;
  return {
    h,
    cx: (...values) => values.filter(Boolean).join(' '),
    Icon: (props) => h('svg', { 'data-icon': props && props.name }),
    formatBytes: (bytes) => String(bytes) + ' B',
    oneLine: (text) => String(text),
    api: async () => ({ ok: true }),
    extOf: (name) => String(name).split('.').pop(),
    baseName: (value) => String(value),
    joinPath: (a, b) => a + '/' + b,
    dirName: (value) => String(value),
    stripExt: (value) => String(value),
    clamp: (value, lo, hi) => Math.min(hi, Math.max(lo, value)),
    lsGet: () => null,
    lsSet: () => {},
    lsDel: () => {},
    hashText: () => 'x',
    debounce: (fn) => fn,
    makeBoundary: () => () => null,
  };
}

console.log('PDF 目录');
{
  const pdfSource = await readFile(path.join(here, '..', 'src', 'client', '40-pdf.js'), 'utf8');
  const pdfShim = { exports: {} };
  new Function('module', 'exports', pdfSource)(pdfShim, pdfShim.exports);
  const pdf = pdfShim.exports.createPdfViewer(React);

  await checkAsync('PDF 大纲解析命名 / 显式目标，保留嵌套并跳过失效项', async () => {
    const pages = new Map([[3, 0], [7, 2], [9, 1]]);
    const doc = {
      numPages: 3,
      getOutline: async () => [
        {
          title: '  第一章\n  总览 ',
          dest: 'chapter',
          items: [{ title: '第一节', dest: [{ num: 7, gen: 0 }], items: [] }],
        },
        { title: '外部链接', url: 'https://example.com', items: [{ title: '子节', dest: 'child', items: [] }] },
        { title: '失效目标', dest: 'missing', items: [] },
      ],
      getDestination: async (name) => {
        if (name === 'chapter') return [{ num: 3, gen: 0 }];
        if (name === 'child') return [{ num: 9, gen: 0 }];
        throw new Error('unknown destination');
      },
      getPageIndex: async (ref) => {
        if (!pages.has(ref.num)) throw new Error('unknown page');
        return pages.get(ref.num);
      },
    };
    assert.deepEqual(await pdf._test.readOutline(doc), [
      { text: '第一章 总览', page: 1, depth: 0 },
      { text: '第一节', page: 3, depth: 1 },
      { text: '子节', page: 2, depth: 1 },
    ]);
  });

  await checkAsync('没有 PDF 大纲时返回空数组', async () => {
    assert.deepEqual(await pdf._test.readOutline({ getOutline: async () => null }), []);
    assert.deepEqual(await pdf._test.readOutline({}), []);
  });

  await checkAsync('宿主已有异版本 pdf.js 时使用自带库且不覆盖宿主', async () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const pdfPage = {
      getTextContent: async () => ({ items: [{ str: 'PDF 目录', hasEOL: true }], styles: {} }),
      cleanup() {},
    };
    const pdfDocument = {
      numPages: 1,
      getPage: async () => pdfPage,
      destroy: async () => {},
    };
    const bundledLib = {
      version: '3.11.174',
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.resolve(pdfDocument) }),
    };
    const hostLib = { version: '6.3.289', GlobalWorkerOptions: { workerSrc: 'host-worker' } };
    let insertions = 0;
    globalThis.window = { pdfjsLib: hostLib };
    globalThis.document = {
      querySelector: () => null,
      createElement: () => ({ setAttribute() {} }),
      head: {
        appendChild(script) {
          insertions += 1;
          setImmediate(() => {
            globalThis.window.pdfjsLib = bundledLib;
            script.onload();
          });
        },
      },
    };
    try {
      const first = await pdf.extractText('memory:outline-check');
      await pdf.extractText('memory:outline-check');
      assert.match(first.text, /PDF 目录/);
      assert.equal(insertions, 1);
      assert.equal(globalThis.window.pdfjsLib, hostLib);
      assert.equal(hostLib.GlobalWorkerOptions.workerSrc, 'host-worker');
      assert.equal(bundledLib.GlobalWorkerOptions.workerSrc, '/api/docmate/asset/pdfjs/pdf.worker.min.js');
      assert.equal(globalThis.window.__dmPdfJsLib__, bundledLib);
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }
  });

  const appSource = await readFile(path.join(here, '..', 'src', 'client', '70-app.js'), 'utf8');
  const appShim = { exports: {} };
  new Function('module', 'exports', appSource)(appShim, appShim.exports);
  const app = appShim.exports.createApp(React, utilForWorkspace(), {}, {}, {}, null, null, null, null);
  check('目录扫描使用 PDF 页码，同时保持 Markdown 标题归一化', () => {
    const pdfViewer = {
      querySelectorAll: () => [],
      querySelector: (selector) => (selector === '.dm-pdf-root' ? {} : null),
    };
    const pdfItems = [{ text: '第一章', page: 2, depth: 0 }, { text: '第一节', page: 3, depth: 1 }];
    assert.deepEqual(app._test.scanOutline(pdfViewer, pdfItems), pdfItems);
    assert.equal(app._test.scanOutline(pdfViewer, []), null);

    const h2 = { textContent: '标题', tagName: 'H2' };
    const h3 = { textContent: '小节', tagName: 'H3' };
    const markdownViewer = { querySelectorAll: () => [h2, h3], querySelector: () => null };
    const scanned = app._test.scanOutline(markdownViewer, null);
    assert.deepEqual(scanned.map((item) => item.depth), [0, 1]);
    assert.equal(scanned[0].node, h2);
  });
}

console.log('');
console.log(passed + ' 项通过' + (process.exitCode ? '（有失败）' : '，全绿'));
