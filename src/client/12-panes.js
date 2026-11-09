/* ===== 12-panes.js ===== */
/**
 * 三栏宽度的拖拽调整：左（研究区）↔ 中（阅读区）↔ 右（伴随 AI）。
 *
 * 为什么宽度数学要抽成纯函数 resolveSizes：
 *   三栏是 flex 布局，浏览器会自己分配剩余空间，但它不知道两条业务约束 ——
 *   「中间阅读区任何时刻至少 380px」和「窗口变窄时先压右栏、再压左栏、最后一起按比例压」。
 *   把这些规则写进一个不碰 DOM 的函数，单测可以直接喂数字验证；组件只负责把结果变成
 *   inline style，拖拽只负责把指针位移换算成「我想要多宽」。两边都不需要浏览器。
 *
 * 为什么持久化要单独一层（readSizes / writeSizes）：
 *   localStorage 的 docmate.panes 里还存着 {side, chat, manual} 三个字段（栏的折叠状态，
 *   以及「用户手动折过、窗口变宽也别自动弹回来」的语义）。写宽度必须**合并**而不是覆盖，
 *   否则拖一次分隔条就把折叠状态清了，下次刷新左栏自己冒出来。读的时候任何坏数据
 *   （字符串 / null / 越界 / 手改过的 localStorage）都要退回默认，不能让面板变成 0 宽。
 *
 * 拖拽实现的两个要点：
 *   · 拖动时盖一层全屏透明 overlay：PDF 的 canvas 很能吃 pointer 事件，不盖住就只能拖到
 *     一半；overlay 同时负责 col-resize 光标和「禁止选中文本」。面板根上还会加
 *     is-resizing，CSS 里把 [data-dm-viewer] 的 pointer-events 关掉，双保险。
 *   · 双击 / Enter 恢复默认，方向键 ±16px，Home/End 到最小/最大 —— 只用键盘也能调。
 *
 * 暴露为 createPanes(React, util) -> { PaneHandle, DEFAULTS, LIMITS, resolveSizes,
 * readSizes, writeSizes, css }。keyboardStep 是给单测用的纯函数（PaneHandle 自己也用它）。
 */
