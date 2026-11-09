/* ===== 48-shot.js ===== */
/**
 * 框选截图引擎：在阅读区里框一个矩形，把它变成一张 PNG（体积超了再退成 JPEG）。
 *
 * 为什么不是「给整页拍一张再裁」：
 *   阅读区是滚动容器，框选范围经常比视口还高（跨页 PDF、长文），浏览器又没有「把 DOM
 *   直接画成图」的通用 API，只能按内容来源分三档取图：
 *     1. PDF：pdf.js 已经把每一页画进 canvas，直接裁位图最清晰、最便宜；
 *     2. img：按 naturalWidth / 显示宽度 的比例从原图裁，等于拿到原图分辨率；
 *     3. 普通 HTML：没有位图可裁，只能把叶子块 clone 出来、把计算样式写成内联，
 *        塞进 SVG foreignObject 让浏览器自己栅格化（这是不引 html2canvas 那类库的唯一做法）。
 *
 * 为什么按「相交面积」挑来源而不是按文档类型：
 *   调用方只给 viewer 和视口矩形，不给「这是 PDF 还是 md」。canvas 优先是因为它一定是
 *   渲染结果本身；img 次之；HTML 兜底最贵也最不保真，所以放最后。
 *
 * 为什么拼接要保留「相对纵向位置」：
 *   框选跨两页时，两页之间有一段背景色空隙。如果简单首尾相接，空隙会消失，截出来的图
 *   看起来像两页粘在一起；保留 rect.top 的相对差，空隙就自然变成背景色。
 *
 * 为什么所有失败都返回对象而不是 reject：
 *   调用方是 UI 层（框选松手就调），一次 reject 会变成未处理的 Promise 拒绝，把整个面板
 *   的 console 刷红；而「框太小 / 框空了 / 图片跨域」都是正常操作结果，不是异常。
 *
 * 对外只暴露 `createShot(util) -> { captureRegion, intersectRect, planCompose, fitScale,
 * css }`。除 captureRegion 需要 DOM 外都是纯函数，单测不需要 jsdom。
 */
