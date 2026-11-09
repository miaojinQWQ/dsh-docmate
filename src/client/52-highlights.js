/* ===== 52-highlights.js ===== */
/**
 * Persistent highlights for the reading surface — the DOM half.
 *
 * The Host owns the data (one JSON list per document, each entry carrying a character
 * anchor). This fragment turns a live DOM selection into that anchor, paints the stored
 * anchors, jumps back to one, and repaints when the viewer's DOM is rebuilt (document
 * switch, PDF lazy render, markdown re-render).
 *
 * Why the CSS Custom Highlight API instead of wrapping `<mark>` nodes:
 *   · the reading surface is React-owned — inserting wrapper nodes fights reconciliation,
 *     and the markdown/docx panes are re-rendered from scratch on every document switch;
 *   · PDF text layers are rebuilt page by page, so wrapper nodes would be lost anyway;
 *   · the API paints without touching the DOM, which is also why `watchHighlights` can
 *     never loop on our own repaint (see the note in that function).
 *
 * Degradation: `CSS.highlights` + `Highlight` exist in Chromium 105+, Safari 17.2+ and
 * Firefox 140+. Every exported function is a safe no-op (`null` / `false` / no paint) when
 * they are missing — the panel keeps working, it just does not colour anything.
 *
 * Exposed as `createHighlights(React, util) -> { COLORS, computeAnchor, applyHighlights,
 * scrollToHighlight, watchHighlights, css }`.
 */