function createPanes(React, util) {
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;

  const cx =
    util && typeof util.cx === 'function'
      ? util.cx
      : function fallbackCx() {
          return Array.prototype.filter.call(arguments, Boolean).join(' ');
        };
  const clamp =
    util && typeof util.clamp === 'function'
      ? util.clamp
      : function fallbackClamp(value, min, max) {
          return Math.min(max, Math.max(min, value));
        };

  /* ── 常量 ────────────────────────────────────────────────────────────── */

  /** 和 70-app.js 里读写的键一致。片段之间不能共享常量，所以这里再写一遍。 */
  const LS_KEY = 'docmate.panes';

  /** 双击 / Enter 恢复到的宽度，也是第一次打开面板时的宽度。 */
  const DEFAULTS = { left: 236, right: 348 };

  /**
   * 拖拽能到的范围。注意这不是「渲染出来的宽度」的硬边界：面板太窄时 resolveSizes 会把
   * 两侧压到 min 以下（甚至 0），因为「中间留 380」的优先级更高。
   */
  const LIMITS = {
    left: { min: 176, max: 520 },
    right: { min: 268, max: 640 },
    centre: 380,
    handle: 6,
    step: 16,
  };

  /** 只接受真正的有限数字：字符串 / null / NaN 一律当没给。 */
  function sizeOr(value, fallback) {
    if (typeof value !== 'number' || !isFinite(value)) return fallback;
    return value;
  }

  /* ── 1. 宽度分配（纯函数） ───────────────────────────────────────────── */

  /**
   * 把「用户想要的宽度」变成「这一帧真正渲染的宽度」。
   *
   * 规则，按优先级：
   *   1. 两侧先各自夹进 [min, max]（拖拽范围）；
   *   2. 中间阅读区不够 380 时，先收右栏到它的 min，再收左栏到它的 min；
   *   3. 连两侧的 min 都放不下（面板 < 836px 且两栏都开着），按比例一起压到 0 ——
   *      宁可侧栏变窄，也不让中间被挤没，更不出现负宽度；
   *   4. 折叠的栏返回 0，它的分隔条也不占宽度。
   *
   * 面板宽度还没量到（首帧 / 单测）时不做任何收窄：否则三栏会先塌一下再弹回来。
   *
   * @returns {{ left: number, right: number }} 整数像素
   */
  function resolveSizes(panelWidth, wantLeft, wantRight, opts) {
    const options = opts || {};
    const showLeft = options.showLeft !== false;
    const showRight = options.showRight !== false;
    const handleWidth = Math.max(0, sizeOr(options.handleWidth, LIMITS.handle));
    const minCentre = Math.max(0, sizeOr(options.minCentre, LIMITS.centre));
    const minLeft = sizeOr(options.minLeft, LIMITS.left.min);
    const maxLeft = sizeOr(options.maxLeft, LIMITS.left.max);
    const minRight = sizeOr(options.minRight, LIMITS.right.min);
    const maxRight = sizeOr(options.maxRight, LIMITS.right.max);

    let left = showLeft ? clamp(sizeOr(wantLeft, DEFAULTS.left), minLeft, maxLeft) : 0;
    let right = showRight ? clamp(sizeOr(wantRight, DEFAULTS.right), minRight, maxRight) : 0;

    const width = sizeOr(panelWidth, 0);
    if (!(width > 0)) return { left: Math.round(left), right: Math.round(right) };

    const handles = (showLeft ? handleWidth : 0) + (showRight ? handleWidth : 0);
    const total = Math.round(width);
    // 两侧栏最多能占这么多，剩下的必须留给中间
    const budget = total - handles - minCentre;

    let overflow = left + right - budget;
    if (overflow > 0) {
      if (right > minRight) {
        const take = Math.min(overflow, right - minRight);
        right -= take;
        overflow -= take;
      }
      if (overflow > 0 && left > minLeft) {
        const take = Math.min(overflow, left - minLeft);
        left -= take;
        overflow -= take;
      }
      if (overflow > 0) {
        const room = Math.max(0, budget);
        const sum = left + right;
        const factor = sum > 0 ? Math.min(1, room / sum) : 0;
        left = left * factor;
        right = right * factor;
      }
    }

    let leftOut = Math.max(0, Math.round(left));
    let rightOut = Math.max(0, Math.round(right));
    // 四舍五入可能多占 1px，从宽的那边扣掉，保证中间区不被偷走
    let excess = leftOut + rightOut - Math.max(0, budget);
    while (excess > 0) {
      if (rightOut >= leftOut && rightOut > 0) {
        rightOut -= 1;
        excess -= 1;
      } else if (leftOut > 0) {
        leftOut -= 1;
        excess -= 1;
      } else {
        break;
      }
    }
    return { left: leftOut, right: rightOut };
  }

  /* ── 2. 持久化（容错读写） ───────────────────────────────────────────── */

  /** `lsGet` 是 util.lsGet。坏数据（null / 字符串 / 越界）一律退回默认。 */
  function readSizes(lsGet) {
    let stored = null;
    try {
      if (typeof lsGet === 'function') stored = lsGet(LS_KEY, null);
    } catch (error) {
      stored = null;
    }
    if (!stored || typeof stored !== 'object') stored = {};
    return {
      left: clamp(sizeOr(stored.leftW, DEFAULTS.left), LIMITS.left.min, LIMITS.left.max),
      right: clamp(sizeOr(stored.rightW, DEFAULTS.right), LIMITS.right.min, LIMITS.right.max),
    };
  }

  /**
   * 把宽度合并进 docmate.panes。
   *
   * `base` 是**当前已存的对象**（调用方用 lsGet 读出来传进来）。不传也能用，但那样
   * side / chat / manual 会丢 —— 折叠状态就没了。所以约定：调用方必须传。
   * 返回真正写进去的那个对象，方便单测断言。
   */
  function writeSizes(lsSet, sizes, base) {
    const previous = base && typeof base === 'object' ? base : {};
    const next = Object.assign({}, previous);
    const wanted = sizes && typeof sizes === 'object' ? sizes : {};
    next.leftW = clamp(sizeOr(wanted.left, DEFAULTS.left), LIMITS.left.min, LIMITS.left.max);
    next.rightW = clamp(sizeOr(wanted.right, DEFAULTS.right), LIMITS.right.min, LIMITS.right.max);
    try {
      if (typeof lsSet === 'function') lsSet(LS_KEY, next);
    } catch (error) {
      /* 存不进去不影响本次会话，宽度只是下次打开时回到默认 */
    }
    return next;
  }

  /* ── 3. 键盘步进（纯函数） ───────────────────────────────────────────── */

  /**
   * 方向键 / Home / End / Enter 的语义。
   *
   * 语义是「移动分隔条」，不是「加宽某一栏」：左分隔条按右 → 研究区变宽；右分隔条按右 →
   * 伴随 AI 变窄。这样两个分隔条的手感一致，和鼠标拖动也一致。
   *
   * @returns {{ type: 'set', width: number } | { type: 'reset' } | null}
   *          null 表示这个键不归分隔条管（调用方不该 preventDefault）。
   */
  function keyboardStep(width, key, opts) {
    const options = opts || {};
    const side = options.side === 'right' ? 'right' : 'left';
    const min = sizeOr(options.min, LIMITS[side].min);
    const max = sizeOr(options.max, LIMITS[side].max);
    const step = Math.max(1, sizeOr(options.step, LIMITS.step));
    const current = clamp(sizeOr(width, DEFAULTS[side]), min, max);
    if (key === 'Enter') return { type: 'reset' };
    if (key === 'Home') return { type: 'set', width: min };
    if (key === 'End') return { type: 'set', width: max };
    if (key === 'ArrowLeft') {
      return { type: 'set', width: clamp(current + (side === 'left' ? -step : step), min, max) };
    }
    if (key === 'ArrowRight') {
      return { type: 'set', width: clamp(current + (side === 'left' ? step : -step), min, max) };
    }
    return null;
  }

  /* ── 4. 分隔条组件 ───────────────────────────────────────────────────── */

  /**
   * 一条分隔条。
   *
   * props：`{ side, width, min, max, onDrag, onReset, disabled }`
   *   side     'left' | 'right'（决定拖动方向，以及 aria-label）
   *   width    当前这一栏渲染出来的宽度（拖动起点，也是 aria-valuenow）
   *   min/max  拖拽范围
   *   onDrag(nextWidth)  拖动中 / 键盘调整时回调（已夹进 [min, max]）
   *   onReset()          双击或 Enter
   *   disabled           框选截图模式下为 true：不响应拖拽和键盘
   * 另外可选 `onDragStart()` / `onDragEnd()`：面板根要用它们挂 is-resizing 类、并在
   * 拖动结束时落盘（每次 pointermove 都写 localStorage 太浪费）。
   */
  function PaneHandle(props) {
    const p = props || {};
    const side = p.side === 'right' ? 'right' : 'left';
    const width = sizeOr(p.width, DEFAULTS[side]);
    const min = sizeOr(p.min, LIMITS[side].min);
    const max = sizeOr(p.max, LIMITS[side].max);
    const disabled = !!p.disabled;

    const [dragging, setDragging] = useState(false);
    const dragRef = useRef(null);
    // 回调放进 ref：拖动过程中父组件每次 setState 都会重新渲染，把 onDrag 写进 effect
    // 依赖会让监听器被反复拆装（而且 pointermove 期间拆装很容易丢事件）。
    const handlersRef = useRef(null);
    handlersRef.current = {
      onDrag: typeof p.onDrag === 'function' ? p.onDrag : null,
      onReset: typeof p.onReset === 'function' ? p.onReset : null,
      onDragStart: typeof p.onDragStart === 'function' ? p.onDragStart : null,
      onDragEnd: typeof p.onDragEnd === 'function' ? p.onDragEnd : null,
    };

    useEffect(() => {
      if (!dragging) return undefined;
      if (typeof document === 'undefined' || !document || typeof document.addEventListener !== 'function') {
        return undefined;
      }
      const doc = document;

      function move(event) {
        const drag = dragRef.current;
        if (!drag) return;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const pointX = event && typeof event.clientX === 'number' ? event.clientX : event && event.pageX;
        if (typeof pointX !== 'number') return;
        const dx = pointX - drag.startX;
        // 左分隔条往右拖 = 左栏变宽；右分隔条往右拖 = 右栏变窄。
        const delta = side === 'left' ? dx : -dx;
        // 下限取 min 与起始宽度的较小值：极窄面板里当前宽度可能已经被挤到 min 以下，
        // 那种情况下拖动不该把它「跳」回 min。
        const lo = Math.min(min, drag.startWidth);
        const next = clamp(drag.startWidth + delta, lo, max);
        const handlers = handlersRef.current;
        if (handlers && handlers.onDrag) handlers.onDrag(next);
      }

      function stop() {
        if (!dragRef.current) return;
        dragRef.current = null;
        setDragging(false);
        const handlers = handlersRef.current;
        if (handlers && handlers.onDragEnd) handlers.onDragEnd();
      }

      doc.addEventListener('pointermove', move);
      doc.addEventListener('pointerup', stop);
      doc.addEventListener('pointercancel', stop);
      return function cleanup() {
        doc.removeEventListener('pointermove', move);
        doc.removeEventListener('pointerup', stop);
        doc.removeEventListener('pointercancel', stop);
      };
    }, [dragging, side, min, max]);

    function handlePointerDown(event) {
      if (disabled) return;
      if (event && typeof event.button === 'number' && event.button !== 0) return;
      // 阻止浏览器从分隔条开始拖选正文；焦点手动补回来（preventDefault 会吃掉它）。
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (event && event.currentTarget && typeof event.currentTarget.focus === 'function') {
        try {
          event.currentTarget.focus();
        } catch (error) {
          /* 聚焦失败不影响拖动 */
        }
      }
      // 显式捕获指针：拖到窗口外面再松手时 pointerup 仍然会送到这个元素上，
      // 否则拖动会卡在「一直按着」的状态（overlay 还挂着、光标还是 col-resize）。
      if (
        event &&
        typeof event.pointerId === 'number' &&
        event.currentTarget &&
        typeof event.currentTarget.setPointerCapture === 'function'
      ) {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch (error) {
          /* 捕获失败就退回 document 监听，拖动照常 */
        }
      }
      const pointX = event && typeof event.clientX === 'number' ? event.clientX : event && event.pageX;
      dragRef.current = {
        startX: typeof pointX === 'number' ? pointX : 0,
        startWidth: width,
      };
      setDragging(true);
      const handlers = handlersRef.current;
      if (handlers && handlers.onDragStart) handlers.onDragStart();
    }

    function handleDoubleClick(event) {
      if (disabled) return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const handlers = handlersRef.current;
      if (handlers && handlers.onReset) handlers.onReset();
    }

    function handleKeyDown(event) {
      if (!event || disabled) return;
      const result = keyboardStep(width, event.key, { side: side, min: min, max: max });
      if (!result) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      const handlers = handlersRef.current;
      if (result.type === 'reset') {
        if (handlers && handlers.onReset) handlers.onReset();
        return;
      }
      if (handlers && handlers.onDrag) handlers.onDrag(result.width);
      // 键盘调整没有 pointerup，改一次就落一次盘。
      if (handlers && handlers.onDragEnd) handlers.onDragEnd();
    }

    const label = side === 'left' ? '调整研究区宽度' : '调整伴随 AI 宽度';

    return h(
      'div',
      {
        className: cx(
          'dm-panehandle',
          'dm-panehandle--' + side,
          dragging && 'is-dragging',
          disabled && 'is-disabled',
        ),
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': label,
        'aria-valuenow': Math.round(width),
        'aria-valuemin': Math.round(min),
        'aria-valuemax': Math.round(max),
        'aria-disabled': disabled ? 'true' : undefined,
        tabIndex: disabled ? -1 : 0,
        title: '拖动调整宽度 · 双击恢复默认',
        onPointerDown: handlePointerDown,
        onDoubleClick: handleDoubleClick,
        onKeyDown: handleKeyDown,
      },
      h('span', { className: 'dm-panehandle__line', 'aria-hidden': 'true' }),
      dragging ? h('div', { className: 'dm-pane-overlay', 'aria-hidden': 'true' }) : null,
    );
  }

  /* ── 5. 样式 ─────────────────────────────────────────────────────────── */

  const css = `
/* ── 三栏分隔条（12-panes.js） ────────────────────────────────────────── */
.dm-panehandle {
  flex: 0 0 6px;
  position: relative;
  align-self: stretch;
  min-height: 0;
  background: transparent;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  outline: none;
}
.dm-panehandle__line {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  margin-left: -0.5px;
  background: var(--dm-line-2);
  transition: background 120ms ease, width 120ms ease, margin-left 120ms ease;
}
.dm-panehandle:hover .dm-panehandle__line,
.dm-panehandle.is-dragging .dm-panehandle__line,
.dm-panehandle:focus-visible .dm-panehandle__line {
  width: 2px;
  margin-left: -1px;
  background: var(--dm-accent);
}
.dm-panehandle:hover { background: var(--dm-accent-soft); }
.dm-panehandle:focus-visible {
  outline: 2px solid var(--dm-accent);
  outline-offset: -2px;
  border-radius: 3px;
}
.dm-panehandle.is-disabled { cursor: default; }
.dm-panehandle.is-disabled:hover { background: transparent; }
.dm-panehandle.is-disabled:hover .dm-panehandle__line {
  width: 1px;
  margin-left: -0.5px;
  background: var(--dm-line-2);
}

/* 拖动时盖住整个视口：接管光标、挡住 PDF canvas 的 pointer 事件、顺带禁止选中文本。 */
.dm-pane-overlay {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 900;
  cursor: col-resize;
  background: transparent;
}
.dm-root.is-resizing {
  cursor: col-resize;
  user-select: none;
  -webkit-user-select: none;
}
.dm-root.is-resizing [data-dm-viewer],
.dm-root.is-resizing [data-dm-viewer] * { pointer-events: none; }

/* 框选截图模式下分隔条让路：拖拽是画框，不是调宽度。 */
.dm-root.is-shot .dm-panehandle { pointer-events: none; cursor: default; }
`;

  return {
    PaneHandle: PaneHandle,
    DEFAULTS: DEFAULTS,
    LIMITS: LIMITS,
    resolveSizes: resolveSizes,
    readSizes: readSizes,
    writeSizes: writeSizes,
    keyboardStep: keyboardStep,
    css: css,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createPanes };
