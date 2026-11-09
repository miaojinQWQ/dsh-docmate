/* 48-shot.test.mjs —— 纯 node 自测（不联网、不装包、不用 jsdom）
 *
 * 被测片段是浏览器里的普通脚本，靠 CJS 守卫导出 createShot；这里用 new Function 把它塞进
 * 一个带 module/exports 的作用域执行，和 build.mjs 拼进 factory 闭包的方式一致。
 *
 * 截图引擎的骨架（相交计算 / 缩放 / 排版计划）都是纯函数，可以直接喂数字验证；captureRegion
 * 需要的那点 DOM 用最小的假元素 + 假 canvas 顶替 —— 只实现引擎真正会调的那几个方法，
 * 所以断言能精确到「第几块从源图哪个像素开始裁、画到输出画布哪个位置」。
 *
 * 运行：node src/client/48-shot.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceText = fs.readFileSync(path.join(here, '48-shot.js'), 'utf8');

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
const { createShot } = cjsModule.exports;
assert.equal(typeof createShot, 'function', 'module.exports.createShot 必须是函数');

const shot = createShot({
  clamp: function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  },
});

/* ---------- 小工具 ---------- */

/** 造一个 getBoundingClientRect 形状的矩形。 */
function makeRect(left, top, width, height) {
  return { left: left, top: top, right: left + width, bottom: top + height, width: width, height: height };
}

/**
 * 假 canvas：源页 canvas 只需要 width/height/getBoundingClientRect；输出 canvas 还需要
 * getContext + toDataURL。calls 记录绘制调用，断言直接看它。
 */
function makeCanvasStub(config) {
  const cfg = config || {};
  const calls = { drawImage: [], fillRect: [], clearRect: [], setTransform: [], fillStyle: '' };
  let fillStyle = '';
  const ctx = {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value) {
      fillStyle = value;
      calls.fillStyle = value;
    },
    setTransform: function () {
      calls.setTransform.push(Array.prototype.slice.call(arguments));
    },
    scale: function () {
      calls.scale = Array.prototype.slice.call(arguments);
    },
    clearRect: function () {
      calls.clearRect.push(Array.prototype.slice.call(arguments));
    },
    fillRect: function () {
      calls.fillRect.push(Array.prototype.slice.call(arguments));
    },
    drawImage: function () {
      calls.drawImage.push(Array.prototype.slice.call(arguments));
    },
  };
  return {
    width: cfg.width || 0,
    height: cfg.height || 0,
    calls: calls,
    getContext: function () {
      return ctx;
    },
    getBoundingClientRect: function () {
      return cfg.rect || null;
    },
    toDataURL: function (type) {
      if (cfg.tainted) throw new Error('SecurityError: canvas has been tainted');
      const size = cfg.payloadSize || 128;
      return 'data:' + (type || 'image/png') + ';base64,' + 'A'.repeat(size);
    },
  };
}

/** 装上最小 document + getComputedStyle；返回 restore() 和每次 createElement 的产物。 */
function installFakeDom(createOutput) {
  const previousDocument = globalThis.document;
  const previousStyle = globalThis.getComputedStyle;
  const outputs = [];
  globalThis.document = {
    createElement: function () {
      const output = createOutput();
      outputs.push(output);
      return output;
    },
  };
  globalThis.getComputedStyle = function () {
    return {
      getPropertyValue: function (prop) {
        return prop === 'background-color' ? 'rgb(255, 255, 255)' : '';
      },
    };
  };
  return {
    outputs: outputs,
    restore: function () {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousStyle === undefined) delete globalThis.getComputedStyle;
      else globalThis.getComputedStyle = previousStyle;
    },
  };
}

/** 一个只认 canvas / img 的假阅读区。 */
function makeViewer(canvases, images) {
  return {
    querySelectorAll: function (selector) {
      if (selector === 'canvas') return canvases || [];
      if (selector === 'img') return images || [];
      return [];
    },
    parentElement: null,
  };
}

/* ---------- HTML 兜底用的假 DOM（元素 / 计算样式 / Image） ---------- */