function createShot(util) {
  const clamp =
    util && typeof util.clamp === 'function'
      ? util.clamp
      : function fallbackClamp(value, min, max) {
          if (!isFinite(value)) return min;
          return Math.min(max, Math.max(min, value));
        };

  /* ── 常量 ────────────────────────────────────────────────────────────── */

  /** 输出画布最长边。1600 是「贴进聊天/笔记还看得清」和「别把 base64 撑爆」的折中。 */
  const DEFAULT_MAX_DIMENSION = 1600;

  /** 3.5MB：宿主消息体对图片有上限，再大下游就收不下了。 */
  const DEFAULT_MAX_BYTES = 3500000;

  /** 小于 8px 的图没有信息量，还会在下游被当成破图。 */
  const MIN_SIDE = 8;

  const JPEG_QUALITY = 0.92;
  const SHRINK_FACTOR = 0.8;
  const MAX_SHRINK_ROUNDS = 8;

  /**
   * 叶子块选择器：这些是「能独立成一个视觉单元」的块级元素。
   * 只取最内层匹配（见 renderHtmlBlocks），父子都取会把同一段文字画两遍。
   */
  const LEAF_SELECTOR = [
    'p',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'pre',
    'blockquote',
    'td',
    'th',
    'figcaption',
    '.dm-md-callout',
    '.katex-display',
    '.dm-md-math-block',
  ].join(',');

  /**
   * foreignObject 里没有页面的样式表，所有样式都得写成内联。
   * 只搬「排版相关」的属性：全量搬 getComputedStyle 会得到几百个属性、字符串巨大，而且
   * position / top / transform 之类脱离原包含块后反而会错位。border* 与 text-decoration*
   * 拆成 longhand 是因为 Chromium 对简写的 computed 序列化不稳定。
   */
  const INLINE_PROPS = [
    'color',
    'background-color',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'line-height',
    'letter-spacing',
    'text-align',
    'text-decoration',
    'text-decoration-line',
    'text-decoration-style',
    'text-decoration-color',
    'text-indent',
    'white-space',
    'word-break',
    'overflow-wrap',
    'vertical-align',
    'padding',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'margin',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'border',
    'border-top',
    'border-right',
    'border-bottom',
    'border-left',
    'border-width',
    'border-style',
    'border-color',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'border-radius',
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
    'border-collapse',
    'border-spacing',
    'list-style',
    'list-style-type',
    'list-style-position',
    'display',
    'width',
    'height',
    'max-width',
  ];

  /* ── 矩形工具（纯函数，单测直接喂） ──────────────────────────────────── */

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  /**
   * 把 getBoundingClientRect() 形状（或手写的 {left,top,width,height}）归一成
   * 一定是 left/top/right/bottom/width/height 六件套的矩形；坏输入返回 null。
   */
  function normRect(rect) {
    if (!rect || typeof rect !== 'object') return null;
    const left = isFiniteNumber(rect.left) ? rect.left : null;
    const top = isFiniteNumber(rect.top) ? rect.top : null;
    let right = isFiniteNumber(rect.right) ? rect.right : null;
    let bottom = isFiniteNumber(rect.bottom) ? rect.bottom : null;
    if (right === null && left !== null && isFiniteNumber(rect.width)) right = left + rect.width;
    if (bottom === null && top !== null && isFiniteNumber(rect.height)) bottom = top + rect.height;
    if (left === null || top === null || right === null || bottom === null) return null;
    return {
      left: left,
      top: top,
      right: right,
      bottom: bottom,
      width: right - left,
      height: bottom - top,
    };
  }

  /**
   * 两个矩形的交集；不相交（包括只贴边、面积为 0）返回 null。
   * 贴边不算相交是有意的：面积 0 的区域画出来是一张空图，不如当没框到。
   */
  function intersectRect(a, b) {
    const first = normRect(a);
    const second = normRect(b);
    if (!first || !second) return null;
    const left = Math.max(first.left, second.left);
    const top = Math.max(first.top, second.top);
    const right = Math.min(first.right, second.right);
    const bottom = Math.min(first.bottom, second.bottom);
    if (right - left <= 0 || bottom - top <= 0) return null;
    return {
      left: left,
      top: top,
      right: right,
      bottom: bottom,
      width: right - left,
      height: bottom - top,
    };
  }

  /**
   * 最长边收敛到 maxDimension 的缩放比，永远不大于 1（只缩不放）。
   * 退化输入（0 / 负数 / NaN）返回 1：没有尺寸就没有可缩的东西。
   */
  function fitScale(width, height, maxDimension) {
    const w = isFiniteNumber(width) ? width : 0;
    const h = isFiniteNumber(height) ? height : 0;
    const limit =
      isFiniteNumber(maxDimension) && maxDimension > 0 ? maxDimension : DEFAULT_MAX_DIMENSION;
    const longest = Math.max(w, h);
    if (!(longest > 0)) return 1;
    if (longest <= limit) return 1;
    return limit / longest;
  }

  /** 只用来消掉 0.1 + 0.2 那种浮点噪声，单测里比较 ops 才不会莫名其妙差 1e-16。 */
  function round3(value) {
    return Math.round(value * 1000) / 1000;
  }

  /* ── 排版计划（纯函数，单测直接验） ──────────────────────────────────── */

  /**
   * 把若干块（每块是「视口里的一个矩形」+「源位图相对 CSS 像素的倍率」）排成一张竖图。
   *
   * 坐标约定：
   *   · rect   —— 这块在视口里的位置（裁剪后的相交区域，不是整个元素）；
   *   · scale  —— 源位图像素 / CSS 像素（PDF canvas 是 canvas.width / 显示宽度，
   *               img 是 naturalWidth / 显示宽度，HTML 块是栅格化倍率）；
   *   · offset —— 可选，这块的源图起点在元素内的 CSS 像素偏移（裁部分块时用）；
   *   · order  —— 可选，文档顺序，仅用于稳定（本函数不重排，纵向位置由 rect.top 决定）。
   *
   * 输出坐标系：先按 CSS 像素排（宽 = 所有块横向并集，高 = 纵向并集），再用
   * options.maxDimension 通过 fitScale 收敛。所以返回的 width / height 就是最终画布尺寸，
   * ops 里的 dx / dy / dw / dh 也已经是最终像素。
   *
   * 每块 ops 带一个 index 指回 pieces 下标：无效块会被丢掉，调用方不能靠数组顺序对齐。
   */
  function planCompose(pieces, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const list = Array.isArray(pieces) ? pieces : [];
    const entries = [];
    for (let i = 0; i < list.length; i += 1) {
      const piece = list[i];
      if (!piece) continue;
      const rect = normRect(piece.rect);
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      const scale = isFiniteNumber(piece.scale) && piece.scale > 0 ? piece.scale : 1;
      const offset = piece.offset && typeof piece.offset === 'object' ? piece.offset : null;
      entries.push({
        index: i,
        rect: rect,
        scale: scale,
        offsetX: offset && isFiniteNumber(offset.x) ? offset.x : 0,
        offsetY: offset && isFiniteNumber(offset.y) ? offset.y : 0,
      });
    }
    if (entries.length === 0) return { width: 0, height: 0, ops: [] };

    let originLeft = entries[0].rect.left;
    let originTop = entries[0].rect.top;
    let maxRight = entries[0].rect.right;
    let maxBottom = entries[0].rect.bottom;
    for (let i = 1; i < entries.length; i += 1) {
      const rect = entries[i].rect;
      if (rect.left < originLeft) originLeft = rect.left;
      if (rect.top < originTop) originTop = rect.top;
      if (rect.right > maxRight) maxRight = rect.right;
      if (rect.bottom > maxBottom) maxBottom = rect.bottom;
    }

    const width = maxRight - originLeft;
    const height = maxBottom - originTop;
    const ratio = fitScale(width, height, opts.maxDimension);
    const ops = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const rect = entry.rect;
      ops.push({
        index: entry.index,
        sx: round3(entry.offsetX * entry.scale),
        sy: round3(entry.offsetY * entry.scale),
        sw: round3(rect.width * entry.scale),
        sh: round3(rect.height * entry.scale),
        dx: round3((rect.left - originLeft) * ratio),
        dy: round3((rect.top - originTop) * ratio),
        dw: round3(rect.width * ratio),
        dh: round3(rect.height * ratio),
      });
    }
    return {
      width: Math.max(1, Math.round(width * ratio)),
      height: Math.max(1, Math.round(height * ratio)),
      ops: ops,
    };
  }

  /* ── 环境探测（全部带兜底，测试桩里也不能炸） ────────────────────────── */

  function computedStyleOf(element) {
    if (!element) return null;
    try {
      if (typeof getComputedStyle === 'function') return getComputedStyle(element);
    } catch (error) {
      return null;
    }
    try {
      if (typeof window !== 'undefined' && window && typeof window.getComputedStyle === 'function') {
        return window.getComputedStyle(element);
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  /** 拿不到计算样式时按「可见」处理：宁可画出来，也别因为环境怪就整块丢掉。 */
  function isVisible(element) {
    const computed = computedStyleOf(element);
    if (!computed) return true;
    const display = computed.getPropertyValue('display');
    const visibility = computed.getPropertyValue('visibility');
    if (display === 'none' || visibility === 'hidden' || visibility === 'collapse') return false;
    const opacity = computed.getPropertyValue('opacity');
    if (opacity !== '' && Number(opacity) === 0) return false;
    return true;
  }

  function documentOf(element) {
    try {
      if (element && element.ownerDocument) return element.ownerDocument;
    } catch (error) {
      /* 跨文档访问会抛，落到全局 document */
    }
    try {
      if (typeof document !== 'undefined' && document) return document;
    } catch (error) {
      return null;
    }
    return null;
  }

  function rectOf(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return null;
    try {
      return normRect(element.getBoundingClientRect());
    } catch (error) {
      return null;
    }
  }

  function toArray(list) {
    if (!list) return [];
    if (Array.isArray(list)) return list;
    const out = [];
    for (let i = 0; i < list.length; i += 1) out.push(list[i]);
    return out;
  }

  function createCanvas(doc, width, height) {
    const canvas = doc.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  }

  function isTransparentColor(color) {
    const value = String(color || '')
      .replace(/\s+/g, '')
      .toLowerCase();
    if (!value || value === 'transparent') return true;
    return value === 'rgba(0,0,0,0)' || value === 'hsla(0,0%,0%,0)';
  }

  /**
   * 取页面底色：canvas 不认 CSS 变量，这里必须落成具体颜色。
   * 从 viewer 往上找第一个不透明的背景（阅读区自己常常是透明的），都没有就用白色兜底。
   */
  function backgroundOf(viewer) {
    let node = viewer;
    let depth = 0;
    while (node && depth < 8) {
      const computed = computedStyleOf(node);
      if (computed) {
        const color = computed.getPropertyValue('background-color');
        if (color && !isTransparentColor(color)) return color;
      }
      node = node.parentElement || null;
      depth += 1;
    }
    // 白色是「文档底色」最不会出错的假设；只在拿不到任何计算样式时才会走到这里。
    return '#ffffff';
  }

  /** HTML 块栅格化的倍率：跟屏幕 DPR 走，但封顶 2 —— 再高只是白烧内存。 */
  function htmlPixelRatio() {
    let ratio = 1;
    try {
      if (typeof window !== 'undefined' && window && isFiniteNumber(window.devicePixelRatio)) {
        ratio = window.devicePixelRatio;
      }
    } catch (error) {
      ratio = 1;
    }
    return clamp(ratio, 1, 2);
  }

  /* ── 取图：canvas / img / html ───────────────────────────────────────── */

  /**
   * PDF 页 canvas。位图尺寸和显示尺寸一般等比，但「一般」不够：取两者较小的倍率，
   * 保证源矩形一定落在位图里（否则 drawImage 会画出一块空白）。
   */
  function collectCanvases(viewer, area) {
    const pieces = [];
    let nodes;
    try {
      nodes = viewer.querySelectorAll('canvas');
    } catch (error) {
      nodes = [];
    }
    const list = toArray(nodes);
    for (let i = 0; i < list.length; i += 1) {
      const canvas = list[i];
      if (!canvas) continue;
      const bitmapWidth = isFiniteNumber(canvas.width) ? canvas.width : 0;
      const bitmapHeight = isFiniteNumber(canvas.height) ? canvas.height : 0;
      // 还没渲染的 PDF 页 canvas 是 0×0，跳过它，别把空白画进图里。
      if (bitmapWidth <= 0 || bitmapHeight <= 0) continue;
      const box = rectOf(canvas);
      if (!box || box.width <= 0 || box.height <= 0) continue;
      if (!isVisible(canvas)) continue;
      const hit = intersectRect(box, area);
      if (!hit) continue;
      const scale = Math.min(bitmapWidth / box.width, bitmapHeight / box.height);
      if (!(scale > 0)) continue;
      pieces.push({
        element: canvas,
        rect: hit,
        scale: scale,
        offset: { x: hit.left - box.left, y: hit.top - box.top },
        order: i,
      });
    }
    return pieces;
  }

  /** 普通图片：从原图裁，等于拿原图分辨率。坏图（naturalWidth 为 0）跳过。 */
  function collectImages(viewer, area) {
    const pieces = [];
    let nodes;
    try {
      nodes = viewer.querySelectorAll('img');
    } catch (error) {
      nodes = [];
    }
    const list = toArray(nodes);
    for (let i = 0; i < list.length; i += 1) {
      const image = list[i];
      if (!image) continue;
      const naturalWidth = isFiniteNumber(image.naturalWidth) ? image.naturalWidth : 0;
      const naturalHeight = isFiniteNumber(image.naturalHeight) ? image.naturalHeight : 0;
      if (naturalWidth <= 0 || naturalHeight <= 0) continue;
      const box = rectOf(image);
      if (!box || box.width <= 0 || box.height <= 0) continue;
      if (!isVisible(image)) continue;
      const hit = intersectRect(box, area);
      if (!hit) continue;
      // object-fit 不是 fill 时这个映射会有偏差，但比按显示尺寸裁清晰得多。
      const scale = Math.min(naturalWidth / box.width, naturalHeight / box.height);
      if (!(scale > 0)) continue;
      pieces.push({
        element: image,
        rect: hit,
        scale: scale,
        offset: { x: hit.left - box.left, y: hit.top - box.top },
        order: i,
      });
    }
    return pieces;
  }

  /**
   * HTML 兜底：把与选区相交的叶子块逐个栅格化。
   * 返回 { pieces, failed }；failed 只是「有块没画出来」，不该让整次截图失败。
   */
  async function renderHtmlBlocks(viewer, area) {
    const pieces = [];
    let failed = 0;
    let nodes;
    try {
      nodes = viewer.querySelectorAll(LEAF_SELECTOR);
    } catch (error) {
      nodes = [];
    }
    const list = toArray(nodes);
    for (let i = 0; i < list.length; i += 1) {
      const element = list[i];
      if (!element || element.nodeType !== 1) continue;
      // 只取最内层匹配：父块（比如带 p 的 li）整块渲染会和子块重复画一遍。
      let hasInner = false;
      try {
        hasInner = !!(element.querySelector && element.querySelector(LEAF_SELECTOR));
      } catch (error) {
        hasInner = false;
      }
      if (hasInner) continue;
      const box = rectOf(element);
      if (!box || box.width < 1 || box.height < 1) continue;
      if (!isVisible(element)) continue;
      const hit = intersectRect(box, area);
      if (!hit) continue;
      try {
        const rendered = await renderBlockToCanvas(element, box);
        if (!rendered) {
          failed += 1;
          continue;
        }
        pieces.push({
          element: rendered.canvas,
          rect: hit,
          scale: rendered.scale,
          offset: { x: hit.left - box.left, y: hit.top - box.top },
          order: i,
        });
      } catch (error) {
        failed += 1;
      }
    }
    return { pieces: pieces, failed: failed };
  }

  /**
   * 一个块 → 一张位图。
   *
   * 关键点：
   *   · cloneNode 之后把计算样式递归写成内联 —— SVG 图片是独立文档，页面的样式表带不进去；
   *   · 根块去掉 margin 并强制 border-box + width：getBoundingClientRect 不含 margin，
   *     留着 margin 内容会整体下移被 foreignObject 裁掉；
   *   · 整块渲染、再按 offset 裁 —— 选区只切到块的一半时，裁出来才是对的半块。
   */
  async function renderBlockToCanvas(element, box) {
    const doc = documentOf(element);
    if (!doc || typeof doc.createElement !== 'function') return null;
    if (typeof element.cloneNode !== 'function') return null;
    const width = Math.max(1, box.width);
    const height = Math.max(1, box.height);
    const clone = element.cloneNode(true);
    if (!clone) return null;
    inlineComputedStyles(element, clone);
    if (clone.style && typeof clone.style.setProperty === 'function') {
      clone.style.setProperty('margin', '0');
      clone.style.setProperty('box-sizing', 'border-box');
      clone.style.setProperty('width', width + 'px');
    }
    const markup = serializeXhtml(clone);
    if (!markup) return null;
    const image = await loadSvgImage(
      'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(buildSvg(markup, width, height)),
    );
    if (!image) return null;
    const scale = htmlPixelRatio();
    const canvas = createCanvas(doc, width * scale, height * scale);
    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return null;
    if (typeof ctx.setTransform === 'function') ctx.setTransform(scale, 0, 0, scale, 0, 0);
    else if (typeof ctx.scale === 'function') ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0, width, height);
    return { canvas: canvas, scale: scale };
  }

  function buildSvg(markup, width, height) {
    const boxStyle =
      'margin:0;padding:0;width:' +
      width +
      'px;height:' +
      height +
      'px;overflow:hidden;background:transparent;';
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' +
      width +
      '" height="' +
      height +
      '">' +
      '<foreignObject width="' +
      width +
      '" height="' +
      height +
      '">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="' +
      boxStyle +
      '">' +
      markup +
      '</div>' +
      '</foreignObject></svg>'
    );
  }

  /**
   * 加载 data URL 的 SVG。永远 resolve（成功给 Image，失败给 null）：
   * SVG 里只要有一张外部图片，Chromium 可能既不 onload 也不 onerror，所以加超时兜底。
   */
  function loadSvgImage(src) {
    return new Promise(function (resolve) {
      let Ctor = null;
      try {
        if (typeof Image === 'function') Ctor = Image;
        else if (typeof window !== 'undefined' && window && typeof window.Image === 'function') {
          Ctor = window.Image;
        }
      } catch (error) {
        Ctor = null;
      }
      if (!Ctor) {
        resolve(null);
        return;
      }
      let settled = false;
      let timer = 0;
      function finish(value) {
        if (settled) return;
        settled = true;
        if (timer && typeof clearTimeout === 'function') clearTimeout(timer);
        resolve(value);
      }
      const image = new Ctor();
      image.onload = function () {
        finish(image);
      };
      image.onerror = function () {
        finish(null);
      };
      if (typeof setTimeout === 'function') {
        timer = setTimeout(function () {
          finish(null);
        }, 8000);
      }
      try {
        image.src = src;
      } catch (error) {
        finish(null);
      }
    });
  }

  /**
   * 把 clone 序列化成能塞进 foreignObject 的 XHTML。
   *
   * 必须优先用 XMLSerializer：SVG 图片是按 XML 解析的，而 outerHTML 是 HTML 序列化 ——
   * 它会把 <br> / <img> 写成没有闭合的标签、把不换行空格写成 &nbsp;，这两样在 XML 里
   * 都是硬错误，解析器会直接判整张 SVG 非法（onerror），整个块就白渲染了。
   * 没有 XMLSerializer 的环境（老浏览器 / 单测桩）退回 outerHTML。
   */
  function serializeXhtml(node) {
    try {
      if (typeof XMLSerializer === 'function') {
        const serializer = new XMLSerializer();
        const text = serializer.serializeToString(node);
        if (text) return text;
      }
    } catch (error) {
      /* 跨文档节点等情况会抛，退回 outerHTML */
    }
    return typeof node.outerHTML === 'string' ? node.outerHTML : '';
  }

  /** 原树和 clone 树并行下钻，逐元素把计算样式抄过去（文本节点不用管）。 */
  function inlineComputedStyles(source, clone) {
    const sources = [source];
    const clones = [clone];
    while (sources.length > 0) {
      const from = sources.pop();
      const to = clones.pop();
      if (!from || !to || from.nodeType !== 1) continue;
      applyComputedStyle(from, to);
      const fromChildren = from.children;
      const toChildren = to.children;
      if (!fromChildren || !toChildren) continue;
      const count = Math.min(fromChildren.length, toChildren.length);
      for (let i = 0; i < count; i += 1) {
        sources.push(fromChildren[i]);
        clones.push(toChildren[i]);
      }
    }
  }

  function applyComputedStyle(from, to) {
    const computed = computedStyleOf(from);
    if (!computed || !to.style || typeof to.style.setProperty !== 'function') return;
    let sized = false;
    for (let i = 0; i < INLINE_PROPS.length; i += 1) {
      const prop = INLINE_PROPS[i];
      let value = '';
      try {
        value = computed.getPropertyValue(prop);
      } catch (error) {
        value = '';
      }
      if (!value) continue;
      // auto 的宽高写进内联没有意义，还会盖掉子元素自己的布局。
      if ((prop === 'width' || prop === 'height') && value === 'auto') continue;
      try {
        to.style.setProperty(prop, value);
        if (prop === 'width' || prop === 'height') sized = true;
      } catch (error) {
        /* 个别属性在 SVG 子元素上会被拒绝，跳过就好 */
      }
    }
    // getComputedStyle 的宽高是「内容盒」的值：显式声明 content-box 才能还原原元素总宽高。
    if (sized) {
      try {
        to.style.setProperty('box-sizing', 'content-box');
      } catch (error) {
        /* ignore */
      }
    }
  }

  /* ── 合成 + 编码 ─────────────────────────────────────────────────────── */

  /**
   * 把 plan 画进 ctx。extraScale 是「体积超限后整体再缩」用的，不动 plan 本身。
   * 单块画失败（位图被回收之类）只跳过这一块，不毁掉整张图。
   */
  function paint(ctx, plan, pieces, background, extraScale) {
    const scale = extraScale && extraScale > 0 ? extraScale : 1;
    if (typeof ctx.setTransform === 'function') ctx.setTransform(scale, 0, 0, scale, 0, 0);
    else if (typeof ctx.scale === 'function') ctx.scale(scale, scale);
    ctx.clearRect(0, 0, plan.width, plan.height);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, plan.width, plan.height);
    for (let i = 0; i < plan.ops.length; i += 1) {
      const op = plan.ops[i];
      const piece = pieces[op.index];
      if (!piece || !piece.element) continue;
      try {
        ctx.drawImage(
          piece.element,
          op.sx,
          op.sy,
          op.sw,
          op.sh,
          op.dx,
          op.dy,
          op.dw,
          op.dh,
        );
      } catch (error) {
        /* 单块失败可以接受 */
      }
    }
  }

  /** data URL 的 base64 段换算成字节数（向上取整，宁可保守）。 */
  function dataUrlBytes(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl) return 0;
    const comma = dataUrl.indexOf(',');
    const payload = comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length;
    return Math.ceil((payload * 3) / 4);
  }

  function isDataUrl(value) {
    return typeof value === 'string' && value.indexOf('data:') === 0 && value.indexOf(',') > 0;
  }

  function safeToDataUrl(canvas, type, quality) {
    try {
      const value = canvas.toDataURL(type, quality);
      return isDataUrl(value) ? value : '';
    } catch (error) {
      return '';
    }
  }

  function appendNote(note, extra) {
    if (!extra) return note || '';
    return note ? note + '；' + extra : extra;
  }

  function failure(reason, message) {
    return { ok: false, reason: reason, message: message };
  }

  function normalizeOptions(options) {
    const opts = options && typeof options === 'object' ? options : {};
    return {
      maxDimension:
        isFiniteNumber(opts.maxDimension) && opts.maxDimension > 0
          ? opts.maxDimension
          : DEFAULT_MAX_DIMENSION,
      maxBytes:
        isFiniteNumber(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES,
      allowHtml: opts.allowHtml === undefined ? true : !!opts.allowHtml,
    };
  }

  /**
   * 画布 → dataURL。PNG 优先；超体积就换 JPEG，再超就按 0.8 一轮轮缩。
   * toDataURL 抛异常 = 画布里混进了跨域图片（canvas 被污染），这是唯一「画不出来」的
   * 情况，单独给 tainted，让 UI 能说人话。
   */
  function encodePlan(canvas, doc, plan, pieces, background, opts, kind) {
    let dataUrl;
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch (error) {
      return failure('tainted', '框选区域里有跨域图片，画布被污染，截不出来');
    }
    if (!isDataUrl(dataUrl)) return failure('failed', '画布编码失败');

    let mediaType = 'image/png';
    let width = canvas.width;
    let height = canvas.height;
    let note = '';

    if (dataUrlBytes(dataUrl) > opts.maxBytes) {
      const jpeg = safeToDataUrl(canvas, 'image/jpeg', JPEG_QUALITY);
      if (jpeg) {
        dataUrl = jpeg;
        mediaType = 'image/jpeg';
        note = appendNote(note, '已转成 JPEG 控制体积');
      }
    }

    let shrink = 1;
    let rounds = 0;
    while (dataUrlBytes(dataUrl) > opts.maxBytes && rounds < MAX_SHRINK_ROUNDS) {
      const nextWidth = Math.round(plan.width * shrink * SHRINK_FACTOR);
      const nextHeight = Math.round(plan.height * shrink * SHRINK_FACTOR);
      if (nextWidth < MIN_SIDE || nextHeight < MIN_SIDE) break;
      shrink *= SHRINK_FACTOR;
      rounds += 1;
      const smaller = createCanvas(doc, nextWidth, nextHeight);
      const ctx = smaller.getContext ? smaller.getContext('2d') : null;
      if (!ctx) break;
      paint(ctx, plan, pieces, background, shrink);
      const encoded = safeToDataUrl(smaller, 'image/jpeg', JPEG_QUALITY);
      if (!encoded) break;
      dataUrl = encoded;
      mediaType = 'image/jpeg';
      width = smaller.width;
      height = smaller.height;
    }

    if (dataUrlBytes(dataUrl) > opts.maxBytes) {
      note = appendNote(note, '已压到最小仍超过体积上限');
    }

    const result = {
      ok: true,
      dataUrl: dataUrl,
      mediaType: mediaType,
      width: width,
      height: height,
      kind: kind,
    };
    if (note) result.note = note;
    return result;
  }

  function composePieces(pieces, kind, opts, background) {
    const plan = planCompose(pieces, { maxDimension: opts.maxDimension });
    if (plan.ops.length === 0) return failure('empty', '框选区域里没有可截图的内容');
    if (plan.width < MIN_SIDE || plan.height < MIN_SIDE) {
      return failure('too-small', '框选区域太小（至少 ' + MIN_SIDE + '×' + MIN_SIDE + ' 像素）');
    }
    const doc = documentOf(pieces[0].element);
    if (!doc || typeof doc.createElement !== 'function') {
      return failure('failed', '当前环境不支持 canvas');
    }
    const canvas = createCanvas(doc, plan.width, plan.height);
    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return failure('failed', '浏览器不支持 canvas 2D 上下文');
    paint(ctx, plan, pieces, background, 1);
    return encodePlan(canvas, doc, plan, pieces, background, opts, kind);
  }

  /* ── 主函数 ──────────────────────────────────────────────────────────── */

  /**
   * 截取视口矩形 rect 覆盖的那一块阅读区。
   *
   * 永不 reject：任何意外都收成 { ok:false, reason:'failed', message }，UI 只需要看 ok。
   * 返回 { ok:true, dataUrl, mediaType, width, height, kind, note? } 或
   *      { ok:false, reason:'too-small'|'empty'|'tainted'|'failed', message }。
   */
  async function captureRegion(viewer, rect, options) {
    try {
      const opts = normalizeOptions(options);
      if (!viewer || typeof viewer.querySelectorAll !== 'function') {
        return failure('empty', '没有阅读区，截不到东西');
      }
      const area = normRect(rect);
      if (!area) return failure('empty', '框选区域无效');
      if (area.width < MIN_SIDE || area.height < MIN_SIDE) {
        return failure(
          'too-small',
          '框选区域太小（至少 ' + MIN_SIDE + '×' + MIN_SIDE + ' 像素）',
        );
      }
      const background = backgroundOf(viewer);

      // 优先级：位图（PDF canvas）> 原图（img）> HTML 兜底。
      const canvases = collectCanvases(viewer, area);
      if (canvases.length > 0) return composePieces(canvases, 'pdf', opts, background);

      const images = collectImages(viewer, area);
      if (images.length > 0) return composePieces(images, 'img', opts, background);

      if (!opts.allowHtml) return failure('empty', '框选区域里没有可截图的内容');

      const blocks = await renderHtmlBlocks(viewer, area);
      if (blocks.pieces.length === 0) {
        if (blocks.failed > 0) return failure('failed', '框选区域里的内容没能渲染成图');
        return failure('empty', '框选区域里没有可截图的内容');
      }
      const result = composePieces(blocks.pieces, 'html', opts, background);
      if (result.ok && blocks.failed > 0) {
        result.note = appendNote(result.note, '有 ' + blocks.failed + ' 个块没能渲染');
      }
      return result;
    } catch (error) {
      return failure('failed', String((error && error.message) || error));
    }
  }

  /* ── 样式（由 shell 拼进总样式表） ───────────────────────────────────── */

  const css = `
/* ── region screenshot (48-shot.js) ─────────────────────────────────── */
.dm-shot-marquee {
  position: absolute;
  z-index: 90;
  border: 1.5px dashed var(--dm-accent);
  background: color-mix(in srgb, var(--dm-accent) 12%, transparent);
  border-radius: 4px;
  pointer-events: none;
}
.dm-shot-marquee__size {
  position: absolute;
  right: -1px;
  bottom: -22px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--dm-accent);
  color: var(--dm-on-accent);
  font-size: 10.5px;
  line-height: 16px;
  white-space: nowrap;
}
`;

  return {
    captureRegion: captureRegion,
    intersectRect: intersectRect,
    planCompose: planCompose,
    fitScale: fitScale,
    css: css,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createShot };
