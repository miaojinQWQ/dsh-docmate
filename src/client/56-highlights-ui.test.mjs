/* 56-highlights-ui.test.mjs —— 纯 node 自测（不联网、不装包、不用 jsdom）
 *
 * 被测片段是浏览器里的普通脚本，靠 CJS 守卫导出 createHighlightsUi；这里用 new Function
 * 把它塞进一个带 module/exports 的作用域执行，和 build.mjs 拼进 factory 闭包的方式一致。
 *
 * 覆盖三块：
 *   1. 复习模式的纯函数（planReview / reviewSummary / stepReview）—— 直接喂数据断言；
 *   2. CSS 卫生（模板字符串里不能有反引号、颜色只走 --dm-* 变量）；
 *   3. 组件流程：用一个极小的「带 hooks 的假 React」渲染 HighlightList，模拟点击 / 键盘，
 *      断言开始复习 → 卡片 → 记得/忘了/问 AI → 总结页 → 退出 的完整路径。
 *
 * 运行：node src/client/56-highlights-ui.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceText = fs.readFileSync(path.join(here, '56-highlights-ui.js'), 'utf8');

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
    fail((message ? message + '：' : '') + '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
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

assert.match = function match(value, pattern, message) {
  if (!pattern.test(String(value))) {
    fail((message ? message + '：' : '') + '期望匹配 ' + pattern + '，实际 ' + JSON.stringify(value));
  }
};

async function ok(name, fn) {
  try {
    await fn();
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
const { createHighlightsUi } = cjsModule.exports;
assert.equal(typeof createHighlightsUi, 'function', 'module.exports.createHighlightsUi 必须是函数');

/** Pure-function instance: hooks are never called, so a stub React is enough. */
const ReactStub = {
  createElement: function createElement(type, props) {
    return { type: type, props: props || {}, children: [] };
  },
  useState: function useState(initial) {
    return [initial, function noop() {}];
  },
  useEffect: function useEffect() {},
  useRef: function useRef(initial) {
    return { current: initial };
  },
};

const utilStub = {
  cx: function cx() {
    return Array.prototype.filter.call(arguments, Boolean).join(' ');
  },
  Icon: function Icon() {
    return null;
  },
  oneLine: function oneLine(text, max) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (!max || flat.length <= max) return flat;
    return flat.slice(0, max - 1) + '\u2026';
  },
};

const ui = createHighlightsUi(ReactStub, utilStub);

/* ---------- 小工具 ---------- */

function makeItem(id, color, createdAt, extra) {
  return Object.assign(
    {
      id: id,
      color: color,
      text: 'text-' + id,
      note: '',
      anchor: { scope: 'doc', page: null, start: 0, end: 5 },
      kind: 'mark',
      createdAt: createdAt,
    },
    extra || {},
  );
}

/** Five items: two review, one question, one key, one quote. */
function reviewItems() {
  return [
    makeItem('k1', 'key', 300),
    makeItem('r2', 'review', 200),
    makeItem('q1', 'question', 100),
    makeItem('r1', 'review', 50),
    makeItem('quote1', 'key', 10, { kind: 'quote', text: '引用' }),
  ];
}

/* ---------- 导出契约 ---------- */

console.log('导出契约');
await ok('导出 HighlightList / HighlightsCss / 三个纯函数', function () {
  assert.equal(typeof ui.HighlightList, 'function');
  assert.equal(typeof ui.HighlightsCss, 'string');
  assert.equal(typeof ui.planReview, 'function');
  assert.equal(typeof ui.reviewSummary, 'function');
  assert.equal(typeof ui.stepReview, 'function');
});

/* ---------- planReview ---------- */

console.log('planReview');
await ok('排序：待复习 → 疑问 → 重点，同类按 createdAt 升序', function () {
  const queue = ui.planReview(reviewItems());
  assert.deepEqual(
    queue.map(function (item) {
      return item.id;
    }),
    ['r1', 'r2', 'q1', 'k1'],
  );
});

await ok('过滤 quote、空文本、无文本的条目', function () {
  const items = [
    makeItem('a', 'key', 1),
    makeItem('quote', 'key', 2, { kind: 'quote' }),
    makeItem('blank', 'key', 3, { text: '   ' }),
    makeItem('missing', 'key', 4, { text: undefined }),
    makeItem('no-kind', 'key', 5, { kind: undefined }),
    null,
  ];
  const queue = ui.planReview(items);
  assert.deepEqual(
    queue.map(function (item) {
      return item.id;
    }),
    ['a'],
  );
});