function append(parent, child) {
  parent.children.push(child);
  child.parentElement = parent;
  return child;
}

/**
 * 假元素：只实现引擎真正会碰的成员 —— children / style.setProperty / cloneNode /
 * outerHTML / getBoundingClientRect / querySelector（只回答「有没有匹配的后代」）。
 */
function makeFakeElement(tag, options) {
  const opts = options || {};
  const element = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    className: opts.className || '',
    children: [],
    parentElement: null,
    _matches: !!opts.matches,
    _rect: opts.rect || null,
    _computed: opts.computed || {},
    style: {
      _values: {},
      setProperty: function (name, value) {
        this._values[name] = value;
      },
      getPropertyValue: function (name) {
        return this._values[name] || '';
      },
    },
    getBoundingClientRect: function () {
      return element._rect;
    },
    querySelector: function () {
      for (let i = 0; i < element.children.length; i += 1) {
        const child = element.children[i];
        if (child._matches) return child;
        const found = child.querySelector('leaf');
        if (found) return found;
      }
      return null;
    },
    cloneNode: function () {
      const copy = makeFakeElement(tag, {
        className: element.className,
        matches: element._matches,
        rect: element._rect,
        computed: element._computed,
      });
      copy.children = element.children.map(function (child) {
        const cloned = child.cloneNode(true);
        cloned.parentElement = copy;
        return cloned;
      });
      return copy;
    },
  };
  Object.defineProperty(element, 'outerHTML', {
    get: function () {
      const styleText = Object.keys(element.style._values)
        .map(function (name) {
          return name + ':' + element.style._values[name];
        })
        .join(';');
      const attrs = styleText ? ' style="' + styleText + '"' : '';
      const inner = element.children
        .map(function (child) {
          return child.outerHTML;
        })
        .join('');
      return '<' + tag + attrs + '>' + inner + '</' + tag + '>';
    },
  });
  return element;
}

function makeFakeViewer(leaves) {
  const viewer = makeFakeElement('div', {
    computed: { 'background-color': 'rgb(250, 250, 250)' },
  });
  viewer.querySelectorAll = function (selector) {
    if (selector === 'canvas' || selector === 'img') return [];
    return leaves || [];
  };
  return viewer;
}

/** 装上 document / getComputedStyle / Image，Image 的 onload 走微任务。 */
function installFakeHtmlDom(options) {
  const opts = options || {};
  const previousDocument = globalThis.document;
  const previousStyle = globalThis.getComputedStyle;
  const previousImage = globalThis.Image;
  const previousSerializer = globalThis.XMLSerializer;
  const outputs = [];
  const images = [];
  globalThis.document = {
    createElement: function () {
      const output = makeCanvasStub({});
      outputs.push(output);
      return output;
    },
  };
  globalThis.getComputedStyle = function (element) {
    const computed = (element && element._computed) || {};
    return {
      getPropertyValue: function (prop) {
        return computed[prop] || '';
      },
    };
  };
  class FakeImage {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this._src = '';
      images.push(this);
    }

    set src(value) {
      this._src = value;
      const self = this;
      queueMicrotask(function () {
        if (opts.failImages) {
          if (self.onerror) self.onerror();
        } else if (self.onload) {
          self.onload();
        }
      });
    }

    get src() {
      return this._src;
    }
  }
  globalThis.Image = FakeImage;
  if (typeof opts.xmlSerializer === 'function') globalThis.XMLSerializer = opts.xmlSerializer;
  return {
    outputs: outputs,
    images: images,
    restore: function () {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousStyle === undefined) delete globalThis.getComputedStyle;
      else globalThis.getComputedStyle = previousStyle;
      if (previousImage === undefined) delete globalThis.Image;
      else globalThis.Image = previousImage;
      if (previousSerializer === undefined) delete globalThis.XMLSerializer;
      else globalThis.XMLSerializer = previousSerializer;
    },
  };
}

