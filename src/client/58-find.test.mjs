/* 58-find.test.mjs —— 纯 node 自测（不联网、不装包、不用 jsdom）
 * 被测片段是浏览器里的普通脚本，靠 CJS 守卫导出 createFind；这里用 new Function 把它
 * 塞进一个带 `module` 的作用域执行，和 build.mjs 拼进 factory 闭包的方式一致。
 *
 * 搜索的核心（收集文本 / 偏移映射 / 找命中）都写成了纯函数，所以「跨文本节点」「跳过
 * KaTeX 副本」「截断」这些行为可以用手工构造的假节点验证，不需要真 DOM 渲染。
 *
 * 运行：node src/client/58-find.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.join(here, '58-find.js');
const sourceText = fs.readFileSync(filePath, 'utf8');

/* ---------- 极简 assert + ok() 收集器 ---------- */

const failures = [];
let passed = 0;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message || '断言失败');
}

assert.equal = function equal(actual, expected, message) {
  if (actual !== expected) {
    fail(
      (message ? message + '：' : '') +
        '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual),
    );
  }
};

assert.deepEqual = function deepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail((message ? message + '：' : '') + '期望 ' + b + '，实际 ' + a);
};

assert.ok = function okValue(value, message) {
  if (!value) fail(message || '期望为真，实际 ' + JSON.stringify(value));
};

assert.doesNotThrow = function doesNotThrow(fn, message) {
  try {
    fn();
  } catch (error) {
    fail((message ? message + '：' : '') + '不该抛异常，实际抛了 ' + String((error && error.message) || error));
  }
};

function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  \u2713 ' + name);
  } catch (error) {
    failures.push({ name: name, error: error });
    console.error('  \u2717 ' + name);
    console.error('    ' + String((error && error.message) || error));
  }
}

/* ---------- 加载被测片段 ---------- */

const cjsModule = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('module', 'exports', sourceText)(cjsModule, cjsModule.exports);
const { createFind } = cjsModule.exports;
assert.equal(typeof createFind, 'function', 'module.exports.createFind 必须是函数');

/* ---------- 假 React（只够跑 FindBar） ---------- */

function makeFakeReact() {
  return {
    createElement: (type, props, ...children) => ({ t: type, p: props || {}, c: children.flat() }),
    // 渲染期 React 不会执行 effect；假 React 也不执行，否则会碰到空 ref。
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
  };
}

const fakeUtil = {
  cx: (...parts) => parts.filter(Boolean).join(' '),
  Icon: (props) => ({ t: 'icon', p: { name: props && props.name }, c: [] }),
};

const find = createFind(makeFakeReact(), fakeUtil);

/* ---------- 假 DOM ---------- */

/** 文本节点：只带搜索真正会读的字段。 */
function tNode(value) {
  return { nodeType: 3, nodeValue: value, parentNode: null };
}

/** 元素节点：className / aria-hidden / childNodes 足够跑过滤与遍历。 */
function el(tagName, attrs, children) {
  const node = {
    nodeType: 1,
    tagName: String(tagName || 'div').toUpperCase(),
    className: (attrs && attrs.className) || '',
    childNodes: [],
    parentNode: null,
    getAttribute(name) {
      if (!attrs) return null;
      if (!Object.prototype.hasOwnProperty.call(attrs, name)) return null;
      return attrs[name] === null || attrs[name] === undefined ? null : String(attrs[name]);
    },
  };
  (children || []).forEach((child) => {
    child.parentNode = node;
    node.childNodes.push(child);
  });
  return node;
}

function box(children) {
  return el('div', {}, children);
}

/** 从假容器里取纯文本（只用于断言，不参与被测逻辑）。 */
function plainText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return String(node.nodeValue || '');
  let out = '';
  (node.childNodes || []).forEach((child) => {
    out += plainText(child);
  });
  return out;
}

/* ---------- 渲染树小工具 ---------- */

function findAll(node, pred, acc = []) {
  if (node === null || node === undefined) return acc;
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, pred, acc));
    return acc;
  }
  if (typeof node === 'object' && 't' in node) {
    if (pred(node)) acc.push(node);
    findAll(node.c, pred, acc);
  }
  return acc;
}