await ok('空数组 / null / 非数组都返回空队列', function () {
  assert.deepEqual(ui.planReview([]), []);
  assert.deepEqual(ui.planReview(null), []);
  assert.deepEqual(ui.planReview(undefined), []);
  assert.deepEqual(ui.planReview('nope'), []);
});

await ok('不修改输入数组', function () {
  const items = reviewItems();
  const before = items.map(function (item) {
    return item.id;
  });
  ui.planReview(items);
  assert.deepEqual(
    items.map(function (item) {
      return item.id;
    }),
    before,
  );
});

await ok('确定性：同一输入两次结果一致，打乱输入也一致', function () {
  const first = ui.planReview(reviewItems()).map(function (item) {
    return item.id;
  });
  const second = ui.planReview(reviewItems()).map(function (item) {
    return item.id;
  });
  assert.deepEqual(first, second);
  const shuffled = reviewItems().reverse();
  assert.deepEqual(
    ui.planReview(shuffled).map(function (item) {
      return item.id;
    }),
    first,
  );
});

await ok('createdAt 相同按 id 稳定排序', function () {
  const items = [makeItem('b', 'key', 7), makeItem('a', 'key', 7), makeItem('c', 'key', 7)];
  assert.deepEqual(
    ui.planReview(items).map(function (item) {
      return item.id;
    }),
    ['a', 'b', 'c'],
  );
});

await ok('未知颜色排在最后，不抛', function () {
  const items = [makeItem('x', 'weird', 1), makeItem('r', 'review', 2), makeItem('k', 'key', 3)];
  assert.deepEqual(
    ui.planReview(items).map(function (item) {
      return item.id;
    }),
    ['r', 'k', 'x'],
  );
});

/* ---------- reviewSummary ---------- */

console.log('reviewSummary');
await ok('全记得 → { total, forgot: 0 }', function () {
  assert.deepEqual(ui.reviewSummary(['known', 'known', 'known']), { total: 3, forgot: 0 });
});

await ok('全忘了 → forgot 等于 total', function () {
  assert.deepEqual(ui.reviewSummary(['forgot', 'forgot']), { total: 2, forgot: 2 });
});

await ok('混合 / 空 / 非法输入', function () {
  assert.deepEqual(ui.reviewSummary(['known', 'forgot', 'known']), { total: 3, forgot: 1 });
  assert.deepEqual(ui.reviewSummary([]), { total: 0, forgot: 0 });
  assert.deepEqual(ui.reviewSummary(null), { total: 0, forgot: 0 });
  assert.deepEqual(ui.reviewSummary(undefined), { total: 0, forgot: 0 });
});

await ok('稀疏数组只数有效 verdict（跳过的卡片不算）', function () {
  const results = [];
  results[2] = 'forgot';
  assert.deepEqual(ui.reviewSummary(results), { total: 1, forgot: 1 });
  assert.deepEqual(ui.reviewSummary(['bogus', 'known']), { total: 1, forgot: 0 });
});

/* ---------- stepReview ---------- */

console.log('stepReview');
await ok('中间前后移动', function () {
  assert.equal(ui.stepReview(2, 5, 1), 3);
  assert.equal(ui.stepReview(2, 5, -1), 1);
});

await ok('边界：0 往前、末尾往后都不越界、不循环', function () {
  assert.equal(ui.stepReview(0, 5, -1), 0);
  assert.equal(ui.stepReview(4, 5, 1), 4);
  assert.equal(ui.stepReview(0, 5, -10), 0);
  assert.equal(ui.stepReview(4, 5, 10), 4);
});

await ok('total = 1 时怎么走都停在 0', function () {
  assert.equal(ui.stepReview(0, 1, 1), 0);
  assert.equal(ui.stepReview(0, 1, -1), 0);
});

await ok('total = 0 返回 0', function () {
  assert.equal(ui.stepReview(0, 0, 1), 0);
  assert.equal(ui.stepReview(3, 0, -1), 0);
});

await ok('delta = 0 / 非数字 / 越界下标都夹回合法范围', function () {
  assert.equal(ui.stepReview(2, 5, 0), 2);
  assert.equal(ui.stepReview(99, 5, 0), 4);
  assert.equal(ui.stepReview(-3, 5, 0), 0);
  assert.equal(ui.stepReview(NaN, 5, 1), 1);
  assert.equal(ui.stepReview(2, 5, NaN), 2);
});