function paragraphStyles() {
  return {
    color: 'rgb(27, 31, 39)',
    'background-color': 'rgba(0, 0, 0, 0)',
    'font-family': 'system-ui, sans-serif',
    'font-size': '15px',
    'font-weight': '400',
    'line-height': '27.3px',
    display: 'block',
    width: '200px',
    height: '50px',
  };
}

/* ---------- 导出契约 ---------- */

console.log('导出契约');
await ok('五个成员齐全且类型正确', function () {
  assert.equal(typeof shot.captureRegion, 'function', 'captureRegion');
  assert.equal(typeof shot.intersectRect, 'function', 'intersectRect');
  assert.equal(typeof shot.planCompose, 'function', 'planCompose');
  assert.equal(typeof shot.fitScale, 'function', 'fitScale');
  assert.equal(typeof shot.css, 'string', 'css');
});

await ok('不传 util 也能用（clamp 有兜底）', function () {
  const bare = createShot();
  assert.equal(bare.fitScale(3200, 100, 1600), 0.5);
});

/* ---------- intersectRect ---------- */

console.log('intersectRect');
await ok('部分重叠取交集', function () {
  const hit = shot.intersectRect(makeRect(0, 0, 100, 100), makeRect(50, 50, 100, 100));
  assert.deepEqual(hit, { left: 50, top: 50, right: 100, bottom: 100, width: 50, height: 50 });
});

await ok('不相交返回 null', function () {
  assert.equal(shot.intersectRect(makeRect(0, 0, 100, 100), makeRect(200, 200, 50, 50)), null);
});

await ok('一个包住另一个时返回小的那个', function () {
  const outer = makeRect(0, 0, 400, 300);
  const inner = makeRect(20, 30, 100, 80);
  const hit = shot.intersectRect(outer, inner);
  assert.deepEqual(hit, { left: 20, top: 30, right: 120, bottom: 110, width: 100, height: 80 });
});

await ok('只贴边（面积为 0）不算相交', function () {
  assert.equal(shot.intersectRect(makeRect(0, 0, 100, 100), makeRect(100, 0, 50, 50)), null);
  assert.equal(shot.intersectRect(makeRect(0, 0, 100, 100), makeRect(0, 100, 50, 50)), null);
});

await ok('坏输入返回 null 而不是抛', function () {
  assert.equal(shot.intersectRect(null, makeRect(0, 0, 10, 10)), null);
  assert.equal(shot.intersectRect(makeRect(0, 0, 10, 10), undefined), null);
  assert.equal(shot.intersectRect({}, {}), null);
  assert.equal(shot.intersectRect({ left: 0, top: 0, width: 10, height: 10 }, makeRect(5, 5, 10, 10)).width, 5);
});

/* ---------- fitScale ---------- */

console.log('fitScale');
await ok('没超上限时不放大', function () {
  assert.equal(shot.fitScale(800, 600, 1600), 1);
  assert.equal(shot.fitScale(1600, 1600, 1600), 1);
});

await ok('超上限时按最长边等比缩', function () {
  assert.equal(shot.fitScale(3200, 1600, 1600), 0.5);
  assert.equal(shot.fitScale(1000, 4000, 1600), 0.4);
  assert.equal(shot.fitScale(5000, 100, 1600), 0.32);
});

await ok('退化输入不炸', function () {
  assert.equal(shot.fitScale(0, 0, 1600), 1);
  assert.equal(shot.fitScale(-10, 20, 1600), 1);
  assert.equal(shot.fitScale(NaN, 100, 1600), 1);
  assert.equal(shot.fitScale(3200, 100, 0), 0.5, 'maxDimension 非法时回落 1600');
  assert.equal(shot.fitScale(3200, 100, undefined), 0.5);
});

/* ---------- planCompose ---------- */

console.log('planCompose');
await ok('单块：源矩形按 scale 放大，目标矩形按 CSS 像素', function () {
  const plan = shot.planCompose([{ rect: makeRect(100, 200, 300, 100), scale: 2, order: 0 }], {
    maxDimension: 1600,
  });
  assert.equal(plan.width, 300);
  assert.equal(plan.height, 100);
  assert.deepEqual(plan.ops, [
    { index: 0, sx: 0, sy: 0, sw: 600, sh: 200, dx: 0, dy: 0, dw: 300, dh: 100 },
  ]);
});

