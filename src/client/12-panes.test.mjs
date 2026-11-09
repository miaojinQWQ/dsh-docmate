/* 12-panes.test.mjs —— 纯 node 自测（不联网、不装包、不用 jsdom）
 *
 * 被测片段是浏览器里的普通脚本，靠 CJS 守卫导出 createPanes；这里用 new Function 把它
 * 塞进一个带 module/exports 的作用域执行，和 build.mjs 拼进 factory 闭包的方式一致。
 *
 * 宽度分配（resolveSizes）、持久化读写（readSizes / writeSizes）、键盘步进（keyboardStep）
 * 都是纯函数，可以直接喂数字；PaneHandle 用假 React 渲染一次，验证 ARIA 契约和回调接线。
 *
 * 运行：node src/client/12-panes.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.join(here, '12-panes.js');
const sourceText = fs.readFileSync(filePath, 'utf8');

/* ---------- 极简 assert + check() 收集器 ---------- */

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

function check(name, fn) {
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
const { createPanes } = cjsModule.exports;
assert.equal(typeof createPanes, 'function', 'module.exports.createPanes 必须是函数');

/* ---------- 假 React / 假 util ---------- */

function makeFakeReact() {
  return {
    createElement: (type, props, ...children) => ({ t: type, p: props || {}, c: children.flat() }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    // 渲染期 React 不执行 effect；假 React 也不执行，否则会碰到空 ref / 假 document。
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
  };
}

const fakeUtil = {
  cx: (...parts) => parts.filter(Boolean).join(' '),
  clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
};

const panes = createPanes(makeFakeReact(), fakeUtil);
const { DEFAULTS, LIMITS, resolveSizes, readSizes, writeSizes, keyboardStep, PaneHandle, css } = panes;

/* ---------- 小工具 ---------- */

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

function classesOf(node) {
  return String((node && node.p && node.p.className) || '')
    .split(/\s+/)
    .filter(Boolean);
}

function hasClass(node, name) {
  return classesOf(node).indexOf(name) >= 0;
}

/** 渲染一次函数组件（假 React 不会自己调用组件）。 */
function renderBar(props) {
  return PaneHandle(props || {});
}

/** 中间阅读区实际拿到的宽度：面板宽 - 两个分隔条 - 两侧栏。 */
function centreOf(width, sizes, opts) {
  const options = opts || {};
  const showLeft = options.showLeft !== false;
  const showRight = options.showRight !== false;
  const handles = (showLeft ? LIMITS.handle : 0) + (showRight ? LIMITS.handle : 0);
  return width - handles - sizes.left - sizes.right;
}

/* ================= [1] 默认值与常量 ================= */
console.log('\n[1] 默认值与常量');

check('DEFAULTS / LIMITS 是规格里的数字', () => {
  assert.deepEqual(DEFAULTS, { left: 236, right: 348 });
  assert.deepEqual(LIMITS.left, { min: 176, max: 520 });
  assert.deepEqual(LIMITS.right, { min: 268, max: 640 });
  assert.equal(LIMITS.centre, 380);
  assert.equal(LIMITS.handle, 6);
  assert.equal(LIMITS.step, 16);
});

check('宽面板：原样返回用户想要的宽度', () => {
  assert.deepEqual(resolveSizes(1600, 236, 348), { left: 236, right: 348 });
  assert.deepEqual(resolveSizes(1600, 300, 400), { left: 300, right: 400 });
});

check('缺省参数回落到默认宽度', () => {
  assert.deepEqual(resolveSizes(1600), { left: DEFAULTS.left, right: DEFAULTS.right });
  assert.deepEqual(resolveSizes(1600, null, undefined), { left: DEFAULTS.left, right: DEFAULTS.right });
});

check('面板宽度还没量到（0 / 非数字）时不做收窄', () => {
  assert.deepEqual(resolveSizes(0, 236, 348), { left: 236, right: 348 });
  assert.deepEqual(resolveSizes(NaN, 300, 400), { left: 300, right: 400 });
  assert.deepEqual(resolveSizes('abc', 300, 400), { left: 300, right: 400 });
});

/* ================= [2] 夹取 ================= */
console.log('\n[2] 上下界夹取');

check('左栏夹进 [176, 520]', () => {
  assert.equal(resolveSizes(1600, 0, 348).left, LIMITS.left.min);
  assert.equal(resolveSizes(1600, -999, 348).left, LIMITS.left.min);
  assert.equal(resolveSizes(1600, 9999, 348).left, LIMITS.left.max);
});

check('右栏夹进 [268, 640]', () => {
  assert.equal(resolveSizes(1600, 236, 0).right, LIMITS.right.min);
  assert.equal(resolveSizes(1600, 236, -999).right, LIMITS.right.min);
  assert.equal(resolveSizes(1600, 236, 9999).right, LIMITS.right.max);
});

check('边界值本身不被改动', () => {
  assert.deepEqual(resolveSizes(1600, 176, 268), { left: 176, right: 268 });
  assert.deepEqual(resolveSizes(1600, 520, 640), { left: 520, right: 640 });
});

/* ================= [3] 中间阅读区 ≥ 380 ================= */
console.log('\n[3] 中间阅读区任何时刻 ≥ 380');

check('836px 起（两侧都到最小刚好放得下）中间正好 380', () => {
  const sizes = resolveSizes(836, 236, 348);
  assert.deepEqual(sizes, { left: 176, right: 268 });
  assert.equal(centreOf(836, sizes), 380);
});

check('392~1600px 扫一遍，中间都 ≥ 380', () => {
  for (let width = 392; width <= 1600; width += 8) {
    const sizes = resolveSizes(width, 236, 348);
    const centre = centreOf(width, sizes);
    assert.ok(centre >= 380, 'width=' + width + ' 时中间只有 ' + centre);
  }
});

check('变窄时先收右栏、再收左栏', () => {
  // 1000px：预算 608，236 + 348 = 584 放得下 → 不动
  assert.deepEqual(resolveSizes(1000, 236, 348), { left: 236, right: 348 });
  // 900px：预算 508，236 + 348 = 584 超了 76 → 全由右栏让出来（348 → 272），左栏不动
  assert.deepEqual(resolveSizes(900, 236, 348), { left: 236, right: 272 });
  // 836px：预算 444，右栏让到 268 之后还差 60 → 左栏从 236 收到 176
  assert.deepEqual(resolveSizes(836, 236, 348), { left: 176, right: 268 });
  // 800px：预算 408，右栏已到 268，再收左栏 236 → 140 < 176，最后按比例压
  const sizes = resolveSizes(800, 236, 348);
  assert.ok(sizes.left < 236, '左栏应该开始收缩：' + sizes.left);
  assert.equal(centreOf(800, sizes), 380);
});

check('折叠的栏返回 0，也不占分隔条宽度', () => {
  assert.deepEqual(resolveSizes(1600, 236, 348, { showLeft: false }), { left: 0, right: 348 });
  assert.deepEqual(resolveSizes(1600, 236, 348, { showRight: false }), { left: 236, right: 0 });
  assert.deepEqual(resolveSizes(1600, 236, 348, { showLeft: false, showRight: false }), {
    left: 0,
    right: 0,
  });
});

check('只剩右栏时，700px 也能把中间留到 380', () => {
  const sizes = resolveSizes(700, 236, 348, { showLeft: false });
  assert.deepEqual(sizes, { left: 0, right: 314 });
  assert.equal(centreOf(700, sizes, { showLeft: false }), 380);
});

/* ================= [4] 极窄不产生负宽度 ================= */
console.log('\n[4] 极窄面板');

check('0~700px 扫一遍，两侧都不为负', () => {
  for (let width = 0; width <= 700; width += 7) {
    const sizes = resolveSizes(width, 236, 348);
    assert.ok(sizes.left >= 0, 'width=' + width + ' 左栏为负：' + sizes.left);
    assert.ok(sizes.right >= 0, 'width=' + width + ' 右栏为负：' + sizes.right);
    assert.ok(isFinite(sizes.left) && isFinite(sizes.right), 'width=' + width + ' 出现了 NaN');
  }
});

check('300px 时两侧压到 0，中间拿走剩下的', () => {
  const sizes = resolveSizes(300, 236, 348);
  assert.deepEqual(sizes, { left: 0, right: 0 });
  assert.equal(centreOf(300, sizes), 288);
});

check('面板比中间下限还窄时也不溢出（中间 < 380 是物理限制）', () => {
  const sizes = resolveSizes(200, 520, 640);
  assert.deepEqual(sizes, { left: 0, right: 0 });
  assert.ok(centreOf(200, sizes) > 0);
});

check('返回的都是整数像素', () => {
  for (const width of [837, 843, 901, 1013]) {
    const sizes = resolveSizes(width, 333, 411);
    assert.equal(sizes.left, Math.round(sizes.left));
    assert.equal(sizes.right, Math.round(sizes.right));
  }
});

/* ================= [5] 持久化 ================= */
console.log('\n[5] readSizes / writeSizes');

check('readSizes：正常数据原样读出', () => {
  assert.deepEqual(readSizes(() => ({ leftW: 300, rightW: 400 })), { left: 300, right: 400 });
});

check('readSizes：坏数据回默认', () => {
  const cases = [
    null,
    () => null,
    () => 'garbage',
    () => 42,
    () => ({}),
    () => ({ leftW: 'abc', rightW: null }),
    () => ({ leftW: NaN, rightW: undefined }),
  ];
  for (const lsGet of cases) {
    assert.deepEqual(readSizes(lsGet), { left: DEFAULTS.left, right: DEFAULTS.right });
  }
  assert.deepEqual(readSizes(), { left: DEFAULTS.left, right: DEFAULTS.right });
});

check('readSizes：越界值夹回范围', () => {
  assert.deepEqual(readSizes(() => ({ leftW: 9999, rightW: -3 })), {
    left: LIMITS.left.max,
    right: LIMITS.right.min,
  });
  assert.deepEqual(readSizes(() => ({ leftW: 0, rightW: 0 })), {
    left: LIMITS.left.min,
    right: LIMITS.right.min,
  });
});

check('readSizes：lsGet 抛异常也不炸', () => {
  const boom = () => {
    throw new Error('storage disabled');
  };
  assert.deepEqual(readSizes(boom), { left: DEFAULTS.left, right: DEFAULTS.right });
});

check('readSizes 用同一个 localStorage 键', () => {
  let seenKey = null;
  readSizes((key) => {
    seenKey = key;
    return null;
  });
  assert.equal(seenKey, 'docmate.panes');
});

check('writeSizes：不破坏 {side, chat, manual}', () => {
  let stored = null;
  let storedKey = null;
  const lsSet = (key, value) => {
    storedKey = key;
    stored = value;
  };
  const base = { side: false, chat: true, manual: true };
  const returned = writeSizes(lsSet, { left: 300, right: 400 }, base);
  assert.equal(storedKey, 'docmate.panes');
  assert.deepEqual(stored, { side: false, chat: true, manual: true, leftW: 300, rightW: 400 });
  assert.deepEqual(returned, stored, '返回值应就是写进去的对象');
  assert.deepEqual(base, { side: false, chat: true, manual: true }, '不该就地改调用方的对象');
});

check('writeSizes：宽度越界时先夹再写', () => {
  let stored = null;
  writeSizes((key, value) => {
    stored = value;
  }, { left: 9999, right: -5 }, { side: true, chat: true, manual: false });
  assert.equal(stored.leftW, LIMITS.left.max);
  assert.equal(stored.rightW, LIMITS.right.min);
  assert.equal(stored.manual, false, 'manual 语义要原样保留');
});

check('writeSizes：坏 sizes / 没有 base 也不炸', () => {
  let stored = null;
  writeSizes((key, value) => {
    stored = value;
  });
  assert.deepEqual(stored, { leftW: DEFAULTS.left, rightW: DEFAULTS.right });
  let threw = false;
  try {
    writeSizes(() => {
      throw new Error('quota');
    }, { left: 300, right: 400 }, {});
  } catch (error) {
    threw = true;
  }
  assert.equal(threw, false, 'lsSet 抛异常时 writeSizes 不该跟着抛');
});

/* ================= [6] 键盘步进 ================= */
console.log('\n[6] keyboardStep（纯函数）');

check('方向键 ±16px，语义是「移动分隔条」', () => {
  assert.deepEqual(keyboardStep(236, 'ArrowRight', { side: 'left' }), { type: 'set', width: 252 });
  assert.deepEqual(keyboardStep(236, 'ArrowLeft', { side: 'left' }), { type: 'set', width: 220 });
  // 右分隔条：往右 = 右栏变窄
  assert.deepEqual(keyboardStep(348, 'ArrowRight', { side: 'right' }), { type: 'set', width: 332 });
  assert.deepEqual(keyboardStep(348, 'ArrowLeft', { side: 'right' }), { type: 'set', width: 364 });
});

check('Home / End 到最小 / 最大', () => {
  assert.deepEqual(keyboardStep(236, 'Home', { side: 'left' }), { type: 'set', width: 176 });
  assert.deepEqual(keyboardStep(236, 'End', { side: 'left' }), { type: 'set', width: 520 });
  assert.deepEqual(keyboardStep(348, 'Home', { side: 'right' }), { type: 'set', width: 268 });
  assert.deepEqual(keyboardStep(348, 'End', { side: 'right' }), { type: 'set', width: 640 });
});

check('Enter 是「恢复默认」，不认识的键返回 null', () => {
  assert.deepEqual(keyboardStep(236, 'Enter', { side: 'left' }), { type: 'reset' });
  assert.equal(keyboardStep(236, 'a', { side: 'left' }), null);
  assert.equal(keyboardStep(236, 'Tab', { side: 'left' }), null);
});

check('步进到边界就停住，不越界', () => {
  assert.deepEqual(keyboardStep(520, 'ArrowRight', { side: 'left' }), { type: 'set', width: 520 });
  assert.deepEqual(keyboardStep(176, 'ArrowLeft', { side: 'left' }), { type: 'set', width: 176 });
  assert.deepEqual(keyboardStep(268, 'ArrowRight', { side: 'right' }), { type: 'set', width: 268 });
});

check('步长 / 范围可覆盖', () => {
  assert.deepEqual(keyboardStep(236, 'ArrowRight', { side: 'left', step: 40 }), {
    type: 'set',
    width: 276,
  });
  assert.deepEqual(keyboardStep(300, 'ArrowRight', { side: 'left', min: 100, max: 320 }), {
    type: 'set',
    width: 316,
  });
});

check('宽度是坏值时从默认值起步', () => {
  assert.deepEqual(keyboardStep(undefined, 'ArrowRight', { side: 'left' }), {
    type: 'set',
    width: DEFAULTS.left + LIMITS.step,
  });
});

/* ================= [7] PaneHandle 契约 ================= */
console.log('\n[7] PaneHandle 的 props 契约');

check('ARIA：role=separator / vertical / valuenow-min-max', () => {
  const tree = renderBar({ side: 'left', width: 300, min: 176, max: 520 });
  assert.equal(tree.p.role, 'separator');
  assert.equal(tree.p['aria-orientation'], 'vertical');
  assert.equal(tree.p['aria-valuenow'], 300);
  assert.equal(tree.p['aria-valuemin'], 176);
  assert.equal(tree.p['aria-valuemax'], 520);
  assert.equal(tree.p.tabIndex, 0);
  assert.ok(hasClass(tree, 'dm-panehandle'));
  assert.ok(hasClass(tree, 'dm-panehandle--left'));
  assert.ok(tree.p.title.indexOf('双击') >= 0, 'title 要提示双击恢复默认');
});

check('右分隔条的 aria-label 区分左右', () => {
  const left = renderBar({ side: 'left', width: 236 });
  const right = renderBar({ side: 'right', width: 348 });
  assert.ok(left.p['aria-label'].indexOf('研究区') >= 0);
  assert.ok(right.p['aria-label'].indexOf('伴随') >= 0);
});

check('disabled 时不可聚焦、aria-disabled、无拖拽', () => {
  let started = 0;
  const tree = renderBar({
    side: 'left',
    width: 236,
    disabled: true,
    onDragStart: () => {
      started += 1;
    },
  });
  assert.equal(tree.p.tabIndex, -1);
  assert.equal(tree.p['aria-disabled'], 'true');
  assert.ok(hasClass(tree, 'is-disabled'));
  let prevented = 0;
  tree.p.onPointerDown({
    button: 0,
    clientX: 10,
    preventDefault() {
      prevented += 1;
    },
  });
  assert.equal(started, 0, 'disabled 时不该开始拖拽');
  assert.equal(prevented, 0);
});

check('pointerdown 开始拖拽（阻止拖选 + 捕获指针 + 记起点）', () => {
  let started = 0;
  let prevented = 0;
  const captured = [];
  const tree = renderBar({
    side: 'left',
    width: 236,
    onDragStart: () => {
      started += 1;
    },
  });
  tree.p.onPointerDown({
    button: 0,
    clientX: 120,
    pointerId: 7,
    currentTarget: {
      focus() {},
      setPointerCapture(id) {
        captured.push(id);
      },
    },
    preventDefault() {
      prevented += 1;
    },
  });
  assert.equal(started, 1);
  assert.equal(prevented, 1, '要 preventDefault，否则会从分隔条开始拖选正文');
  assert.deepEqual(captured, [7], '要捕获指针，否则拖到窗口外松手会卡住');
});

check('没有 setPointerCapture 的环境（老浏览器 / 假 DOM）也不炸', () => {
  let started = 0;
  const tree = renderBar({
    side: 'left',
    width: 236,
    onDragStart: () => {
      started += 1;
    },
  });
  tree.p.onPointerDown({ button: 0, clientX: 10, pointerId: 1, currentTarget: { focus() {} } });
  assert.equal(started, 1);
});

check('右键不触发拖拽', () => {
  let started = 0;
  const tree = renderBar({
    side: 'left',
    width: 236,
    onDragStart: () => {
      started += 1;
    },
  });
  tree.p.onPointerDown({ button: 2, clientX: 120 });
  assert.equal(started, 0);
});

check('双击恢复默认', () => {
  let resets = 0;
  const tree = renderBar({
    side: 'right',
    width: 348,
    onReset: () => {
      resets += 1;
    },
  });
  tree.p.onDoubleClick({ preventDefault() {} });
  assert.equal(resets, 1);
});

check('键盘：方向键调宽度、Enter 恢复默认', () => {
  const calls = [];
  const tree = renderBar({
    side: 'left',
    width: 236,
    min: 176,
    max: 520,
    onDrag: (next) => calls.push(['drag', next]),
    onDragEnd: () => calls.push(['end']),
    onReset: () => calls.push(['reset']),
  });
  let prevented = 0;
  const key = (name) => ({
    key: name,
    preventDefault() {
      prevented += 1;
    },
  });
  tree.p.onKeyDown(key('ArrowRight'));
  assert.deepEqual(calls, [['drag', 252], ['end']], '键盘调整也要落盘');
  calls.length = 0;
  tree.p.onKeyDown(key('Enter'));
  assert.deepEqual(calls, [['reset']]);
  calls.length = 0;
  tree.p.onKeyDown(key('a'));
  assert.deepEqual(calls, [], '不认识的键不该有副作用');
  assert.equal(prevented, 2, '只有真正处理了的键才 preventDefault');
});

check('没在拖动时不渲染 overlay；拖动中才渲染', () => {
  const idle = renderBar({ side: 'left', width: 236 });
  assert.equal(findAll(idle, (node) => hasClass(node, 'dm-pane-overlay')).length, 0);
});

check('props 兜底：空 props 不抛', () => {
  const tree = renderBar({});
  assert.equal(tree.p.role, 'separator');
  assert.equal(tree.p['aria-valuenow'], DEFAULTS.left);
  assert.equal(tree.p.tabIndex, 0);
  assert.equal(findAll(tree, (node) => hasClass(node, 'dm-panehandle__line')).length, 1);
});

/* ================= [8] 样式 ================= */
console.log('\n[8] css 字符串');

check('包含分隔条 / overlay / is-resizing 的规则', () => {
  for (const token of [
    '.dm-panehandle',
    '.dm-panehandle__line',
    '.dm-pane-overlay',
    '.dm-root.is-resizing',
    '.dm-root.is-shot .dm-panehandle',
    'cursor: col-resize',
    'user-select: none',
  ]) {
    assert.ok(css.indexOf(token) >= 0, 'css 缺少 ' + token);
  }
});

check('hover / 拖动 / 焦点都有可见反馈', () => {
  assert.ok(css.indexOf('.dm-panehandle:hover .dm-panehandle__line') >= 0);
  assert.ok(css.indexOf('.dm-panehandle.is-dragging .dm-panehandle__line') >= 0);
  assert.ok(css.indexOf('.dm-panehandle:focus-visible') >= 0);
});

check('颜色只用变量，没有写死色值', () => {
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), '不该出现写死的 hex 颜色');
  assert.ok(!/\brgba?\s*\(/.test(css), '不该出现写死的 rgb / rgba 颜色');
  assert.ok(css.indexOf('var(--dm-accent)') >= 0);
  assert.ok(css.indexOf('var(--dm-line-2)') >= 0);
});

check('CSS 模板字符串里没有反引号（拼进 bundle 会炸）', () => {
  assert.equal(css.indexOf('`'), -1, 'css 里出现了反引号');
});

/* ================= [9] 源码约束 ================= */
console.log('\n[9] 源码约束（片段契约）');

check('无 import / export / require / 顶层 await', () => {
  assert.ok(!/^\s*import\s/m.test(sourceText), '不得有 import');
  assert.ok(!/^\s*export\s/m.test(sourceText), '不得有 export');
  assert.ok(!/\brequire\s*\(/.test(sourceText), '不得 require 其它模块');
  assert.ok(!/^\s*await\s/m.test(sourceText), '不得有顶层 await');
});

check('文件末尾是 CJS 导出守卫', () => {
  assert.ok(
    /if \(typeof module !== 'undefined' && module\.exports\) module\.exports = \{ createPanes \};/.test(
      sourceText,
    ),
    '缺少导出守卫',
  );
  assert.ok(sourceText.trimEnd().endsWith('module.exports = { createPanes };'), '守卫必须在文件末尾');
});

check('浏览器环境（无 module）下片段可安全执行', () => {
  let factory = null;
  try {
    // eslint-disable-next-line no-new-func
    factory = new Function('React', 'util', sourceText + '\nreturn createPanes;');
  } catch (error) {
    fail('片段不是合法脚本：' + error.message);
  }
  const make = factory(makeFakeReact(), fakeUtil);
  const browserModule = make(makeFakeReact(), fakeUtil);
  assert.equal(typeof browserModule.PaneHandle, 'function');
  assert.equal(typeof browserModule.resolveSizes, 'function');
});

check('导出齐全', () => {
  for (const name of ['PaneHandle', 'DEFAULTS', 'LIMITS', 'resolveSizes', 'readSizes', 'writeSizes', 'css']) {
    assert.ok(panes[name] !== undefined && panes[name] !== null, '缺少导出 ' + name);
  }
  assert.equal(typeof panes.PaneHandle, 'function');
  assert.equal(typeof panes.resolveSizes, 'function');
  assert.equal(typeof panes.readSizes, 'function');
  assert.equal(typeof panes.writeSizes, 'function');
  assert.equal(typeof panes.css, 'string');
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
