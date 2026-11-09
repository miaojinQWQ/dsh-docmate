/* ===== 58-find.js ===== */
/**
 * 文档内搜索（Ctrl/Cmd+F 那种）：在阅读区里找纯文本、把所有命中涂出来、逐个跳过去。
 *
 * 为什么用 CSS Custom Highlight API 而不是包一层 `<mark>`：
 *   阅读区是 React 管的，插包装节点会跟 reconciliation 打架；PDF 文本层还是按页重建的，
 *   包装节点活不过一次翻页。Highlight 只写 `CSS.highlights`、不碰 DOM，所以重绘也不会
 *   反过来触发 MutationObserver 之类的自激循环（52-highlights.js 里有同一段推理）。
 *
 * 为什么搜索要「先拼大字符串、再把偏移映射回文本节点」：
 *   命中可能横跨多个文本节点（`<strong>` 把一句话切成两半、KaTeX 把公式拆成一堆 span），
 *   逐个节点 indexOf 会漏掉这种命中。拼成一条字符串再找，命中位置就是全局偏移，最后按
 *   每个节点的 [start,end) 区间切回 Range —— 一个命中跨几个节点就产出几个 Range。
 *
 * 为什么跳过 `.katex-mathml`：
 *   KaTeX 把同一个公式渲染两遍：`.katex-mathml`（MathML，给读屏）和 `.katex-html`
 *   （可见的排版）。两处文字一样，不跳过的话每个公式都会被数成两次命中。跳过 MathML
 *   那份、留下可见那份，用户看到的和搜到的才对得上。
 *
 * 降级：`CSS.highlights` / `Highlight` 缺失（老浏览器）时 paintMatches 返回 false，
 * 搜索、计数、跳转照常工作，只是不涂色。
 *
 * 暴露为 `createFind(React, util) -> { FindBar, findIn, paintMatches, clearMatches,
 * scrollToMatch, css }`。`css` 是字符串，由 shell 追加进插件样式表。
 *
 * FindBar 的 props 契约（受控组件，自己不留状态）：
 *   { query, count, index, onQuery, onPrev, onNext, onClose }
 *   query —— 输入框里的字符串（受控）
 *   count —— 命中总数；0 时显示「无结果」
 *   index —— 当前命中下标（从 0 开始），显示成 index+1 / count
 *   onQuery(value) / onPrev() / onNext() / onClose()
 * 它是 `position: absolute` 的浮条，shell 要把它放进一个 `position: relative` 的容器
 * （阅读区那一栏），否则它会浮到最近的定位祖先上去。
 */