/* ---------- CSS ---------- */

console.log('css');
const CSS_TEXT = String(ui.HighlightsCss);

await ok('包含复习模式的规则', function () {
  assert.ok(CSS_TEXT.length > 2000, 'css 太短');
  assert.match(CSS_TEXT, /\.dm-hlui__review-start\s*\{/);
  assert.match(CSS_TEXT, /\.dm-hlui__bar\s*\{/);
  assert.match(CSS_TEXT, /\.dm-hlui-review__card\s*\{/);
  assert.match(CSS_TEXT, /\.dm-hlui-review__text\s*\{/);
  assert.match(CSS_TEXT, /\.dm-hlui-review__btn--solid\s*\{/);
  assert.match(CSS_TEXT, /white-space:\s*pre-wrap/);
});

await ok('CSS 里没有反引号（会炸掉模板字符串）', function () {
  assert.equal(CSS_TEXT.indexOf(String.fromCharCode(96)), -1);
});

await ok('颜色字面量只允许出现在 --dm-* 变量定义里', function () {
  const lines = CSS_TEXT.split('\n');
  const offenders = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*--dm-[a-z0-9-]+\s*:/.test(line)) continue; // token definition: the one allowed home
    if (/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(line)) offenders.push(line.trim());
  }
  assert.deepEqual(offenders, [], '写死的颜色：' + offenders.join(' | '));
});

await ok('color / background 声明一律走 var(--dm-*)（不写死 #fff）', function () {
  const colorProps = { color: 1, background: 1, 'background-color': 1, 'border-color': 1, 'outline-color': 1 };
  const declaration = /(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;{}]+)/g;
  const offenders = [];
  let match = declaration.exec(CSS_TEXT);
  while (match) {
    const prop = match[1];
    const value = match[2].trim();
    if (colorProps[prop] && !/var\(--dm-|transparent|currentColor|inherit|none/.test(value)) {
      offenders.push(prop + ': ' + value);
    }
    match = declaration.exec(CSS_TEXT);
  }
  assert.deepEqual(offenders, [], '颜色没走变量：' + offenders.join(' | '));
});

await ok('实心按钮用 var(--dm-on-accent) 而不是 #fff', function () {
  assert.match(CSS_TEXT, /\.dm-hlui-review__btn--solid\s*\{[^}]*var\(--dm-on-accent\)/);
});

/* ---------- 假 React（带 hooks，能重渲染） ---------- */

const keyListeners = [];
globalThis.document = {
  addEventListener: function addEventListener(type, fn) {
    if (type === 'keydown') keyListeners.push(fn);
  },
  removeEventListener: function removeEventListener(type, fn) {
    if (type !== 'keydown') return;
    const index = keyListeners.indexOf(fn);
    if (index >= 0) keyListeners.splice(index, 1);
  },
};

function createHarness() {
  const slots = [];
  let cursor = 0;
  let dirty = false;
  let effects = [];

  const React = {
    createElement: function createElement(type, props) {
      const merged = Object.assign({}, props || {});
      const children = Array.prototype.slice.call(arguments, 2);
      if (children.length > 0 && merged.children === undefined) {
        merged.children = children.length === 1 ? children[0] : children;
      }
      return { type: type, props: merged, children: children };
    },
    useState: function useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in slots)) {
        slots[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
      }
      const slot = slots[index];
      return [
        slot.value,
        function setState(next) {
          const value = typeof next === 'function' ? next(slot.value) : next;
          if (!Object.is(value, slot.value)) {
            slot.value = value;
            dirty = true;
          }
        },
      ];
    },
    useEffect: function useEffect(fn, deps) {
      const index = cursor;
      cursor += 1;
      if (!(index in slots)) slots[index] = { kind: 'effect', deps: undefined, cleanup: undefined };
      effects.push({ slot: slots[index], fn: fn, deps: deps });
    },
    useRef: function useRef(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in slots)) slots[index] = { kind: 'ref', value: { current: initial } };
      return slots[index].value;
    },
    useMemo: function useMemo(fn) {
      return fn();
    },
    useCallback: function useCallback(fn) {
      return fn;
    },
  };

  function render(Component, props) {
    cursor = 0;
    effects = [];
    dirty = false;
    const tree = Component(props);
    for (let index = 0; index < effects.length; index += 1) {
      const entry = effects[index];
      const previous = entry.slot.deps;
      const deps = entry.deps;
      const changed =
        !previous ||
        !deps ||
        previous.length !== deps.length ||
        deps.some(function differs(value, position) {
          return !Object.is(value, previous[position]);
        });
      if (!changed) continue;
      if (typeof entry.slot.cleanup === 'function') entry.slot.cleanup();
      entry.slot.cleanup = entry.fn();
      entry.slot.deps = deps;
    }
    return tree;
  }

  return { React: React, render: render, isDirty: function isDirty() { return dirty; } };
}