function createHighlights(React, util) {
  /* The engine never renders; `React` is only part of the shared fragment signature. */

  const debounce =
    util && typeof util.debounce === 'function'
      ? util.debounce
      : function fallbackDebounce(fn, wait) {
          let timer = 0;
          function wrapped() {
            const args = arguments;
            const self = this;
            if (timer) clearTimeout(timer);
            timer = setTimeout(function () {
              timer = 0;
              fn.apply(self, args);
            }, wait);
          }
          wrapped.cancel = function () {
            if (timer) clearTimeout(timer);
            timer = 0;
          };
          return wrapped;
        };

  /* ── vocabulary ──────────────────────────────────────────────────────── */

  /** The three kinds of mark. `id` is the wire value; the UI mirrors this list. */
  const COLORS = [
    { id: 'key', label: '重点', hint: '关键结论、定义、要记住的句子' },
    { id: 'question', label: '疑问', hint: '没读懂、想追问 AI 的地方' },
    { id: 'review', label: '待复习', hint: '过几天要回来再看的内容' },
  ];

  /** Fixed order: clearing must never depend on the order items arrive in. */
  const COLOR_IDS = ['key', 'question', 'review'];

  const HIGHLIGHT_PREFIX = 'dm-hl-';

  function highlightName(color) {
    return HIGHLIGHT_PREFIX + color;
  }

  const SCROLL_MARGIN = 120;

  /* ── feature detection ───────────────────────────────────────────────── */

  /**
   * True only when the whole trio is usable. Checked on every call (cheap) instead of
   * cached at factory time so a polyfill loaded later still gets picked up.
   */
  function supportsHighlights() {
    try {
      if (typeof CSS === 'undefined' || !CSS || !CSS.highlights) return false;
      if (typeof CSS.highlights.set !== 'function') return false;
      if (typeof CSS.highlights.delete !== 'function') return false;
      if (typeof Highlight !== 'function') return false;
      return typeof document !== 'undefined';
    } catch (error) {
      return false;
    }
  }

  function createRange() {
    try {
      if (typeof document !== 'undefined' && document && typeof document.createRange === 'function') {
        return document.createRange();
      }
      if (typeof Range === 'function') return new Range();
    } catch (error) {
      /* fall through */
    }
    return null;
  }

  /* ── text-node bookkeeping ───────────────────────────────────────────── */

  /**
   * Every text node under `root`, in document order.
   *
   * `document.createTreeWalker` is the fast path; the manual recursion is a fallback for
   * environments that do not implement it (and keeps the pure functions testable with a
   * tiny fake DOM).
   */
  function textNodesOf(root) {
    const nodes = [];
    if (!root) return nodes;
    try {
      if (typeof document !== 'undefined' && document && typeof document.createTreeWalker === 'function') {
        const showText = typeof NodeFilter !== 'undefined' && NodeFilter ? NodeFilter.SHOW_TEXT : 4;
        const walker = document.createTreeWalker(root, showText, null);
        let node = walker.nextNode();
        while (node) {
          if (node.nodeType === 3) nodes.push(node);
          node = walker.nextNode();
        }
        return nodes;
      }
    } catch (error) {
      /* fall back to the manual walk */
    }
    (function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        nodes.push(node);
        return;
      }
      const children = node.childNodes;
      if (!children) return;
      for (let index = 0; index < children.length; index += 1) walk(children[index]);
    })(root);
    return nodes;
  }

  function childIndex(parent, child) {
    const children = parent && parent.childNodes;
    if (!children) return -1;
    for (let index = 0; index < children.length; index += 1) {
      if (children[index] === child) return index;
    }
    return -1;
  }

  /** Child-index path from `root` down to `node`; `null` when `node` is not inside. */
  function pathTo(root, node) {
    if (!root || !node) return null;
    const path = [];
    let current = node;
    while (current && current !== root) {
      const parent = current.parentNode;
      if (!parent) return null;
      const index = childIndex(parent, current);
      if (index < 0) return null;
      path.unshift(index);
      current = parent;
    }
    return current === root ? path : null;
  }

  function comparePath(a, b) {
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    }
    if (a.length === b.length) return 0;
    return a.length < b.length ? -1 : 1;
  }

  function isPrefix(prefix, path) {
    if (prefix.length > path.length) return false;
    for (let index = 0; index < prefix.length; index += 1) {
      if (prefix[index] !== path[index]) return false;
    }
    return true;
  }

  /**
   * Character offset of a DOM boundary point `(boundaryNode, boundaryOffset)` measured in
   * the concatenated `textContent` of `root`. Returns -1 when the boundary is outside root.
   *
   * A boundary node can be a text node (offset = character index inside it) or an element
   * (offset = child index, i.e. the caret sits *before* `childNodes[boundaryOffset]`); both
   * shapes occur in real selections (a selection that starts at the very beginning of a
   * paragraph usually has the paragraph element as `startContainer`).
   */
  function offsetOf(root, boundaryNode, boundaryOffset) {
    if (!root || !boundaryNode) return -1;
    const boundaryPath = pathTo(root, boundaryNode);
    if (!boundaryPath) return -1;
    const boundaryIsText = boundaryNode.nodeType === 3;
    const nodes = textNodesOf(root);
    let total = 0;
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const length = (node.nodeValue || '').length;
      const path = pathTo(root, node);
      if (!path) continue;

      if (!boundaryIsText && isPrefix(boundaryPath, path)) {
        // The boundary is an element that contains this text node: compare the child of
        // the boundary element that leads to the text node against the child offset.
        const branch = path[boundaryPath.length];
        if (branch < boundaryOffset) {
          total += length;
          continue;
        }
        return total;
      }

      const order = comparePath(path, boundaryPath);
      if (order < 0) {
        total += length;
        continue;
      }
      if (order > 0) return total;
      // Same node as the boundary.
      const local = Math.max(0, Math.min(boundaryOffset, length));
      return total + local;
    }
    // The boundary sits after every text node (e.g. an element boundary at the very end).
    return total;
  }

  /** Concatenated text offset table for one root; built once per `applyHighlights` call. */
  function buildIndex(root) {
    const nodes = textNodesOf(root);
    const offsets = new Array(nodes.length);
    let total = 0;
    for (let index = 0; index < nodes.length; index += 1) {
      offsets[index] = total;
      total += (nodes[index].nodeValue || '').length;
    }
    return { root: root, nodes: nodes, offsets: offsets, total: total };
  }

  /**
   * One Range per text node overlapping `[start, end)`.
   *
   * A single Range could span several text nodes, but per-node ranges are what the
   * Highlight API paints most predictably across block boundaries (and PDF text layers,
   * where every span is its own text node), so one item may legitimately produce several
   * ranges — all of them go into the same `Highlight`.
   */
  function rangesForSpan(index, start, end) {
    const ranges = [];
    if (!index || !index.nodes.length) return ranges;
    const from = Math.max(0, Math.min(start, index.total));
    const to = Math.max(0, Math.min(end, index.total));
    if (!(to > from)) return ranges;
    for (let position = 0; position < index.nodes.length; position += 1) {
      const node = index.nodes[position];
      const value = node.nodeValue || '';
      const nodeStart = index.offsets[position];
      const nodeEnd = nodeStart + value.length;
      if (nodeEnd <= from) continue;
      if (nodeStart >= to) break;
      const localStart = Math.max(0, from - nodeStart);
      const localEnd = Math.min(value.length, to - nodeStart);
      if (localEnd <= localStart) continue;
      const range = createRange();
      if (!range) return ranges;
      try {
        range.setStart(node, localStart);
        range.setEnd(node, localEnd);
        ranges.push(range);
      } catch (error) {
        /* one unbuildable segment must not drop the rest */
      }
    }
    return ranges;
  }

  /* ── anchor resolution ───────────────────────────────────────────────── */

  function closestPage(node, container) {
    let current = node;
    while (current && current !== container) {
      if (current.nodeType === 1 && typeof current.getAttribute === 'function') {
        const value = current.getAttribute('data-page');
        if (value !== null && value !== undefined && value !== '') return current;
      }
      current = current.parentNode;
    }
    return null;
  }

  /**
   * The element whose `textContent` the anchor offsets are measured against.
   * `null` means "cannot resolve right now" — a page-scope anchor whose page has not been
   * rendered yet (PDF lazy rendering) is skipped, not guessed.
   */
  function resolveRoot(container, anchor) {
    if (!container || !anchor) return null;
    if (anchor.scope === 'page') {
      const page = Number(anchor.page);
      if (!isFinite(page) || page < 1) return null;
      if (typeof container.querySelector !== 'function') return null;
      let element = null;
      try {
        element = container.querySelector('[data-page="' + page + '"]');
      } catch (error) {
        element = null;
      }
      return element || null;
    }
    if (anchor.scope === 'doc' || anchor.scope === undefined || anchor.scope === null) return container;
    return null;
  }

  function anchorSpan(anchor) {
    if (!anchor) return null;
    const start = Number(anchor.start);
    const end = Number(anchor.end);
    if (!isFinite(start) || !isFinite(end) || end <= start) return null;
    return { start: start, end: end };
  }

  /* ── 1. selection → anchor ───────────────────────────────────────────── */

  /**
   * Turn the current DOM selection range into a storable anchor.
   *
   * `scope: 'page'` when the range lives inside a `[data-page]` element (PDF — offsets are
   * relative to that page because pages render lazily and whole-document offsets shift);
   * `scope: 'doc'` otherwise (md / txt / docx — offsets are relative to the viewer
   * container, i.e. `[data-dm-viewer]`).
   *
   * Returns `null` for collapsed ranges, ranges outside the container, and anything that
   * cannot be measured — the caller simply does not offer to save such a selection.
   */
  function computeAnchor(container, range) {
    if (!container || !range) return null;
    try {
      const startNode = range.startContainer;
      const endNode = range.endContainer;
      if (!startNode || !endNode) return null;

      // Scope is decided by the *common ancestor*, exactly like the Host expects: a
      // selection that starts on page 1 and ends on page 2 has no single page root, so it
      // falls back to doc scope (the shell should reject such a selection for PDFs).
      const common = range.commonAncestorContainer || startNode;
      const pageElement = closestPage(common, container);
      const scope = pageElement ? 'page' : 'doc';
      const root = pageElement || container;

      let page = null;
      if (pageElement) {
        const raw = typeof pageElement.getAttribute === 'function' ? pageElement.getAttribute('data-page') : null;
        page = Number(raw);
        if (!isFinite(page) || page < 1) return null;
      }

      const start = offsetOf(root, startNode, range.startOffset);
      const end = offsetOf(root, endNode, range.endOffset);
      if (start < 0 || end < 0) return null;
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      if (from === to) return null;
      return { scope: scope, page: page, start: from, end: to };
    } catch (error) {
      return null;
    }
  }

  /* ── 2. painting ─────────────────────────────────────────────────────── */

  function clearHighlights() {
    if (!supportsHighlights()) return;
    for (let index = 0; index < COLOR_IDS.length; index += 1) {
      try {
        CSS.highlights.delete(highlightName(COLOR_IDS[index]));
      } catch (error) {
        /* ignore */
      }
    }
  }

  /**
   * Repaint every highlight for one viewer container. Idempotent: the three registry
   * entries are deleted and rebuilt from scratch, so calling it twice is harmless.
   *
   * One `Highlight` object per colour; every range that belongs to that colour goes into
   * it. A malformed item (missing anchor, unknown colour, page not rendered yet) is
   * skipped without affecting the others.
   */
  function applyHighlights(container, items) {
    if (!supportsHighlights()) return;
    clearHighlights();
    if (!container) return;

    const list = Array.isArray(items) ? items : [];
    const buckets = { key: [], question: [], review: [] };
    const indexes = new Map();

    function indexFor(root) {
      let index = indexes.get(root);
      if (!index) {
        index = buildIndex(root);
        indexes.set(root, index);
      }
      return index;
    }

    for (let position = 0; position < list.length; position += 1) {
      const item = list[position];
      try {
        if (!item || !item.anchor) continue;
        const color = String(item.color || '');
        if (!Object.prototype.hasOwnProperty.call(buckets, color)) continue;
        const span = anchorSpan(item.anchor);
        if (!span) continue;
        const root = resolveRoot(container, item.anchor);
        if (!root) continue;
        const ranges = rangesForSpan(indexFor(root), span.start, span.end);
        for (let index = 0; index < ranges.length; index += 1) {
          buckets[color].push(ranges[index]);
        }
      } catch (error) {
        /* a single broken highlight never hides the others */
      }
    }

    for (let index = 0; index < COLOR_IDS.length; index += 1) {
      const color = COLOR_IDS[index];
      const ranges = buckets[color];
      if (!ranges.length) continue;
      try {
        CSS.highlights.set(highlightName(color), new Highlight(...ranges));
      } catch (error) {
        /* ignore — the rest of the colours still paint */
      }
    }
  }

  /* ── 3. jump back to one anchor ──────────────────────────────────────── */

  function styleOf(element) {
    try {
      if (typeof window !== 'undefined' && window && typeof window.getComputedStyle === 'function') {
        return window.getComputedStyle(element);
      }
      if (typeof getComputedStyle === 'function') return getComputedStyle(element);
    } catch (error) {
      /* ignore */
    }
    return null;
  }

  /**
   * An element that can actually scroll its overflow. `overflow` is checked when the
   * cascade is readable; when it is not (tests, very old engines) the `scrollHeight >
   * clientHeight` heuristic is used instead.
   */
  function isScrollable(element) {
    if (!element || element.nodeType !== 1) return false;
    const style = styleOf(element);
    if (style) {
      const overflow = String(style.overflowY || style.overflow || '');
      if (overflow && !/(auto|scroll|overlay)/.test(overflow)) return false;
    }
    return (element.scrollHeight || 0) > (element.clientHeight || 0) + 1;
  }

  function findScroller(node) {
    let current = node;
    while (current && current.nodeType === 1) {
      if (isScrollable(current)) return current;
      current = current.parentNode;
    }
    return null;
  }

  function scrollElementTo(scroller, rect) {
    const view =
      typeof scroller.getBoundingClientRect === 'function'
        ? scroller.getBoundingClientRect()
        : null;
    if (!view) return;
    const height = scroller.clientHeight || view.height || 0;
    if (!height) return;
    const margin = Math.min(SCROLL_MARGIN, Math.max(0, height / 3));
    const offsetTop = rect.top - view.top;
    const offsetBottom = rect.bottom - view.top;
    // Already comfortably inside the viewport: leave the scroll position alone.
    if (offsetTop >= margin && offsetBottom <= height - margin) return;
    const next = Math.max(0, (scroller.scrollTop || 0) + offsetTop - margin);
    try {
      scroller.scrollTop = next;
    } catch (error) {
      /* ignore */
    }
  }

  /**
   * Scroll the viewer so the stored anchor is visible (~120px of breathing room above it).
   * Returns `false` when the anchor cannot be resolved right now — most importantly when a
   * PDF page is still a placeholder and its text layer has not been rendered.
   */
  function scrollToHighlight(container, item) {
    if (!container || !item || !item.anchor) return false;
    try {
      const span = anchorSpan(item.anchor);
      if (!span) return false;
      const root = resolveRoot(container, item.anchor);
      if (!root) return false;
      const ranges = rangesForSpan(buildIndex(root), span.start, span.end);
      if (!ranges.length) return false;
      const range = ranges[0];
      if (typeof range.getBoundingClientRect !== 'function') return false;
      const rect = range.getBoundingClientRect();
      if (!rect || (!(rect.height > 0) && !(rect.width > 0))) return false;

      // The scroller can be an ancestor of the anchor root (markdown: the viewer itself)
      // or a descendant of the container (PDF: `.dm-pdf-pagebox` sits below the viewer).
      const scroller = findScroller(root) || findScroller(container);
      if (scroller) {
        scrollElementTo(scroller, rect);
        return true;
      }
      // Last resort: no scrollable box found (detached test DOM, exotic layout) — let the
      // browser bring the first node into view if it can.
      const node = range.startContainer;
      const element = node && (node.nodeType === 1 ? node : node.parentElement);
      if (element && typeof element.scrollIntoView === 'function') {
        try {
          element.scrollIntoView({ block: 'center' });
        } catch (error) {
          /* ignore */
        }
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  /* ── 4. repaint when the viewer DOM changes ──────────────────────────── */

  /**
   * Watch the viewer for DOM replacement (document switch, PDF page text layers appearing,
   * markdown re-render) and re-apply the current items after a 120ms debounce.
   *
   * No feedback loop: `applyHighlights` only writes to `CSS.highlights` and never touches
   * the DOM, so a repaint cannot trigger this observer. It is the *React* tree that
   * mutates, and that is exactly what we want to catch.
   *
   * Returns a dispose function (disconnects the observer and cancels the pending timer).
   * The caller still owns the initial and items-changed repaint: this watcher only reacts
   * to DOM changes, not to React state changes.
   */
  function watchHighlights(container, getItems) {
    if (!container || typeof MutationObserver !== 'function') {
      return function dispose() {};
    }
    let disposed = false;

    const reapply = debounce(function () {
      if (disposed) return;
      let items = [];
      try {
        items = typeof getItems === 'function' ? getItems() : [];
      } catch (error) {
        items = [];
      }
      applyHighlights(container, items);
    }, 120);

    let observer = null;
    try {
      observer = new MutationObserver(function () {
        if (!disposed) reapply();
      });
      observer.observe(container, { childList: true, subtree: true, characterData: true });
    } catch (error) {
      return function dispose() {};
    }

    return function dispose() {
      disposed = true;
      if (reapply && typeof reapply.cancel === 'function') reapply.cancel();
      try {
        observer.disconnect();
      } catch (error) {
        /* ignore */
      }
    };
  }

  /* ── stylesheet ──────────────────────────────────────────────────────── */

  /**
   * Painted through `::highlight()`. Only the background is tinted — never the text
   * colour, because the reading surface owns its own typography and the host theme can be
   * either light or dark. The alpha values are deliberately decoration-level.
   */
  const css = `
/* ── persistent highlights (52-highlights.js) ──────────────────────────── */
::highlight(dm-hl-key) { background-color: rgba(240, 178, 0, 0.36); }
::highlight(dm-hl-question) { background-color: rgba(58, 134, 255, 0.30); }
::highlight(dm-hl-review) { background-color: rgba(52, 168, 108, 0.30); }
`;

  return {
    COLORS: COLORS,
    computeAnchor: computeAnchor,
    applyHighlights: applyHighlights,
    scrollToHighlight: scrollToHighlight,
    watchHighlights: watchHighlights,
    css: css,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createHighlights };