function createFind(React, util) {
  const h = React.createElement;
  const { useEffect, useRef } = React;

  const cx =
    util && typeof util.cx === 'function'
      ? util.cx
      : function fallbackCx() {
          return Array.prototype.filter.call(arguments, Boolean).join(' ');
        };
  const Icon =
    util && typeof util.Icon === 'function'
      ? util.Icon
      : function fallbackIcon() {
          return null;
        };

  /* ── 常量 ────────────────────────────────────────────────────────────── */

  /** 两个注册名。固定字符串，清空时无需知道当前命中了什么。 */
  const HIGHLIGHT_ALL = 'dm-find';
  const HIGHLIGHT_CURRENT = 'dm-find-current';

  /**
   * 2000 是「够用」和「别把主线程卡住」之间的折中：一个几十页的文档搜「的」能到几万次，
   * 全量造 Range 会明显掉帧，而用户实际上不会翻到第 2001 个。
   */
  const MAX_MATCHES = 2000;

  const PREVIEW_RADIUS = 18;
  const PREVIEW_MAX = 90;
  const SCROLL_MARGIN = 96;

  /** 整棵子树都不该进搜索索引的标签。 */
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };

  const MATHML_CLASS = 'katex-mathml';
  const KATEX_HTML_CLASS = 'katex-html';

  /** 搜索条自己的根类名。它可能就渲染在被搜的容器里，见 isSkipped。 */
  const BAR_CLASS = 'dm-find';

  /* ── 节点过滤（纯函数，单测直接喂假节点） ────────────────────────────── */

  function classListOf(element) {
    const raw = element && element.className;
    // SVG 元素的 className 是 SVGAnimatedString，不是字符串 —— 当没有类名处理。
    if (typeof raw !== 'string' || !raw) return [];
    return raw.split(/\s+/);
  }

  function hasClass(element, name) {
    return classListOf(element).indexOf(name) >= 0;
  }

  function ariaHiddenOf(element) {
    let value = null;
    try {
      if (element && typeof element.getAttribute === 'function') value = element.getAttribute('aria-hidden');
    } catch (error) {
      value = null;
    }
    if (value === null || value === undefined) value = element && element.ariaHidden;
    return String(value === null || value === undefined ? '' : value).toLowerCase() === 'true';
  }

  /**
   * 这个文本节点（或元素子树）是否该被搜索跳过。
   *
   * 三个理由，按代价从低到高：
   *   · `<script>/<style>` 里的字不是给人看的；
   *   · `.katex-mathml` 是 KaTeX 的读屏副本，和 `.katex-html` 文字重复；
   *   · `aria-hidden="true"` 是给读屏的「别念这里」，对搜索同样成立。
   * 唯一的例外是 `.katex-html`：KaTeX 恰好把**可见**那份标成 aria-hidden，而它的重复
   * 副本 `.katex-mathml` 已经被上一条跳过了。所以这里放行 `.katex-html`，否则公式里的
   * 字一个都搜不到。
   *
   * 还有一条不是「不可见」而是「不能自指」：搜索条自己（`.dm-find`）也要跳过。shell
   * 很可能把浮条渲染进阅读区那个容器里，不跳过的话搜「无结果」会命中计数文字，命中数
   * 会自己长出来 —— 典型的一改状态就重新搜索、一搜索又改状态。
   *
   * 注意会一路看到根：祖先被 aria-hidden 的内容本来就不该被搜到，这和「只搜可见文本」
   * 是同一个语义。
   */
  function isSkipped(node) {
    let current = node && node.nodeType === 3 ? node.parentNode : node;
    while (current && current.nodeType === 1) {
      const tag = String(current.tagName || current.nodeName || '').toUpperCase();
      if (SKIP_TAGS[tag]) return true;
      if (hasClass(current, MATHML_CLASS)) return true;
      if (hasClass(current, BAR_CLASS)) return true;
      if (ariaHiddenOf(current) && !hasClass(current, KATEX_HTML_CLASS)) return true;
      current = current.parentNode;
    }
    return false;
  }

  /* ── 文本收集 + 偏移映射（纯函数，不碰 DOM） ─────────────────────────── */

  /**
   * `[{ node, text }]` → `{ text, offsets }`。
   *
   * `text` 是所有可搜文本拼成的一整条字符串；`offsets` 是每个节点在这条字符串里的
   * `[start, end)`。空文本节点不占位（否则会造出一堆零长度区间，映射时还得跳过）。
   *
   * 这里再过滤一遍 isSkipped：它是纯函数、也是单测直接喂数据的入口，不能假设调用方
   * 已经剪过枝。生产路径上 textNodesOf 已经剪过一次，重复一次只是几个字符串比较。
   *
   * 也接受裸字符串条目（`['abc', 'def']`），单测里拼小例子更省事。
   */
  function collectText(entries) {
    const parts = [];
    const offsets = [];
    const list = Array.isArray(entries) ? entries : [];
    let total = 0;
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      if (entry === null || entry === undefined) continue;
      const isRecord = typeof entry === 'object';
      const node = isRecord ? entry.node || null : null;
      const raw = isRecord ? entry.text : entry;
      const text = raw === null || raw === undefined ? '' : String(raw);
      if (!text) continue;
      if (node && isSkipped(node)) continue;
      offsets.push({ node: node, start: total, end: total + text.length });
      parts.push(text);
      total += text.length;
    }
    return { text: parts.join(''), offsets: offsets };
  }

  /**
   * 全局区间 `[start, end)` → 每个节点内的局部区间 `[{ node, start, end }]`。
   *
   * 返回的 `start/end` 是**节点内**偏移，可以直接喂 `range.setStart(node, start)`。
   * 一个命中跨几个节点就返回几段；落在节点边界上的零长度段直接丢掉。
   */
  function locate(offsets, start, end) {
    const out = [];
    const list = Array.isArray(offsets) ? offsets : [];
    const from = Math.max(0, Math.min(start, end));
    const to = Math.max(start, end);
    if (to <= from) return out;
    for (let index = 0; index < list.length; index += 1) {
      const span = list[index];
      if (!span) continue;
      const begin = Math.max(span.start, from);
      const finish = Math.min(span.end, to);
      if (finish <= begin) continue;
      out.push({ node: span.node, start: begin - span.start, end: finish - span.start });
    }
    return out;
  }

  /**
   * 在一整条字符串里找 `query`，返回全局区间。
   *
   * 大小写不敏感靠两边都 toLowerCase：中文没有大小写，这一步对它是恒等变换，所以
   * 中英混排的文档可以走同一条路径。代价是个别字符（土耳其语 İ 之类）小写后长度会变，
   * 那种文档的偏移会轻微错位 —— 中文/英文/常见欧文不受影响，不值得为它上 Intl.Segmenter。
   *
   * 命中不重叠（"aa" 在 "aaaa" 里是 2 个而不是 3 个），和浏览器的查找行为一致。
   */
  function searchText(text, query, limit) {
    const haystack = text === null || text === undefined ? '' : String(text);
    const needle = query === null || query === undefined ? '' : String(query);
    const cap =
      typeof limit === 'number' && isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_MATCHES;
    const spans = [];
    if (!needle || !haystack) return { spans: spans, truncated: false };

    const lowerHay = haystack.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    const step = Math.max(1, needle.length);
    let from = 0;
    while (spans.length < cap) {
      const at = lowerHay.indexOf(lowerNeedle, from);
      if (at < 0) break;
      spans.push({ start: at, end: at + needle.length });
      from = at + step;
    }

    // 刚好撞到上限时还要再看一眼：正好 cap 个命中不算截断，还有第 cap+1 个才算。
    let truncated = false;
    if (spans.length >= cap) truncated = lowerHay.indexOf(lowerNeedle, from) >= 0;
    return { spans: spans, truncated: truncated };
  }

  /** 命中前后各留一点上下文，压成一行，太长再截。 */
  function previewOf(text, start, end) {
    const source = text === null || text === undefined ? '' : String(text);
    const from = Math.max(0, start - PREVIEW_RADIUS);
    const to = Math.min(source.length, end + PREVIEW_RADIUS);
    let snippet = source.slice(from, to).replace(/\s+/g, ' ').trim();
    if (snippet.length > PREVIEW_MAX) snippet = snippet.slice(0, PREVIEW_MAX - 1) + '…';
    return (from > 0 ? '…' : '') + snippet + (to < source.length ? '…' : '');
  }

  /* ── DOM 侧 ──────────────────────────────────────────────────────────── */

  /**
   * container 里所有该被搜索的文本节点，文档顺序。
   *
   * 不用 TreeWalker：需要在**元素层**把 `.katex-mathml` 整棵子树剪掉，递归剪枝比
   * walker + filter 更直接；而且测试里的假 DOM 走的是同一条路径 —— 生产和单测同构，
   * 少一处「只在浏览器里才跑」的分支。
   */
  function textNodesOf(root) {
    const nodes = [];
    if (!root) return nodes;
    (function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        nodes.push(node);
        return;
      }
      if (node.nodeType !== 1) return;
      if (isSkipped(node)) return;
      const children = node.childNodes;
      if (!children) return;
      for (let index = 0; index < children.length; index += 1) walk(children[index]);
    })(root);
    return nodes;
  }

  function createRange() {
    try {
      if (typeof document !== 'undefined' && document && typeof document.createRange === 'function') {
        return document.createRange();
      }
      if (typeof Range === 'function') return new Range();
    } catch (error) {
      /* 没有 Range 的环境（单测）继续往下走，match 只是没有 ranges */
    }
    return null;
  }

  function rangeFor(node, start, end) {
    if (!node) return null;
    const range = createRange();
    if (!range) return null;
    try {
      range.setStart(node, start);
      range.setEnd(node, end);
      return range;
    } catch (error) {
      // 偏移越界（toLowerCase 改变长度那种极端输入）只丢这一段，不影响别的命中。
      return null;
    }
  }

  /**
   * 在 container 里搜 query。
   *
   * 返回 `{ matches, truncated }`，每个 match 是
   * `{ ranges, preview, node }`：
   *   ranges —— 这个命中覆盖的 Range 列表（跨节点时不止一个；没有 Range API 时为空）
   *   preview —— 命中前后各 ~18 字的上下文，压成一行
   *   node —— 第一个 Range 的起始文本节点，给 scrollToMatch 用
   */
  function findIn(container, query, options) {
    const needle = query === null || query === undefined ? '' : String(query);
    const opts = options || {};
    const limit =
      typeof opts.limit === 'number' && isFinite(opts.limit) && opts.limit > 0
        ? Math.floor(opts.limit)
        : MAX_MATCHES;
    if (!container || !needle) return { matches: [], truncated: false };

    const nodes = textNodesOf(container);
    const entries = [];
    for (let index = 0; index < nodes.length; index += 1) {
      entries.push({ node: nodes[index], text: nodes[index].nodeValue });
    }
    const bag = collectText(entries);
    const found = searchText(bag.text, needle, limit);

    const matches = [];
    for (let index = 0; index < found.spans.length; index += 1) {
      const span = found.spans[index];
      const segments = locate(bag.offsets, span.start, span.end);
      const ranges = [];
      for (let slot = 0; slot < segments.length; slot += 1) {
        const range = rangeFor(segments[slot].node, segments[slot].start, segments[slot].end);
        if (range) ranges.push(range);
      }
      matches.push({
        ranges: ranges,
        preview: previewOf(bag.text, span.start, span.end),
        node: ranges.length ? ranges[0].startContainer : segments.length ? segments[0].node : null,
      });
    }
    return { matches: matches, truncated: found.truncated };
  }

  /* ── 涂色 / 清空 ─────────────────────────────────────────────────────── */

  /**
   * 只看注册表本身，不要求 document：paintMatches 只是往 `CSS.highlights` 写，Range 的
   * 创建在 findIn 里已经各自降级过了。这样单测能塞一个假注册表验证「写了什么、删了什么」。
   */
  function supportsHighlights() {
    try {
      if (typeof CSS === 'undefined' || !CSS || !CSS.highlights) return false;
      if (typeof CSS.highlights.set !== 'function') return false;
      if (typeof CSS.highlights.delete !== 'function') return false;
      return typeof Highlight === 'function';
    } catch (error) {
      return false;
    }
  }

  function rangesOf(match) {
    const ranges = match && match.ranges;
    return Array.isArray(ranges) ? ranges : [];
  }

  /**
   * 涂色：所有命中一个颜色，当前命中另一个颜色（CSS 里 `.dm-find-current` 更重）。
   *
   * 幂等 —— 两个注册项都是先删后建，重复调用不会累积。`currentIndex` 越界时按 0 处理，
   * 这样「命中数从 7 掉到 3、index 还停在 5」这种瞬时状态不会涂错。
   */
  function paintMatches(matches, currentIndex) {
    if (!supportsHighlights()) return false;
    const list = Array.isArray(matches) ? matches : [];

    const all = [];
    for (let index = 0; index < list.length; index += 1) {
      const ranges = rangesOf(list[index]);
      for (let slot = 0; slot < ranges.length; slot += 1) all.push(ranges[slot]);
    }

    let current = null;
    if (list.length) {
      let at = typeof currentIndex === 'number' && isFinite(currentIndex) ? Math.floor(currentIndex) : 0;
      if (at < 0 || at >= list.length) at = 0;
      current = rangesOf(list[at]);
    }

    try {
      if (all.length) CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...all));
      else CSS.highlights.delete(HIGHLIGHT_ALL);
    } catch (error) {
      /* 一个坏 Range 不该让整条搜索条失去反馈 */
    }
    try {
      if (current && current.length) CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(...current));
      else CSS.highlights.delete(HIGHLIGHT_CURRENT);
    } catch (error) {
      /* 同上 */
    }
    return true;
  }

  /** 关掉搜索条时把两处涂色都撤掉。 */
  function clearMatches() {
    if (!supportsHighlights()) return false;
    try {
      CSS.highlights.delete(HIGHLIGHT_ALL);
    } catch (error) {
      /* ignore */
    }
    try {
      CSS.highlights.delete(HIGHLIGHT_CURRENT);
    } catch (error) {
      /* ignore */
    }
    return true;
  }

  /* ── 滚到命中 ────────────────────────────────────────────────────────── */

  function elementOf(node) {
    if (!node) return null;
    if (node.nodeType === 1) return node;
    const parent = node.parentElement || node.parentNode;
    return parent && parent.nodeType === 1 ? parent : null;
  }

  function rectOf(range, element) {
    try {
      if (range && typeof range.getBoundingClientRect === 'function') {
        const rect = range.getBoundingClientRect();
        if (rect && (rect.height || rect.width || rect.top || rect.bottom)) return rect;
      }
    } catch (error) {
      /* 跨页 Range 有时会抛，退到元素矩形 */
    }
    try {
      if (element && typeof element.getBoundingClientRect === 'function') {
        return element.getBoundingClientRect();
      }
    } catch (error) {
      /* ignore */
    }
    return null;
  }

  /**
   * 读不到计算样式（单测、极老引擎）时按「高度够不够」判断，宁可多滚一次也不漏。
   */
  function overflowAllowsScroll(element) {
    let style = null;
    try {
      if (typeof window !== 'undefined' && window && typeof window.getComputedStyle === 'function') {
        style = window.getComputedStyle(element);
      } else if (typeof getComputedStyle === 'function') {
        style = getComputedStyle(element);
      }
    } catch (error) {
      style = null;
    }
    if (!style) return true;
    const overflow = String(style.overflowY || style.overflow || '');
    return !overflow || /(auto|scroll|overlay)/.test(overflow);
  }

  /** 从命中元素往上找第一个真能滚的祖先，最多找到 container 为止（不去滚整页）。 */
  function findScroller(element, container) {
    let current = element;
    while (current && current.nodeType === 1) {
      const canScroll = (current.scrollHeight || 0) > (current.clientHeight || 0) + 1;
      if (canScroll && overflowAllowsScroll(current)) return current;
      if (current === container) break;
      current = current.parentNode;
    }
    return null;
  }

  /**
   * 把命中滚进视野中间。已经落在「舒适区」里就不动 —— 否则连按「下一个」时页面会
   * 一直微微抖。
   */
  function scrollElementTo(scroller, rect) {
    const view =
      typeof scroller.getBoundingClientRect === 'function' ? scroller.getBoundingClientRect() : null;
    if (!view) return false;
    const height = scroller.clientHeight || view.height || 0;
    if (!height) return false;
    const margin = Math.min(SCROLL_MARGIN, Math.max(0, height / 3));
    const offsetTop = rect.top - view.top;
    const offsetBottom = rect.bottom - view.top;
    if (offsetTop >= margin && offsetBottom <= height - margin) return true;
    const next = Math.max(0, (scroller.scrollTop || 0) + offsetTop - margin);
    try {
      scroller.scrollTop = next;
    } catch (error) {
      return false;
    }
    return true;
  }

  /**
   * 把 container 滚到某个命中上。返回是否真的滚了。
   *
   * 优先自己算 scrollTop（只动阅读区那一栏）；找不到可滚祖先才退到 scrollIntoView ——
   * 那个会顺带滚整页，是最后手段。
   */
  function scrollToMatch(container, match) {
    const ranges = rangesOf(match);
    const range = ranges.length ? ranges[0] : null;
    const element = elementOf(range ? range.startContainer : match && match.node);
    if (!element) return false;

    const rect = rectOf(range, element);
    const scroller = findScroller(element, container);
    if (scroller && rect && scrollElementTo(scroller, rect)) return true;

    if (typeof element.scrollIntoView === 'function') {
      try {
        element.scrollIntoView({ block: 'center' });
        return true;
      } catch (error) {
        try {
          element.scrollIntoView();
          return true;
        } catch (nested) {
          return false;
        }
      }
    }
    return false;
  }

  /* ── 搜索条 ──────────────────────────────────────────────────────────── */

  /**
   * 浮在阅读区右上角的小搜索条。纯受控：输入框的值、命中数、当前下标全由 shell 给，
   * 这里只负责把按键变成回调，所以「搜索状态」只有一份，不存在两处不同步的问题。
   */
  function FindBar(props) {
    const p = props || {};
    const query = typeof p.query === 'string' ? p.query : '';
    const count = Math.max(0, Math.floor(Number(p.count) || 0));
    const rawIndex = Math.floor(Number(p.index) || 0);
    const index = count ? Math.min(Math.max(0, rawIndex), count - 1) : 0;
    const onQuery = typeof p.onQuery === 'function' ? p.onQuery : null;
    const onPrev = typeof p.onPrev === 'function' ? p.onPrev : null;
    const onNext = typeof p.onNext === 'function' ? p.onNext : null;
    const onClose = typeof p.onClose === 'function' ? p.onClose : null;

    const inputRef = useRef(null);

    // 打开就聚焦：Ctrl+F 之后用户只想直接打字，不该再点一下输入框。
    // 放在 effect 里而不是 autoFocus：搜索条常常是挂在一棵已经聚焦的子树里，
    // autoFocus 在那种情况下不一定抢得到焦点。
    useEffect(() => {
      const node = inputRef.current;
      if (!node || typeof node.focus !== 'function') return;
      try {
        node.focus();
        if (typeof node.select === 'function') node.select();
      } catch (error) {
        /* 聚焦失败不影响搜索 */
      }
    }, []);

    function handleChange(event) {
      if (!onQuery) return;
      onQuery(event && event.target ? event.target.value : '');
    }

    function handleKeyDown(event) {
      if (!event) return;
      const key = event.key;
      if (key === 'Enter') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (event.shiftKey) {
          if (onPrev) onPrev();
        } else if (onNext) {
          onNext();
        }
        return;
      }
      if (key === 'Escape' || key === 'Esc') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (onClose) onClose();
      }
    }

    // 按下按钮时别把焦点从输入框抢走：连按「下一个」不该打断正在敲的关键词。
    function keepFocus(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    }

    function button(modifier, label, icon, handler, disabled) {
      return h(
        'button',
        {
          type: 'button',
          className: cx('dm-find__btn', 'dm-find__btn--' + modifier),
          title: label,
          'aria-label': label,
          disabled: !!disabled,
          onMouseDown: keepFocus,
          onClick: handler,
        },
        h(Icon, { name: icon, size: 13 }),
      );
    }

    return h(
      'div',
      { className: 'dm-find', role: 'search', 'aria-label': '在文档里搜索' },
      h(
        'span',
        { className: 'dm-find__icon', 'aria-hidden': 'true' },
        h(Icon, { name: 'search', size: 13 }),
      ),
      h('input', {
        ref: inputRef,
        className: 'dm-find__input',
        type: 'text',
        value: query,
        placeholder: '在文档里搜索…',
        'aria-label': '在文档里搜索',
        spellCheck: false,
        autoComplete: 'off',
        onChange: handleChange,
        onKeyDown: handleKeyDown,
      }),
      h(
        'span',
        { className: 'dm-find__count', 'aria-live': 'polite' },
        count === 0 ? '无结果' : index + 1 + ' / ' + count,
      ),
      button('prev', '上一个（Shift+Enter）', 'left', () => {
        if (onPrev) onPrev();
      }, count === 0),
      button('next', '下一个（Enter）', 'right', () => {
        if (onNext) onNext();
      }, count === 0),
      button('close', '关闭（Esc）', 'close', () => {
        if (onClose) onClose();
      }, false),
    );
  }

  /* ── 样式 ────────────────────────────────────────────────────────────── */

  const css = `
/* ── in-document find (58-find.js) ───────────────────────────────────── */
::highlight(dm-find){background-color: rgba(255,196,0,.32);}
::highlight(dm-find-current){background-color: rgba(255,140,0,.55);}
.dm-find {
  position: absolute;
  /* 挂在 .dm-main 里，而 .dm-main 顶部还有 44px 的工具条：贴 8px 会盖住文档标题。 */
  top: 52px;
  right: 12px;
  z-index: 30;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 2px;
  width: min(320px, calc(100% - 24px));
  min-width: 0;
  height: 32px;
  padding: 0 4px 0 8px;
  border: 1px solid var(--dm-line);
  border-radius: 9px;
  background: var(--dm-bg);
  box-shadow: var(--dm-shadow);
  color: var(--dm-text);
}
.dm-find__icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dm-text-3);
}
.dm-find__input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dm-text);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.2;
  outline: none;
}
.dm-find__input::placeholder { color: var(--dm-text-3); }
.dm-find__input:focus-visible { box-shadow: inset 0 0 0 1px var(--dm-accent); }
.dm-find__count {
  flex: none;
  padding: 0 4px;
  color: var(--dm-text-3);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dm-find__btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dm-text-2);
  cursor: pointer;
}
.dm-find__btn:hover { background: var(--dm-bg-1); color: var(--dm-text); }
.dm-find__btn:focus-visible { outline: 2px solid var(--dm-accent); outline-offset: -2px; }
.dm-find__btn[disabled] { opacity: 0.35; cursor: default; }
.dm-find__btn[disabled]:hover { background: transparent; color: var(--dm-text-2); }
.dm-find__btn--close:hover { background: var(--dm-accent-soft); color: var(--dm-accent); }
`;

  /**
   * collectText / locate / searchText 不在 shell 的接线契约里，导出是为了让
   * `58-find.test.mjs` 能直接喂 `{ node, text }` 假数据 —— 不需要 jsdom。
   */
  return {
    FindBar: FindBar,
    findIn: findIn,
    paintMatches: paintMatches,
    clearMatches: clearMatches,
    scrollToMatch: scrollToMatch,
    css: css,
    collectText: collectText,
    locate: locate,
    searchText: searchText,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createFind };