function mount(harness, Component, props) {
  let tree = harness.render(Component, props);
  return {
    get tree() {
      return tree;
    },
    flush: function flush() {
      let guard = 0;
      while (harness.isDirty() && guard < 20) {
        tree = harness.render(Component, props);
        guard += 1;
      }
      return tree;
    },
    setProps: function setProps(next) {
      props = next;
      tree = harness.render(Component, props);
      return tree;
    },
  };
}

/* ---------- 树遍历 / 交互小工具 ---------- */

function each(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    node.forEach(function (item) {
      each(item, visit);
    });
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ text: String(node) });
    return;
  }
  visit(node);
  (node.children || []).forEach(function (child) {
    each(child, visit);
  });
}

function textOf(node) {
  const parts = [];
  each(node, function (entry) {
    if (entry.text !== undefined) parts.push(entry.text);
  });
  return parts.join('');
}

function elements(node) {
  const out = [];
  each(node, function (entry) {
    if (entry.type) out.push(entry);
  });
  return out;
}

function findAll(node, predicate) {
  return elements(node).filter(predicate);
}

function findOne(node, predicate) {
  const found = findAll(node, predicate);
  return found.length ? found[0] : null;
}

function className(node) {
  return String((node && node.props && node.props.className) || '');
}

function hasClass(node, name) {
  return className(node)
    .split(/\s+/)
    .filter(Boolean)
    .includes(name);
}

function byClass(name) {
  return function (node) {
    return hasClass(node, name);
  };
}

function fire(node, handlerName, event) {
  const handler = node && node.props && node.props[handlerName];
  assert.equal(typeof handler, 'function', 'missing ' + handlerName + ' on .' + className(node).split(' ')[0]);
  return handler(event || { preventDefault: function () {}, stopPropagation: function () {} });
}

function pressKey(key, target) {
  const event = {
    key: key,
    target: target || { tagName: 'DIV' },
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: function () {
      event.defaultPrevented = true;
    },
  };
  const listeners = keyListeners.slice();
  for (let index = 0; index < listeners.length; index += 1) listeners[index](event);
  return event;
}

function mountList(overrides) {
  keyListeners.length = 0;
  const harness = createHarness();
  const util = {
    cx: utilStub.cx,
    Icon: function Icon(props) {
      return harness.React.createElement('svg', { 'data-icon': props && props.name });
    },
    oneLine: utilStub.oneLine,
  };
  const localUi = createHighlightsUi(harness.React, util);
  const calls = { jump: [], remove: [], note: [], review: [], ask: [], askAll: 0 };
  const props = Object.assign(
    {
      items: reviewItems(),
      activeId: null,
      loading: false,
      error: null,
      onJump: function onJump(item) {
        calls.jump.push(item);
      },
      onDelete: function onDelete(id) {
        calls.remove.push(id);
      },
      onNote: function onNote(item, text) {
        calls.note.push({ item: item, text: text });
      },
      onReview: function onReview(item, verdict) {
        calls.review.push({ item: item, verdict: verdict });
      },
      onAskAbout: function onAskAbout(item) {
        calls.ask.push(item);
      },
      onAskAll: function onAskAll() {
        calls.askAll += 1;
      },
    },
    overrides || {},
  );
  const mounted = mount(harness, localUi.HighlightList, props);
  return { mounted: mounted, calls: calls, props: props, ui: localUi };
}

function startReview(mounted) {
  const button = findOne(mounted.tree, byClass('dm-hlui__review-start'));
  assert.ok(button, '找不到「开始复习」按钮');
  fire(button, 'onClick');
  mounted.flush();
}

function cardText(mounted) {
  const node = findOne(mounted.tree, byClass('dm-hlui-review__text'));
  return node ? textOf(node) : null;
}