function treeText(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(treeText).join('');
  if (typeof node === 'object') {
    if ('t' in node) return treeText(node.c);
    return '';
  }
  return '';
}

function classesOf(node) {
  return String((node && node.p && node.p.className) || '')
    .split(/\s+/)
    .filter(Boolean);
}

function hasClass(node, name) {
  return classesOf(node).indexOf(name) >= 0;
}

function iconNameOf(node) {
  if (!node || node.t !== fakeUtil.Icon) return null;
  return (node.p && node.p.name) || null;
}

/* ================= [1] 纯文本命中 ================= */
console.log('\n[1] 纯文本命中');

ok('单次命中：结果数 / 预览 / 节点', () => {
  const container = box([tNode('Hello world, this is DocMate.')]);
  const result = find.findIn(container, 'world');
  assert.equal(result.matches.length, 1);
  assert.equal(result.truncated, false);
  const match = result.matches[0];
  assert.equal(match.preview, 'Hello world, this is DocMate.');
  assert.equal(match.node, container.childNodes[0], 'node 应是第一个 Range 的起始文本节点');
  assert.deepEqual(match.ranges, [], '没有 Range API 的环境里 ranges 为空，但命中照样数出来');
});

ok('多次命中互不重叠', () => {
  const container = box([tNode('cat dog cat bird cat')]);
  const result = find.findIn(container, 'cat');
  assert.equal(result.matches.length, 3);
  assert.equal(result.matches[0].preview, 'cat dog cat bird cat');
});

ok('重叠串按不重叠算（aaaa 里 aa 是 2 个）', () => {
  const result = find.findIn(box([tNode('aaaa')]), 'aa');
  assert.equal(result.matches.length, 2);
});

ok('大小写不敏感（两边都 toLowerCase）', () => {
  const container = box([tNode('DeepSeek Harness 与 deepseek harness')]);
  assert.equal(find.findIn(container, 'deepseek').matches.length, 2);
  assert.equal(find.findIn(container, 'DEEPSEEK').matches.length, 2);
  assert.equal(find.findIn(container, 'DeepSeek').matches.length, 2);
});

ok('中文命中', () => {
  const container = box([tNode('碘吸附 DFT 计算实战手册')]);
  const result = find.findIn(container, '吸附');
  assert.equal(result.matches.length, 1);
  assert.ok(result.matches[0].preview.indexOf('碘吸附') >= 0, '预览应带上下文');
  assert.equal(find.findIn(container, '不存在的词').matches.length, 0);
});

ok('预览在长文本里带省略号', () => {
  const long = '前'.repeat(60) + '目标' + '后'.repeat(60);
  const result = find.findIn(box([tNode(long)]), '目标');
  assert.equal(result.matches.length, 1);
  const preview = result.matches[0].preview;
  assert.ok(preview.startsWith('…'), '前面被截断应有前导省略号：' + preview);
  assert.ok(preview.endsWith('…'), '后面被截断应有尾省略号：' + preview);
  assert.ok(preview.length <= 92, '预览不该比上下文半径还长：' + preview.length);
});

/* ================= [2] 跨文本节点 ================= */
console.log('\n[2] 跨文本节点');

ok('命中横跨两个文本节点（<strong> 把句子切开）', () => {
  const container = box([tNode('Hello '), el('strong', {}, [tNode('world')])]);
  assert.equal(plainText(container), 'Hello world');
  const result = find.findIn(container, 'o world');
  assert.equal(result.matches.length, 1, '跨节点的命中必须能拼出来');
  assert.equal(result.matches[0].node, container.childNodes[0]);
});

ok('跨三个文本节点', () => {
  const container = box([tNode('ab'), el('em', {}, [tNode('cd')]), tNode('ef')]);
  const result = find.findIn(container, 'bcde');
  assert.equal(result.matches.length, 1);
});