await ok('多块跨页：保留页间空隙的相对纵向位置', function () {
  const plan = shot.planCompose(
    [
      { rect: makeRect(100, 100, 300, 200), scale: 1, order: 0 },
      { rect: makeRect(100, 340, 300, 200), scale: 1, order: 1 },
    ],
    { maxDimension: 1600 },
  );
  // 第一页 100..300，第二页 340..540：中间 40px 空隙不能丢。
  assert.equal(plan.width, 300);
  assert.equal(plan.height, 440);
  assert.equal(plan.ops[0].dy, 0);
  assert.equal(plan.ops[1].dy, 240, '第二块应落在 340-100=240');
  assert.equal(plan.ops[1].dh, 200);
});

await ok('水平错位：以最左为原点，各自保留横向偏移', function () {
  const plan = shot.planCompose(
    [
      { rect: makeRect(100, 100, 300, 100), scale: 1, order: 0 },
      { rect: makeRect(120, 220, 280, 100), scale: 1, order: 1 },
    ],
    { maxDimension: 1600 },
  );
  assert.equal(plan.width, 300);
  assert.equal(plan.height, 220);
  assert.equal(plan.ops[1].dx, 20);
  assert.equal(plan.ops[1].dy, 120);
  assert.equal(plan.ops[1].dw, 280);
});

await ok('offset：只裁块的一部分时源矩形从偏移处开始', function () {
  const plan = shot.planCompose(
    [{ rect: makeRect(100, 100, 100, 50), scale: 2, order: 0, offset: { x: 10, y: 20 } }],
    { maxDimension: 1600 },
  );
  assert.equal(plan.ops[0].sx, 20);
  assert.equal(plan.ops[0].sy, 40);
  assert.equal(plan.ops[0].sw, 200);
  assert.equal(plan.ops[0].sh, 100);
});

await ok('maxDimension 在计划阶段就收敛', function () {
  const plan = shot.planCompose([{ rect: makeRect(0, 0, 3200, 800), scale: 1, order: 0 }], {
    maxDimension: 1600,
  });
  assert.equal(plan.width, 1600);
  assert.equal(plan.height, 400);
  assert.equal(plan.ops[0].dw, 1600);
  assert.equal(plan.ops[0].dh, 400);
  assert.equal(plan.ops[0].sw, 3200, '源矩形不受输出缩放影响');
});

await ok('空输入返回空计划', function () {
  assert.deepEqual(shot.planCompose([], {}), { width: 0, height: 0, ops: [] });
  assert.deepEqual(shot.planCompose(null, {}), { width: 0, height: 0, ops: [] });
});

await ok('无效块被丢掉，index 仍指回原数组', function () {
  const plan = shot.planCompose(
    [{ rect: null, scale: 1 }, { rect: makeRect(0, 0, 10, 10), scale: 1 }],
    { maxDimension: 1600 },
  );
  assert.equal(plan.ops.length, 1);
  assert.equal(plan.ops[0].index, 1);
});

/* ---------- captureRegion：早退分支 ---------- */

console.log('captureRegion（早退）');
await ok('viewer 为 null 时返回 empty，且返回的是 Promise', async function () {
  const promise = shot.captureRegion(null, makeRect(0, 0, 100, 100));
  assert.ok(promise && typeof promise.then === 'function', '应返回 Promise');
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
  assert.equal(typeof result.message, 'string');
});

await ok('框太小返回 too-small', async function () {
  const result = await shot.captureRegion(makeViewer([], []), makeRect(0, 0, 4, 4));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too-small');
});