function progressText(mounted) {
  const node = findOne(mounted.tree, byClass('dm-hlui__progress'));
  return node ? textOf(node) : null;
}

function reviewButton(mounted, label) {
  return findOne(mounted.tree, function (node) {
    return hasClass(node, 'dm-hlui-review__btn') && textOf(node).trim() === label;
  });
}

/* ---------- 组件流程：列表 ↔ 复习 ---------- */

console.log('复习模式入口');
await ok('有手划线时出现「开始复习」，只有引用时不出现', function () {
  const withMarks = mountList();
  assert.ok(findOne(withMarks.mounted.tree, byClass('dm-hlui__review-start')), '有 mark 时应显示按钮');
  const onlyQuote = mountList({ items: [makeItem('q', 'key', 1, { kind: 'quote' })] });
  assert.equal(findOne(onlyQuote.mounted.tree, byClass('dm-hlui__review-start')), null);
});

await ok('点「开始复习」→ 卡片视图，列表隐藏，进度 1 / N', function () {
  const { mounted } = mountList();
  startReview(mounted);
  assert.equal(cardText(mounted), 'text-r1', '第一张应是待复习里最早的一条');
  assert.equal(progressText(mounted), '1 / 4');
  assert.equal(findAll(mounted.tree, byClass('dm-hlui-row')).length, 0, '列表行应隐藏');
  assert.ok(findOne(mounted.tree, byClass('dm-hlui-review__card')), '缺少卡片');
  const meta = findOne(mounted.tree, byClass('dm-hlui-review__meta'));
  assert.equal(textOf(meta), '待复习');
  const bar = findOne(mounted.tree, byClass('dm-hlui__bar'));
  assert.equal(bar.props['aria-valuenow'], 1);
  assert.equal(bar.props['aria-valuemax'], 4);
  const fill = findOne(mounted.tree, byClass('dm-hlui__bar-fill'));
  assert.equal(fill.props.style.width, '25%');
});

await ok('「记得」→ 下一条；「忘了」→ 回调 onReview(item, "forgot") 并前进', function () {
  const { mounted, calls } = mountList();
  startReview(mounted);
  fire(reviewButton(mounted, '记得'), 'onClick');
  mounted.flush();
  assert.equal(cardText(mounted), 'text-r2');
  assert.equal(progressText(mounted), '2 / 4');
  assert.equal(calls.review.length, 0, '记得不应回调 onReview');

  fire(reviewButton(mounted, '忘了'), 'onClick');
  mounted.flush();
  assert.equal(calls.review.length, 1);
  assert.equal(calls.review[0].item.id, 'r2');
  assert.equal(calls.review[0].verdict, 'forgot');
  assert.equal(cardText(mounted), 'text-q1');
});

await ok('「问 AI」→ onAskAbout(item) 并退出复习回到列表', function () {
  const { mounted, calls } = mountList();
  startReview(mounted);
  fire(reviewButton(mounted, '问 AI'), 'onClick');
  mounted.flush();
  assert.equal(calls.ask.length, 1);
  assert.equal(calls.ask[0].id, 'r1');
  assert.equal(cardText(mounted), null, '应已退出复习');
  assert.ok(findAll(mounted.tree, byClass('dm-hlui-row')).length > 0, '应回到列表');
  assert.ok(findOne(mounted.tree, byClass('dm-hlui__review-start')), '列表模式应重新出现开始复习');
});

await ok('过完最后一条 → 总结页，文案与计数正确', function () {
  const { mounted, calls } = mountList();
  startReview(mounted);
  // r1 忘了，其余三条记得
  fire(reviewButton(mounted, '忘了'), 'onClick');
  mounted.flush();
  fire(reviewButton(mounted, '记得'), 'onClick');
  mounted.flush();
  fire(reviewButton(mounted, '记得'), 'onClick');
  mounted.flush();
  fire(reviewButton(mounted, '记得'), 'onClick');
  mounted.flush();
  assert.equal(calls.review.length, 1);
  const title = findOne(mounted.tree, byClass('dm-hlui-review__summary-title'));
  assert.ok(title, '缺少总结页');
  assert.equal(textOf(title), '过完了 4 条，其中 1 条标成待复习');
  assert.equal(progressText(mounted), '4 / 4');
  assert.equal(findOne(mounted.tree, byClass('dm-hlui-review__text')), null);
});