ok('locate：全局区间切回每个节点的局部区间', () => {
  const n1 = tNode('ab');
  const n2 = tNode('cd');
  const bag = find.collectText([
    { node: n1, text: 'ab' },
    { node: n2, text: 'cd' },
  ]);
  assert.equal(bag.text, 'abcd');
  assert.deepEqual(bag.offsets, [
    { node: n1, start: 0, end: 2 },
    { node: n2, start: 2, end: 4 },
  ]);
  assert.deepEqual(find.locate(bag.offsets, 1, 3), [
    { node: n1, start: 1, end: 2 },
    { node: n2, start: 0, end: 1 },
  ]);
  assert.deepEqual(find.locate(bag.offsets, 0, 4), [
    { node: n1, start: 0, end: 2 },
    { node: n2, start: 0, end: 2 },
  ]);
});

ok('locate：边界上的零长度段被丢掉', () => {
  const bag = find.collectText([
    { node: tNode('ab'), text: 'ab' },
    { node: tNode('cd'), text: 'cd' },
  ]);
  assert.deepEqual(find.locate(bag.offsets, 2, 3), [{ node: bag.offsets[1].node, start: 0, end: 1 }]);
  assert.deepEqual(find.locate(bag.offsets, 3, 3), []);
});

ok('collectText：空文本节点不占位', () => {
  const bag = find.collectText([
    { node: tNode(''), text: '' },
    { node: tNode('ab'), text: 'ab' },
    { node: tNode(''), text: '' },
    { node: tNode('cd'), text: 'cd' },
  ]);
  assert.equal(bag.text, 'abcd');
  assert.equal(bag.offsets.length, 2);
  assert.equal(bag.offsets[1].start, 2);
});

ok('collectText：接受裸字符串条目（单测省事）', () => {
  const bag = find.collectText(['ab', null, '', 'cd']);
  assert.equal(bag.text, 'abcd');
  assert.equal(bag.offsets.length, 2);
});

/* ================= [3] KaTeX 双份文字只算一次 ================= */
console.log('\n[3] KaTeX 副本去重');

function katexTree(text) {
  const mathmlText = tNode(text);
  const htmlText = tNode(text);
  const container = box([
    el('span', { className: 'katex' }, [
      el('span', { className: 'katex-mathml' }, [el('math', {}, [mathmlText])]),
      // KaTeX 给可见那份标了 aria-hidden="true"，但它才是用户看到的那份。
      el('span', { className: 'katex-html', 'aria-hidden': 'true' }, [htmlText]),
    ]),
  ]);
  return { container: container, mathmlText: mathmlText, htmlText: htmlText };
}

ok('两个副本只命中一次，且留下的是可见那份', () => {
  const tree = katexTree('E=mc2');
  const result = find.findIn(tree.container, 'E=mc2');
  assert.equal(result.matches.length, 1, 'MathML 副本必须被跳过，否则每个公式都数两遍');
  assert.equal(result.matches[0].node, tree.htmlText, '留下的应是 .katex-html 里的可见文本');
});

ok('collectText 自己也过滤 .katex-mathml（纯函数层不能假设调用方剪过枝）', () => {
  const tree = katexTree('E=mc2');
  const bag = find.collectText([
    { node: tree.mathmlText, text: 'E=mc2' },
    { node: tree.htmlText, text: 'E=mc2' },
  ]);
  assert.equal(bag.text, 'E=mc2');
  assert.equal(bag.offsets.length, 1);
});

ok('公式前后的正文照常可搜', () => {
  const tree = katexTree('E=mc2');
  tree.container.childNodes.push(tNode(' 质能方程'));
  assert.equal(find.findIn(tree.container, '质能').matches.length, 1);
  assert.equal(find.findIn(tree.container, 'E=mc2').matches.length, 1);
});

ok('script / style / aria-hidden 子树不进索引', () => {
  const container = box([
    el('script', {}, [tNode('var secret = 1;')]),
    el('style', {}, [tNode('.x{color:red}')]),
    el('span', { 'aria-hidden': 'true' }, [tNode('装饰文字')]),
    tNode('正文'),
  ]);
  assert.equal(find.findIn(container, 'secret').matches.length, 0);
  assert.equal(find.findIn(container, 'color').matches.length, 0);
  assert.equal(find.findIn(container, '装饰').matches.length, 0);
  assert.equal(find.findIn(container, '正文').matches.length, 1);
});