await ok('rect 无效返回 empty', async function () {
  const result = await shot.captureRegion(makeViewer([], []), null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
});

await ok('什么都没框到返回 empty', async function () {
  const result = await shot.captureRegion(makeViewer([], []), makeRect(10, 10, 200, 200));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
});

await ok('allowHtml 关掉时没有位图就返回 empty', async function () {
  const result = await shot.captureRegion(makeViewer([], []), makeRect(10, 10, 200, 200), {
    allowHtml: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
});

await ok('querySelectorAll 抛错也不 reject', async function () {
  const viewer = {
    querySelectorAll: function () {
      throw new Error('boom');
    },
    parentElement: null,
  };
  const result = await shot.captureRegion(viewer, makeRect(0, 0, 100, 100));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
});

/* ---------- captureRegion：PDF canvas 路径 ---------- */

console.log('captureRegion（PDF canvas）');
await ok('按位图倍率裁剪，跨页按相对纵向位置拼接', async function () {
  const page1 = makeCanvasStub({ width: 600, height: 800, rect: makeRect(100, 100, 300, 400) });
  const page2 = makeCanvasStub({ width: 600, height: 800, rect: makeRect(100, 520, 300, 400) });
  const dom = installFakeDom(function () {
    return makeCanvasStub({});
  });
  try {
    const viewer = makeViewer([page1, page2], []);
    // 选区从第一页中间拉到第二页中间：150..350 横向，150..750 纵向。
    const result = await shot.captureRegion(viewer, makeRect(150, 150, 200, 600), {});
    assert.equal(result.ok, true, '应成功：' + JSON.stringify(result));
    assert.equal(result.kind, 'pdf');
    assert.equal(result.mediaType, 'image/png');
    assert.equal(result.width, 200);
    assert.equal(result.height, 600);
    assert.match(result.dataUrl, /^data:image\/png;base64,/);

    assert.equal(dom.outputs.length, 1, '只该造一张输出画布');
    const output = dom.outputs[0];
    assert.equal(output.width, 200);
    assert.equal(output.height, 600);
    assert.deepEqual(output.calls.fillRect[0], [0, 0, 200, 600], '先铺满背景色');
    assert.equal(output.calls.fillStyle, 'rgb(255, 255, 255)', '背景色取自 viewer 的计算样式');

    assert.equal(output.calls.drawImage.length, 2, '两页各画一次');
    const first = output.calls.drawImage[0];
    assert.equal(first[0], page1, '第一块应画第一页 canvas');
    // 源：canvas 600/300 = 2 倍；选区在页内偏移 (50,50) → 源 (100,100)；
    // 目标：纵向相对位置 0。
    assert.deepEqual(first.slice(1), [100, 100, 400, 700, 0, 0, 200, 350]);
    const second = output.calls.drawImage[1];
    assert.equal(second[0], page2, '第二块应画第二页 canvas');
    // 第二页选区在页内偏移 (50,0)：选区上边在第一页里，所以第二页从页顶开始裁；
    // 纵向相对位置 520-150=370。
    assert.deepEqual(second.slice(1), [100, 0, 400, 460, 0, 370, 200, 230]);
  } finally {
    dom.restore();
  }
});

await ok('跨域图片污染画布时返回 tainted，不抛', async function () {
  const page = makeCanvasStub({ width: 600, height: 800, rect: makeRect(100, 100, 300, 400) });
  const dom = installFakeDom(function () {
    return makeCanvasStub({ tainted: true });
  });
  try {
    const result = await shot.captureRegion(makeViewer([page], []), makeRect(100, 100, 300, 400), {});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'tainted');
    assert.equal(typeof result.message, 'string');
  } finally {
    dom.restore();
  }
});

await ok('合成后仍小于 8px 时返回 too-small', async function () {
  // 选区本身 10px 宽（过了早退检查），但和 canvas 只相交 5px。
  const page = makeCanvasStub({ width: 600, height: 800, rect: makeRect(105, 100, 300, 400) });
  const dom = installFakeDom(function () {
    return makeCanvasStub({});
  });
  try {
    const result = await shot.captureRegion(makeViewer([page], []), makeRect(100, 100, 10, 300), {});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'too-small');
  } finally {
    dom.restore();
  }
});

/* ---------- captureRegion：img 路径 ---------- */

console.log('captureRegion（img）');
await ok('按 naturalWidth / 显示宽度 的比例从原图裁', async function () {
  const image = {
    nodeType: 1,
    naturalWidth: 900,
    naturalHeight: 600,
    getBoundingClientRect: function () {
      return makeRect(100, 100, 300, 200);
    },
  };
  const dom = installFakeDom(function () {
    return makeCanvasStub({});
  });
  try {
    const result = await shot.captureRegion(makeViewer([], [image]), makeRect(100, 100, 300, 200), {});
    assert.equal(result.ok, true, '应成功：' + JSON.stringify(result));
    assert.equal(result.kind, 'img');
    assert.equal(result.width, 300);
    assert.equal(result.height, 200);
    const output = dom.outputs[0];
    assert.equal(output.calls.drawImage.length, 1);
    assert.deepEqual(output.calls.drawImage[0].slice(1), [0, 0, 900, 600, 0, 0, 300, 200]);
  } finally {
    dom.restore();
  }
});

/* ---------- captureRegion：HTML 兜底 ---------- */

console.log('captureRegion（HTML 兜底）');
await ok('叶子块 clone 成内联样式，经 foreignObject 栅格化后合成', async function () {
  const paragraph = makeFakeElement('p', {
    matches: true,
    rect: makeRect(100, 100, 200, 50),
    computed: paragraphStyles(),
  });
  append(
    paragraph,
    makeFakeElement('strong', {
      rect: makeRect(100, 100, 40, 20),
      computed: { 'font-weight': '650', color: 'rgb(27, 31, 39)' },
    }),
  );
  const viewer = makeFakeViewer([paragraph]);
  const dom = installFakeHtmlDom();
  try {
    const result = await shot.captureRegion(viewer, makeRect(100, 100, 200, 50), {});
    assert.equal(result.ok, true, '应成功：' + JSON.stringify(result));
    assert.equal(result.kind, 'html');
    assert.equal(result.width, 200);
    assert.equal(result.height, 50);

    assert.equal(dom.images.length, 1, '每个块只该栅格化一次');
    const svg = decodeURIComponent(
      dom.images[0].src.replace('data:image/svg+xml;charset=utf-8,', ''),
    );
    assert.match(svg, /<svg[^>]*width="200"/);
    assert.match(svg, /<foreignObject width="200" height="50">/);
    assert.match(svg, /xmlns="http:\/\/www.w3.org\/1999\/xhtml"/);
    assert.match(svg, /font-size:15px/, '计算样式应被写成内联');
    assert.match(svg, /<p[^>]*>/, '根块应被序列化进 SVG');
    assert.match(svg, /<strong[^>]*>/, '子元素也要带样式');

    // 第一张是块自己的位图，第二张才是最终输出画布。
    assert.equal(dom.outputs.length, 2);
    assert.equal(dom.outputs[0].width, 200);
    assert.equal(dom.outputs[0].height, 50);
    const output = dom.outputs[1];
    assert.equal(output.calls.drawImage.length, 1);
    assert.equal(output.calls.drawImage[0][0], dom.outputs[0], '应从块位图裁');
    assert.deepEqual(output.calls.drawImage[0].slice(1), [0, 0, 200, 50, 0, 0, 200, 50]);
  } finally {
    dom.restore();
  }
});

await ok('父子都匹配时只渲染最内层，避免重复画', async function () {
  const inner = makeFakeElement('p', {
    matches: true,
    rect: makeRect(100, 100, 200, 50),
    computed: paragraphStyles(),
  });
  const callout = makeFakeElement('div', {
    matches: true,
    className: 'dm-md-callout',
    rect: makeRect(100, 100, 200, 50),
    computed: paragraphStyles(),
  });
  append(callout, inner);
  const dom = installFakeHtmlDom();
  try {
    const result = await shot.captureRegion(makeFakeViewer([callout, inner]), makeRect(100, 100, 200, 50), {});
    assert.equal(result.ok, true, '应成功：' + JSON.stringify(result));
    assert.equal(dom.images.length, 1, '父块应被跳过');
    const svg = decodeURIComponent(
      dom.images[0].src.replace('data:image/svg+xml;charset=utf-8,', ''),
    );
    assert.match(svg, /<p[^>]*>/);
    // 只有一个 div：buildSvg 的 XHTML 包装层；父块（callout）本身没被序列化。
    assert.equal((svg.match(/<div/g) || []).length, 1, '父块不该出现在 SVG 里');
  } finally {
    dom.restore();
  }
});

await ok('只框到块的下半截时按 offset 从块位图裁', async function () {
  const paragraph = makeFakeElement('p', {
    matches: true,
    rect: makeRect(100, 100, 200, 100),
    computed: paragraphStyles(),
  });
  const dom = installFakeHtmlDom();
  try {
    const result = await shot.captureRegion(makeFakeViewer([paragraph]), makeRect(100, 150, 200, 50), {});
    assert.equal(result.ok, true, '应成功：' + JSON.stringify(result));
    assert.equal(result.width, 200);
    assert.equal(result.height, 50);
    assert.equal(dom.outputs[0].height, 100, '块本身整块栅格化');
    const output = dom.outputs[1];
    assert.deepEqual(output.calls.drawImage[0].slice(1), [0, 50, 200, 50, 0, 0, 200, 50]);
  } finally {
    dom.restore();
  }
});

await ok('优先用 XMLSerializer 序列化（outerHTML 的 <br> 在 XML 里非法）', async function () {
  const paragraph = makeFakeElement('p', {
    matches: true,
    rect: makeRect(100, 100, 200, 50),
    computed: paragraphStyles(),
  });
  let serialized = 0;
  function FakeXmlSerializer() {
    this.serializeToString = function () {
      serialized += 1;
      return '<p xmlns="http://www.w3.org/1999/xhtml">xml</p>';
    };
  }
  const dom = installFakeHtmlDom({ xmlSerializer: FakeXmlSerializer });
  try {
    const result = await shot.captureRegion(makeFakeViewer([paragraph]), makeRect(100, 100, 200, 50), {});
    assert.equal(result.ok, true, '应成功：' + JSON.stringify(result));
    assert.equal(serialized, 1, '应走 XMLSerializer');
    const svg = decodeURIComponent(
      dom.images[0].src.replace('data:image/svg+xml;charset=utf-8,', ''),
    );
    assert.match(svg, /<p xmlns="http:\/\/www.w3.org\/1999\/xhtml">xml<\/p>/);
  } finally {
    dom.restore();
  }
});

await ok('块栅格化失败时返回 failed，不抛', async function () {
  const paragraph = makeFakeElement('p', {
    matches: true,
    rect: makeRect(100, 100, 200, 50),
    computed: paragraphStyles(),
  });
  const dom = installFakeHtmlDom({ failImages: true });
  try {
    const result = await shot.captureRegion(makeFakeViewer([paragraph]), makeRect(100, 100, 200, 50), {});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'failed');
    assert.equal(typeof result.message, 'string');
  } finally {
    dom.restore();
  }
});

/* ---------- css ---------- */

console.log('css');
await ok('包含框选遮罩与尺寸标签两条规则', function () {
  assert.ok(shot.css.length > 100, 'css 太短');
  assert.match(shot.css, /\.dm-shot-marquee\s*\{/);
  assert.match(shot.css, /\.dm-shot-marquee__size\s*\{/);
  assert.match(shot.css, /position:\s*absolute/);
  assert.match(shot.css, /pointer-events:\s*none/);
  assert.match(shot.css, /var\(--dm-accent\)/);
  assert.match(shot.css, /var\(--dm-on-accent\)/);
});

await ok('CSS 里没有反引号（会炸掉模板字符串）', function () {
  assert.equal(shot.css.indexOf(String.fromCharCode(96)), -1);
});

/* ---------- 片段形态 ---------- */

console.log('片段形态');
await ok('没有 import / export / 顶层 await', function () {
  assert.equal(/^\s*(?:import|export)\s/m.test(sourceText), false, '片段里不能有 import/export');
  assert.equal(/^\s*await\s/m.test(sourceText), false, '片段里不能有顶层 await');
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