await ok('总结页「再来一遍」重新排队；「关闭」回到列表', function () {
  const { mounted } = mountList();
  startReview(mounted);
  for (let index = 0; index < 4; index += 1) {
    fire(reviewButton(mounted, '记得'), 'onClick');
    mounted.flush();
  }
  const again = findOne(mounted.tree, function (node) {
    return hasClass(node, 'dm-hlui-review__btn') && textOf(node).trim() === '再来一遍';
  });
  assert.ok(again, '缺少「再来一遍」');
  fire(again, 'onClick');
  mounted.flush();
  assert.equal(cardText(mounted), 'text-r1');
  assert.equal(progressText(mounted), '1 / 4');

  // 再走一遍到总结页，然后关闭
  for (let index = 0; index < 4; index += 1) {
    fire(reviewButton(mounted, '记得'), 'onClick');
    mounted.flush();
  }
  const close = findOne(mounted.tree, function (node) {
    return hasClass(node, 'dm-hlui-review__btn') && textOf(node).trim() === '关闭';
  });
  assert.ok(close, '缺少「关闭」');
  fire(close, 'onClick');
  mounted.flush();
  assert.equal(cardText(mounted), null);
  assert.ok(findAll(mounted.tree, byClass('dm-hlui-row')).length > 0);
});

await ok('✕ 随时退出复习', function () {
  const { mounted } = mountList();
  startReview(mounted);
  const close = findOne(mounted.tree, function (node) {
    return hasClass(node, 'dm-hlui__act') && node.props.title === '退出复习（Esc）';
  });
  assert.ok(close, '缺少 ✕ 按钮');
  fire(close, 'onClick');
  mounted.flush();
  assert.equal(cardText(mounted), null);
  assert.ok(findAll(mounted.tree, byClass('dm-hlui-row')).length > 0);
});

/* ---------- 备注 ---------- */

console.log('复习卡片备注');
await ok('有备注才显示「看我的备注」，点击展开 / 收起', function () {
  const items = [makeItem('n1', 'review', 1, { note: '这是备注内容' })];
  const { mounted } = mountList({ items: items });
  startReview(mounted);
  const toggle = findOne(mounted.tree, byClass('dm-hlui-review__note-btn'));
  assert.ok(toggle, '有 note 时应显示备注按钮');
  assert.equal(textOf(toggle), '▸ 看我的备注');
  assert.equal(findOne(mounted.tree, byClass('dm-hlui-review__note')), null);

  fire(toggle, 'onClick');
  mounted.flush();
  const note = findOne(mounted.tree, byClass('dm-hlui-review__note'));
  assert.ok(note, '点击后应展开备注');
  assert.equal(textOf(note), '这是备注内容');
  assert.equal(textOf(findOne(mounted.tree, byClass('dm-hlui-review__note-btn'))), '▾ 收起备注');

  fire(findOne(mounted.tree, byClass('dm-hlui-review__note-btn')), 'onClick');
  mounted.flush();
  assert.equal(findOne(mounted.tree, byClass('dm-hlui-review__note')), null);
});

await ok('没有备注时不显示备注按钮', function () {
  const { mounted } = mountList({ items: [makeItem('n1', 'key', 1)] });
  startReview(mounted);
  assert.equal(findOne(mounted.tree, byClass('dm-hlui-review__note-btn')), null);
});

await ok('翻页会收起已展开的备注', function () {
  const items = [makeItem('n1', 'review', 1, { note: '备注一' }), makeItem('n2', 'review', 2, { note: '备注二' })];
  const { mounted } = mountList({ items: items });
  startReview(mounted);
  fire(findOne(mounted.tree, byClass('dm-hlui-review__note-btn')), 'onClick');
  mounted.flush();
  assert.ok(findOne(mounted.tree, byClass('dm-hlui-review__note')));
  fire(reviewButton(mounted, '记得'), 'onClick');
  mounted.flush();
  assert.equal(findOne(mounted.tree, byClass('dm-hlui-review__note')), null, '翻页后备注应收起');
});

/* ---------- 键盘 ---------- */

console.log('复习键盘');
await ok('← / J 上一条，→ / K 下一条', function () {
  const { mounted } = mountList();
  startReview(mounted);
  pressKey('ArrowRight');
  mounted.flush();
  assert.equal(cardText(mounted), 'text-r2');
  pressKey('ArrowLeft');
  mounted.flush();
  assert.equal(cardText(mounted), 'text-r1');
  pressKey('j');
  mounted.flush();
  assert.equal(cardText(mounted), 'text-r2', 'J = 下一条（vim 习惯）');
  pressKey('k');
  mounted.flush();
  assert.equal(cardText(mounted), 'text-r1', 'K = 上一条（vim 习惯）');
});