ok('搜索条自己不进索引（否则计数文字会自我命中）', () => {
  const container = box([
    tNode('正文'),
    el('div', { className: 'dm-find' }, [
      el('span', { className: 'dm-find__count' }, [tNode('无结果')]),
      el('input', { className: 'dm-find__input' }, []),
    ]),
  ]);
  assert.equal(find.findIn(container, '无结果').matches.length, 0, '浮条上的计数文字不该被搜到');
  assert.equal(find.findIn(container, '正文').matches.length, 1);
});

/* ================= [4] 空 query / 空容器 ================= */
console.log('\n[4] 边界输入');

ok('空 query → 0 命中、不截断', () => {
  const container = box([tNode('abc')]);
  for (const query of ['', null, undefined]) {
    const result = find.findIn(container, query);
    assert.equal(result.matches.length, 0, 'query=' + String(query));
    assert.equal(result.truncated, false);
  }
});

ok('空容器 / null 容器不抛异常', () => {
  assert.equal(find.findIn(box([]), 'x').matches.length, 0);
  assert.equal(find.findIn(null, 'x').matches.length, 0);
  assert.equal(find.findIn(undefined, 'x').matches.length, 0);
});

ok('searchText：空 query / 空文本', () => {
  assert.deepEqual(find.searchText('', 'x'), { spans: [], truncated: false });
  assert.deepEqual(find.searchText('abc', ''), { spans: [], truncated: false });
  assert.deepEqual(find.searchText('abc', 'b'), { spans: [{ start: 1, end: 2 }], truncated: false });
});

/* ================= [5] 上限与截断 ================= */
console.log('\n[5] 上限 2000 / truncated');

ok('超过上限：返回上限条数且 truncated=true', () => {
  const container = box([tNode('x '.repeat(10))]);
  const result = find.findIn(container, 'x', { limit: 3 });
  assert.equal(result.matches.length, 3);
  assert.equal(result.truncated, true);
});

ok('正好等于上限：不算截断', () => {
  const container = box([tNode('x '.repeat(3))]);
  const result = find.findIn(container, 'x', { limit: 3 });
  assert.equal(result.matches.length, 3);
  assert.equal(result.truncated, false);
});

ok('默认上限就是 2000', () => {
  const container = box([tNode('a '.repeat(2100))]);
  const result = find.findIn(container, 'a');
  assert.equal(result.matches.length, 2000);
  assert.equal(result.truncated, true);
});

ok('searchText：limit 参数同样生效', () => {
  const found = find.searchText('aaaaa', 'a', 2);
  assert.equal(found.spans.length, 2);
  assert.equal(found.truncated, true);
});

/* ================= [6] 涂色 / 清空 ================= */
console.log('\n[6] paintMatches / clearMatches');

ok('没有 CSS.highlights 时静默返回 false', () => {
  assert.equal(find.paintMatches([{ ranges: [{}] }], 0), false);
  assert.equal(find.clearMatches(), false);
});

ok('有注册表时写 dm-find / dm-find-current，清空时删掉', () => {
  const registry = new Map();
  globalThis.CSS = { highlights: registry };
  globalThis.Highlight = class FakeHighlight {
    constructor(...ranges) {
      this.ranges = ranges;
    }
  };
  try {
    const rangesA = [{ id: 'a1' }, { id: 'a2' }];
    const rangesB = [{ id: 'b1' }];
    const painted = find.paintMatches([{ ranges: rangesA }, { ranges: rangesB }], 1);
    assert.equal(painted, true);
    assert.equal(registry.get('dm-find').ranges.length, 3, '所有命中的 Range 都要进 dm-find');
    assert.equal(registry.get('dm-find-current').ranges.length, 1, '当前命中单独一份');
    assert.equal(registry.get('dm-find-current').ranges[0].id, 'b1');

    // 越界的 index 按 0 处理，不涂错也不抛
    find.paintMatches([{ ranges: rangesA }, { ranges: rangesB }], 99);
    assert.equal(registry.get('dm-find-current').ranges[0].id, 'a1');

    // 没有命中时两个注册项都该消失，而不是留一份空的
    find.paintMatches([], 0);
    assert.equal(registry.has('dm-find'), false);
    assert.equal(registry.has('dm-find-current'), false);

    find.paintMatches([{ ranges: rangesA }], 0);
    assert.equal(find.clearMatches(), true);
    assert.equal(registry.has('dm-find'), false);
    assert.equal(registry.has('dm-find-current'), false);
  } finally {
    delete globalThis.CSS;
    delete globalThis.Highlight;
  }
});