await ok('1 记得、2 忘了', function () {
  const { mounted, calls } = mountList();
  startReview(mounted);
  pressKey('1');
  mounted.flush();
  assert.equal(cardText(mounted), 'text-r2');
  pressKey('2');
  mounted.flush();
  assert.equal(calls.review.length, 1);
  assert.equal(calls.review[0].item.id, 'r2');
  assert.equal(cardText(mounted), 'text-q1');
});

await ok('Esc 退出复习', function () {
  const { mounted } = mountList();
  startReview(mounted);
  pressKey('Escape');
  mounted.flush();
  assert.equal(cardText(mounted), null);
  assert.ok(findAll(mounted.tree, byClass('dm-hlui-row')).length > 0);
});

await ok('输入框上的按键不抢（target 是 INPUT / TEXTAREA）', function () {
  const { mounted } = mountList();
  startReview(mounted);
  pressKey('ArrowRight', { tagName: 'INPUT' });
  mounted.flush();
  assert.equal(cardText(mounted), 'text-r1');
  pressKey('1', { tagName: 'TEXTAREA' });
  mounted.flush();
  assert.equal(cardText(mounted), 'text-r1');
});

await ok('带 Ctrl / Meta 的组合键不处理', function () {
  const { mounted } = mountList();
  startReview(mounted);
  const listeners = keyListeners.slice();
  for (let index = 0; index < listeners.length; index += 1) {
    listeners[index]({
      key: 'ArrowRight',
      target: { tagName: 'DIV' },
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      preventDefault: function () {},
    });
  }
  mounted.flush();
  assert.equal(cardText(mounted), 'text-r1', 'Ctrl + → 不应翻页');
});

await ok('退出复习后键盘监听被移除', function () {
  const { mounted } = mountList();
  startReview(mounted);
  assert.ok(keyListeners.length > 0, '复习中应挂上监听');
  pressKey('Escape');
  mounted.flush();
  assert.equal(keyListeners.length, 0, '退出后应移除监听');
});

/* ---------- 文档切换 ---------- */

console.log('文档切换');
await ok('items 换成另一篇文档（旧 id 全消失）时自动退出复习', function () {
  const { mounted, props } = mountList();
  startReview(mounted);
  assert.ok(cardText(mounted));
  mounted.setProps(Object.assign({}, props, { items: [makeItem('new1', 'key', 1)] }));
  mounted.flush();
  assert.equal(cardText(mounted), null, '换文档后不应继续显示旧卡片');
  assert.ok(findAll(mounted.tree, byClass('dm-hlui-row')).length > 0);
});

await ok('「忘了」改颜色（items 变化但 id 还在）不会打断复习', function () {
  const { mounted, props, calls } = mountList();
  startReview(mounted);
  fire(reviewButton(mounted, '忘了'), 'onClick');
  mounted.flush();
  assert.equal(calls.review.length, 1);
  // 模拟 shell 收到 POST 后回写 items：r1 变成 review 色
  const updated = reviewItems().map(function (item) {
    return item.id === 'r1' ? Object.assign({}, item, { color: 'review' }) : item;
  });
  mounted.setProps(Object.assign({}, props, { items: updated }));
  mounted.flush();
  assert.equal(cardText(mounted), 'text-r2', '复习应继续，不能被 items 回写打断');
});

/* ---------- 片段形态 ---------- */

console.log('片段形态');
await ok('没有 import / export / 顶层 await', function () {
  assert.equal(/^\s*(?:import|export)\s/m.test(sourceText), false, '片段里不能有 import/export');
  assert.equal(/^\s*await\s/m.test(sourceText), false, '片段里不能有顶层 await');
});

await ok('没有 dangerouslySetInnerHTML', function () {
  assert.equal(sourceText.indexOf('dangerouslySetInnerHTML'), -1);
});

/* ---------- 汇总 ---------- */

console.log('');
if (failures.length > 0) {
  console.error('失败：' + failures.length + ' 组');
  for (const entry of failures) {
    console.error('  \u2717 ' + entry.name + '：' + String((entry.error && entry.error.message) || entry.error));
  }
  process.exitCode = 1;
} else {
  console.log('全部通过：' + passed + ' 组断言');
}