/* ================= [7] scrollToMatch ================= */
console.log('\n[7] scrollToMatch');

ok('有可滚祖先时只改它的 scrollTop，不退到 scrollIntoView', () => {
  const host = box([tNode('hit')]);
  const text = host.childNodes[0];
  host.scrollHeight = 1000;
  host.clientHeight = 200;
  host.scrollTop = 0;
  host.getBoundingClientRect = () => ({ top: 0, bottom: 200, height: 200 });
  let intoViewCalls = 0;
  host.scrollIntoView = () => {
    intoViewCalls += 1;
  };
  const range = {
    startContainer: text,
    getBoundingClientRect: () => ({ top: 500, bottom: 520, height: 20 }),
  };
  assert.equal(find.scrollToMatch(host, { ranges: [range] }), true);
  assert.ok(host.scrollTop > 400 && host.scrollTop < 500, 'scrollTop=' + host.scrollTop);
  assert.equal(intoViewCalls, 0, '不该退到 scrollIntoView');
});

ok('找不到可滚祖先时退到 scrollIntoView({block:center})', () => {
  const host = box([tNode('hit')]);
  const text = host.childNodes[0];
  const calls = [];
  host.scrollIntoView = (options) => calls.push(options);
  const match = { ranges: [{ startContainer: text }] };
  assert.equal(find.scrollToMatch(host, match), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].block, 'center');
});

ok('没有 node / 无法滚时返回 false', () => {
  assert.equal(find.scrollToMatch(box([]), {}), false);
  assert.equal(find.scrollToMatch(null, null), false);
  const host = box([tNode('hit')]);
  const text = host.childNodes[0];
  delete host.scrollIntoView;
  assert.equal(find.scrollToMatch(host, { ranges: [{ startContainer: text }] }), false);
});

/* ================= [8] FindBar 契约 ================= */
console.log('\n[8] FindBar 的 props 契约');

function renderBar(props) {
  return find.FindBar(props);
}

function barParts(tree) {
  return {
    root: tree,
    input: findAll(tree, (node) => node.t === 'input')[0],
    count: findAll(tree, (node) => hasClass(node, 'dm-find__count'))[0],
    buttons: findAll(tree, (node) => node.t === 'button' && hasClass(node, 'dm-find__btn')),
  };
}

ok('输入框：受控 value / placeholder / onChange', () => {
  let typed = null;
  const parts = barParts(
    renderBar({
      query: '碘',
      count: 3,
      index: 1,
      onQuery: (value) => {
        typed = value;
      },
      onPrev: () => {},
      onNext: () => {},
      onClose: () => {},
    }),
  );
  assert.ok(hasClass(parts.root, 'dm-find'), '根节点要有 dm-find 类');
  assert.ok(parts.input, '应有 input');
  assert.equal(parts.input.p.type, 'text');
  assert.equal(parts.input.p.value, '碘');
  assert.equal(parts.input.p.placeholder, '在文档里搜索…');
  assert.equal(typeof parts.input.p.onChange, 'function');
  parts.input.p.onChange({ target: { value: '吸附' } });
  assert.equal(typed, '吸附');
});

ok('计数显示 index+1 / count，count 为 0 显示「无结果」', () => {
  assert.equal(treeText(barParts(renderBar({ query: 'x', count: 3, index: 1 })).count), '2 / 3');
  assert.equal(treeText(barParts(renderBar({ query: 'x', count: 1, index: 0 })).count), '1 / 1');
  assert.equal(treeText(barParts(renderBar({ query: 'x', count: 0, index: 0 })).count), '无结果');
});

ok('index 越界时夹到有效范围（命中数变少不会显示 6 / 3）', () => {
  assert.equal(treeText(barParts(renderBar({ query: 'x', count: 3, index: 9 })).count), '3 / 3');
  assert.equal(treeText(barParts(renderBar({ query: 'x', count: 3, index: -2 })).count), '1 / 3');
});

ok('三个图标按钮：上一个 / 下一个 / 关闭', () => {
  const parts = barParts(renderBar({ query: 'x', count: 2, index: 0 }));
  assert.equal(parts.buttons.length, 3);
  const icons = parts.buttons.map((node) => iconNameOf(node.c[0]));
  assert.deepEqual(icons, ['left', 'right', 'close']);
  assert.ok(hasClass(parts.buttons[0], 'dm-find__btn--prev'));
  assert.ok(hasClass(parts.buttons[1], 'dm-find__btn--next'));
  assert.ok(hasClass(parts.buttons[2], 'dm-find__btn--close'));
  assert.equal(parts.buttons[0].p.disabled, false);
  assert.equal(parts.buttons[2].p.disabled, false, '关闭按钮永远可用');
});

ok('count 为 0 时上一个 / 下一个禁用，关闭仍可用', () => {
  const parts = barParts(renderBar({ query: 'zzz', count: 0, index: 0 }));
  assert.equal(parts.buttons[0].p.disabled, true);
  assert.equal(parts.buttons[1].p.disabled, true);
  assert.equal(parts.buttons[2].p.disabled, false);
});

ok('Enter → onNext，Shift+Enter → onPrev，Escape → onClose', () => {
  const calls = [];
  const parts = barParts(
    renderBar({
      query: 'x',
      count: 2,
      index: 0,
      onPrev: () => calls.push('prev'),
      onNext: () => calls.push('next'),
      onClose: () => calls.push('close'),
    }),
  );
  let prevented = 0;
  const event = (extra) =>
    Object.assign(
      {
        key: '',
        shiftKey: false,
        preventDefault() {
          prevented += 1;
        },
      },
      extra,
    );

  parts.input.p.onKeyDown(event({ key: 'Enter' }));
  parts.input.p.onKeyDown(event({ key: 'Enter', shiftKey: true }));
  parts.input.p.onKeyDown(event({ key: 'Escape' }));
  assert.deepEqual(calls, ['next', 'prev', 'close']);
  assert.equal(prevented, 3, '三个键都要 preventDefault，否则会漏到全局快捷键');
});

ok('按钮点击走回调，且 mousedown 不抢输入框焦点', () => {
  const calls = [];
  const parts = barParts(
    renderBar({
      query: 'x',
      count: 2,
      index: 0,
      onPrev: () => calls.push('prev'),
      onNext: () => calls.push('next'),
      onClose: () => calls.push('close'),
    }),
  );
  let prevented = 0;
  const mousedown = {
    preventDefault() {
      prevented += 1;
    },
  };
  parts.buttons[0].p.onMouseDown(mousedown);
  parts.buttons[1].p.onMouseDown(mousedown);
  parts.buttons[0].p.onClick();
  parts.buttons[1].p.onClick();
  parts.buttons[2].p.onClick();
  assert.deepEqual(calls, ['prev', 'next', 'close']);
  assert.equal(prevented, 2, 'mousedown 要 preventDefault，焦点才留在输入框');
});

ok('props 兜底：空 props / 缺回调都不抛', () => {
  const tree = renderBar({});
  const parts = barParts(tree);
  assert.equal(tree.t, 'div');
  assert.equal(parts.input.p.value, '');
  assert.equal(treeText(parts.count), '无结果');
  assert.doesNotThrow(() => parts.input.p.onChange({ target: { value: 'a' } }));
  assert.doesNotThrow(() => parts.input.p.onKeyDown({ key: 'Enter' }));
  assert.doesNotThrow(() => parts.input.p.onKeyDown(null));
  assert.doesNotThrow(() => parts.buttons[0].p.onClick());
});

/* ================= [9] 样式 ================= */
console.log('\n[9] css 字符串');

ok('两条 ::highlight 规则逐字存在', () => {
  assert.ok(find.css.includes('::highlight(dm-find){background-color: rgba(255,196,0,.32);}'));
  assert.ok(find.css.includes('::highlight(dm-find-current){background-color: rgba(255,140,0,.55);}'));
});

ok('搜索条样式齐全、窄面板不挤爆', () => {
  assert.ok(find.css.includes('.dm-find {'));
  assert.ok(find.css.includes('.dm-find__input'));
  assert.ok(find.css.includes('.dm-find__count'));
  assert.ok(find.css.includes('.dm-find__btn'));
  assert.ok(
    find.css.includes('width: min(320px, calc(100% - 24px))'),
    '窄面板下要收窄，不能撑破阅读区',
  );
});

ok('颜色只用 --dm-* 变量（::highlight 那两行是规格指定的例外）', () => {
  const body = find.css
    .split('\n')
    .filter((line) => line.indexOf('::highlight(') < 0)
    .join('\n');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(body), '不该出现写死的 hex 颜色');
  assert.ok(!/\brgba?\s*\(/.test(body), '不该出现写死的 rgb / rgba 颜色');
  assert.ok(!/\bhsla?\s*\(/.test(body), '不该出现写死的 hsl / hsla 颜色');
  for (const token of [
    '--dm-bg',
    '--dm-bg-1',
    '--dm-line',
    '--dm-text',
    '--dm-text-2',
    '--dm-text-3',
    '--dm-accent',
    '--dm-accent-soft',
    '--dm-shadow',
  ]) {
    assert.ok(find.css.indexOf('var(' + token + ')') >= 0, '样式里应用到 ' + token);
  }
});

/* ================= [10] 源码约束 ================= */
console.log('\n[10] 源码约束（片段契约）');

ok('无 import / export / require / 顶层 await', () => {
  assert.ok(!/^\s*import\s/m.test(sourceText), '不得有 import');
  assert.ok(!/^\s*export\s/m.test(sourceText), '不得有 export');
  assert.ok(!/\brequire\s*\(/.test(sourceText), '不得 require 其它模块');
  assert.ok(!/^\s*await\s/m.test(sourceText), '不得有顶层 await');
  assert.ok(!sourceText.includes('dangerously' + 'SetInnerHTML'), '不得使用原始 HTML 注入');
});

ok('文件末尾是 CJS 导出守卫', () => {
  assert.ok(
    /if \(typeof module !== 'undefined' && module\.exports\) module\.exports = \{ createFind \};/.test(
      sourceText,
    ),
    '缺少导出守卫',
  );
  assert.ok(sourceText.trimEnd().endsWith('module.exports = { createFind };'), '守卫必须在文件末尾');
});

ok('浏览器环境（无 module）下片段可安全执行', () => {
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    const factory = new Function('React', 'util', sourceText + '\nreturn createFind;');
    const make = factory(makeFakeReact(), fakeUtil);
    const moduleInBrowser = make(makeFakeReact(), fakeUtil);
    assert.equal(typeof moduleInBrowser.FindBar, 'function');
    assert.equal(typeof moduleInBrowser.findIn, 'function');
  });
});

ok('六个契约导出齐全', () => {
  for (const name of [
    'FindBar',
    'findIn',
    'paintMatches',
    'clearMatches',
    'scrollToMatch',
    'css',
  ]) {
    assert.ok(find[name] !== undefined && find[name] !== null, '缺少导出 ' + name);
  }
  assert.equal(typeof find.FindBar, 'function');
  assert.equal(typeof find.findIn, 'function');
  assert.equal(typeof find.paintMatches, 'function');
  assert.equal(typeof find.clearMatches, 'function');
  assert.equal(typeof find.scrollToMatch, 'function');
  assert.equal(typeof find.css, 'string');
});

/* ================= 汇总 ================= */
if (failures.length) {
  console.error('\n失败：' + failures.length + ' 组，通过 ' + passed + ' 组。');
  for (const item of failures) {
    console.error('  · ' + item.name + ' —— ' + String((item.error && item.error.message) || item.error));
  }
  process.exitCode = 1;
} else {
  console.log('\n全部通过：' + passed + ' 组断言。');
}
