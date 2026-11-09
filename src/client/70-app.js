/* ===== 70-app.js ===== */
/**
 * The research desk: three columns, one conversation per document, and the selection bridge.
 *
 *   left   研究区 — the documents dragged in, this document's research memory, and its marks
 *   centre the reading surface (one pane, or two side by side for comparison)
 *   right  the companion conversation for the *active* document
 *
 * Every document owns exactly one Harness Session. Opening a document ensures that session
 * exists and, the first time, pushes the whole text + memory + marks into it — so the agent
 * starts out having read the document rather than waiting to be fed a selection.
 *
 * Marks are anchored as character offsets into the rendered text and drawn with the CSS
 * Custom Highlight API, so they never touch React's DOM and survive a reload.
 */
function createApp(React, util, docsModule, chatModule, workspaceModule, pdfModule, highlightsModule, highlightsUiModule, findModule, shotModule, panesModule) {
  const h = React.createElement;
  const { useState, useEffect, useRef, useCallback } = React;
  const { cx, Icon, api, clamp, oneLine, extOf, formatBytes, makeBoundary, hashText, lsGet, lsSet } = util;

  const { DocBody } = docsModule;
  const { ChatPanel } = chatModule;
  const { DocList, MemoryPanel, DropOverlay } = workspaceModule;

  const HighlightList = highlightsUiModule && highlightsUiModule.HighlightList ? highlightsUiModule.HighlightList : null;
  const FindBar = findModule && findModule.FindBar ? findModule.FindBar : null;
  const findIn = findModule ? findModule.findIn : () => ({ matches: [], truncated: false });
  const paintMatches = findModule ? findModule.paintMatches : () => false;
  const clearMatches = findModule ? findModule.clearMatches : () => {};
  const scrollToMatch = findModule ? findModule.scrollToMatch : () => false;
  const captureRegion = shotModule && typeof shotModule.captureRegion === 'function' ? shotModule.captureRegion : null;
  // 三栏宽度：12-panes.js 不在时退化成「固定宽度、没有分隔条」，面板本身照常可用。
  const PaneHandle = panesModule && panesModule.PaneHandle ? panesModule.PaneHandle : null;
  const PANE_DEFAULTS = panesModule && panesModule.DEFAULTS ? panesModule.DEFAULTS : { left: 236, right: 348 };
  const PANE_LIMITS =
    panesModule && panesModule.LIMITS
      ? panesModule.LIMITS
      : { left: { min: 176, max: 520 }, right: { min: 268, max: 640 }, centre: 380, handle: 6, step: 16 };
  const resolveSizes =
    panesModule && typeof panesModule.resolveSizes === 'function'
      ? panesModule.resolveSizes
      : function fallbackResolveSizes(panelWidth, wantLeft, wantRight) {
          return { left: wantLeft, right: wantRight };
        };
  const readSizes =
    panesModule && typeof panesModule.readSizes === 'function'
      ? panesModule.readSizes
      : function fallbackReadSizes() {
          return { left: PANE_DEFAULTS.left, right: PANE_DEFAULTS.right };
        };
  const writeSizes =
    panesModule && typeof panesModule.writeSizes === 'function'
      ? panesModule.writeSizes
      : function fallbackWriteSizes() {
          return null;
        };
  const COLORS = highlightsModule && highlightsModule.COLORS ? highlightsModule.COLORS : [];
  const computeAnchor = highlightsModule ? highlightsModule.computeAnchor : () => null;
  const applyHighlights = highlightsModule ? highlightsModule.applyHighlights : () => {};
  const scrollToHighlight = highlightsModule ? highlightsModule.scrollToHighlight : () => false;

  // One fence per column: a crash in the PDF viewer must not take the chat down with it.
  const LeftBoundary = makeBoundary('研究区');
  const CentreBoundary = makeBoundary('阅读区');
  const RightBoundary = makeBoundary('伴随 AI');

  const ACCEPTED = ['md', 'markdown', 'txt', 'docx', 'pdf', 'json', 'csv', 'tsv', 'yaml', 'yml', 'html', 'htm'];

  /* 一键解读。问句刻意短：用户要的是「快速回馈」，一句「逐句解释」就能让模型写一整页，
     那不是学习节奏。长文只在用户自己说「展开」时才要。 */
  const QUICK_ACTIONS = [
    {
      id: 'explain',
      label: '解释',
      icon: 'spark',
      question: '这段在讲什么？先一句话结论，再列要点，150 字以内。',
    },
    {
      id: 'summarize',
      label: '总结',
      icon: 'doc',
      question: '三句话总结这段，再说它在全篇里起什么作用。',
    },
    {
      id: 'translate',
      label: '翻译',
      icon: 'quote',
      question: '译成中文（原文是中文就译成英文），只给译文。',
    },
    {
      id: 'ask',
      label: '追问…',
      icon: 'send',
      question: null,
    },
  ];

  const WHOLE_DOC_QUESTION = '通读全文：3 句话概括它讲什么，再列核心结构（分几部分、各自解决什么）。';

  const DISTILL_QUESTION =
    '回顾我们的对话，把值得长期记住的（关键定义、你确认过的判断、未解决的问题）用 docmate_memory 追加进研究记忆，最多 6 条，每条一句话。';

  const COLOR_LABEL = {};
  for (const color of COLORS) COLOR_LABEL[color.id] = color.label;

  function buildMessage(quote, question, viewport) {
    const lines = [];
    const where = quote.page ? '（第 ' + quote.page + ' 页）' : '';
    lines.push('我在文档《' + (quote.docName || '未命名') + '》里选中了下面这段内容' + where + '：');
    lines.push('');
    lines.push(
      quote.text
        .split('\n')
        .map((line) => '> ' + line)
        .join('\n'),
    );
    lines.push('');
    if (viewport && viewport.excerpt) {
      lines.push(
        '【我此刻正看着】' + (viewport.heading ? viewport.heading + ' · ' : '') + oneLine(viewport.excerpt, 180),
      );
      lines.push('');
    }
    lines.push(question);
    return lines.join('\n');
  }

  /* 框选截图能做什么：扫描件没有文字层，划不了词，只能让它看图。
   * 问句刻意写得收敛——模型看到一张「缺图」的题很容易自作主张去画图、建文件，
   * 实测一次能烧掉 80 万 token。真正的刹车在 Host 半（快速识图轮次会限步、限 token、
   * 拒工具），这里只负责把「回答多长」说清楚：默认 150 字，别写讲义。 */
  const SHOT_ACTIONS = [
    {
      id: 'explain',
      label: '解释这张图',
      question: '这块在讲什么？先一句话结论，再列要点，150 字以内。',
    },
    {
      id: 'transcribe',
      label: '提取文字',
      question: '把框里的文字转录出来（公式用 LaTeX，表格保留结构），只给转录。',
    },
    {
      id: 'ask',
      label: '追问…',
      question: null,
    },
  ];

  /* 每条框选消息都带这三句。别指望模型自觉：它是真的会去画图、建文件、跑脚本。
   * 试过再加一句「截图就在附件里，不用工具去读」，反而把模型的注意力引到
   * 「附件到底怎么给我的」上，白白烧掉一整步的输出预算，所以撤了。 */
  const SHOT_RULES = '只依据截图回答；缺什么直接说缺什么，别补画、别建文件、别跑代码。';

  function buildShotMessage(doc, shot, question, viewport) {
    const lines = [];
    const where = shot && shot.page ? '（第 ' + shot.page + ' 页）' : '';
    lines.push('我在文档《' + (doc ? doc.name : '未命名') + '》里框选了下面这块区域' + where + '，截图见附件。');
    if (viewport && viewport.excerpt) {
      lines.push(
        '【我此刻正看着】' + (viewport.heading ? viewport.heading + ' · ' : '') + oneLine(viewport.excerpt, 180),
      );
    }
    lines.push('');
    lines.push(question);
    lines.push('');
    lines.push(SHOT_RULES);
    return lines.join('\n');
  }

  /* ── the panel ───────────────────────────────────────────────────────── */

  /**
   * Markdown 从渲染好的阅读区扫出标题；PDF 使用阅读器解析好的大纲与页码。
   * 层级做一次归一化——只有 h2/h3 的文档，最浅的一级顶格显示。
   */
  function scanOutline(viewer, pdfItems) {
    if (!viewer || typeof viewer.querySelectorAll !== 'function') return null;
    if (typeof viewer.querySelector === 'function' && viewer.querySelector('.dm-pdf-root')) {
      if (!Array.isArray(pdfItems) || !pdfItems.length) return null;
      return pdfItems.map((item) => ({ text: item.text, depth: item.depth, page: item.page }));
    }
    const nodes = Array.prototype.slice.call(viewer.querySelectorAll('h1,h2,h3,h4,h5,h6'));
    const items = [];
    for (const node of nodes) {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      items.push({ node, text, level: Number(String(node.tagName).slice(1)) || 1 });
    }
    if (!items.length) return null;
    const shallowest = items.reduce((acc, item) => Math.min(acc, item.level), 6);
    return items.map((item) => ({ node: item.node, text: item.text, depth: item.level - shallowest }));
  }

  /** 浮在正文上的目录。滚动时高亮当前小节，点一行平滑滚过去。 */
  function DocOutline(props) {
    const items = props.items || [];
    const viewer = props.viewer;
    const [active, setActive] = useState(-1);

    useEffect(() => {
      if (!viewer) return undefined;
      const pdf = items.some((item) => item.page);
      const scroller = pdf && typeof viewer.querySelector === 'function' ? viewer.querySelector('.dm-pdf-scroll') || viewer : viewer;
      let frame = 0;
      function measure() {
        frame = 0;
        const line = scroller.getBoundingClientRect().top + 88;
        let index = -1;
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          const target = item.page ? scroller.querySelector('.dm-pdf-page[data-page="' + item.page + '"]') : item.node;
          if (target && target.getBoundingClientRect().top <= line) index = i;
        }
        setActive(index);
      }
      function onScroll() {
        if (frame) return;
        frame = window.requestAnimationFrame(measure);
      }
      measure();
      scroller.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        scroller.removeEventListener('scroll', onScroll);
        if (frame) window.cancelAnimationFrame(frame);
      };
    }, [viewer, items]);

    return h(
      'div',
      { className: 'dm-outline', role: 'navigation', 'aria-label': '文档目录' },
      h(
        'div',
        { className: 'dm-outline__head' },
        h('span', { className: 'dm-outline__title' }, '目录'),
        h('span', { className: 'dm-outline__count' }, items.length + ' 节'),
        h(
          'button',
          { type: 'button', className: 'dm-outline__close', title: '收起目录', onClick: props.onClose },
          h(Icon, { name: 'close', size: 13 }),
        ),
      ),
      h(
        'div',
        { className: 'dm-outline__list dm-scroll' },
        items.map((item, index) =>
          h(
            'button',
            {
              key: index,
              type: 'button',
              className: cx('dm-outline__row', index === active && 'is-active'),
              style: { paddingLeft: 10 + item.depth * 12 + 'px' },
              title: item.text,
              onClick: () => {
                setActive(index);
                props.onPick(item);
              },
            },
            h('span', { className: 'dm-outline__text' }, item.text),
          ),
        ),
      ),
    );
  }

  function DocMateApp(props) {
    const hostKit = { SessionProvider: props.SessionProvider, renderFactorySlot: props.renderFactorySlot };

    const [docs, setDocs] = useState([]);
    const [docsState, setDocsState] = useState({ phase: 'loading', error: null });
    const [activeId, setActiveId] = useState(null);
    const [compareId, setCompareId] = useState(null);
    const [sessionId, setSessionId] = useState(null);
    const [sessionError, setSessionError] = useState(null);
    const [memory, setMemory] = useState('');
    const [memoryState, setMemoryState] = useState({ phase: 'idle', error: null });
    const [memoryTick, setMemoryTick] = useState(0);
    const [highlights, setHighlights] = useState([]);
    const [highlightsState, setHighlightsState] = useState({ phase: 'idle', error: null });
    const [activeHighlight, setActiveHighlight] = useState(null);
    const [hlMenu, setHlMenu] = useState(false);
    const [moreOpen, setMoreOpen] = useState(false);
    const [chatStarted, setChatStarted] = useState(false);
    const [findOpen, setFindOpen] = useState(false);
    const [findQuery, setFindQuery] = useState('');
    const [findResult, setFindResult] = useState({ matches: [], truncated: false });
    const [findIndex, setFindIndex] = useState(0);
    // 全文注入上限由 Host 给（INLINE_TEXT_LIMIT），面板据此如实说明注入了多少。
    const [inlineLimit, setInlineLimit] = useState(24000);
    const [outline, setOutline] = useState(null);
    const [outlineViewer, setOutlineViewer] = useState(null);
    const [pdfOutlines, setPdfOutlines] = useState({});
    const [pending, setPending] = useState(null);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState(null);
    const [selBar, setSelBar] = useState(null);
    // 框选截图：模式开关 / 正在拖的矩形 / 抓到的那张图
    const [shotMode, setShotMode] = useState(false);
    const [shotDrag, setShotDrag] = useState(null);
    const [shotCard, setShotCard] = useState(null);
    const [shotBusy, setShotBusy] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [uploading, setUploading] = useState(0);
    const [pageJump, setPageJump] = useState(null);
    const [showSide, setShowSide] = useState(() => {
      const stored = util.lsGet('docmate.panes', null);
      if (stored && stored.manual && typeof stored.side === 'boolean') {
        if (stored.side === false) sideOffRef.current = true;
        return stored.side;
      }
      return true;
    });
    const [showChat, setShowChat] = useState(() => {
      const stored = util.lsGet('docmate.panes', null);
      if (stored && stored.manual && typeof stored.chat === 'boolean') return stored.chat;
      return true;
    });
    // 三栏宽度分两层：paneSizes 是「用户想要的宽度」（拖动 / 键盘改它、并落进
    // docmate.panes），真正渲染的宽度由 resolveSizes 按当前面板宽度算 —— 它负责
    // 「中间阅读区至少 380」「窗口变窄先收右栏」这些 flex 自己不会做的约束。
    const [panelWidth, setPanelWidth] = useState(0);
    const [paneSizes, setPaneSizes] = useState(() => readSizes(util.lsGet));
    // 正在拖哪一条分隔条（'left' / 'right' / null）。用来给 .dm-root 挂 is-resizing。
    const [resizing, setResizing] = useState(null);

    const rootRef = useRef(null);
    const fileRef = useRef(null);
    const selBarRef = useRef(null);
    /** 框选模式下拖拽是画框，选区桥要让路（effect 里读它，避免重新绑定监听）。 */
    const shotModeRef = useRef(false);
    /** True once the user explicitly folds the research rail; a resize then keeps it folded. */
    const sideOffRef = useRef(false);
    /** 当前想要的宽度。拖拽回调里要读最新值，不能靠闭包里的 paneSizes。 */
    const paneSizesRef = useRef(paneSizes);
    const notifyRef = useRef(null);
    const highlightsRef = useRef([]);
    const viewportRef = useRef(null);
    const askCountRef = useRef(0);

    const notify = useCallback((message) => {
      setToast(message);
      window.setTimeout(() => setToast((current) => (current === message ? null : current)), 4200);
    }, []);
    notifyRef.current = notify;
    highlightsRef.current = highlights;

    const activeDoc = docs.find((doc) => doc.id === activeId) || null;

    /* ── the document list ─────────────────────────────────────────────── */

    const loadDocs = useCallback(async () => {
      setDocsState({ phase: 'loading', error: null });
      try {
        const payload = await api('/docs');
        const list = Array.isArray(payload.docs) ? payload.docs : [];
        setDocs(list);
        if (Number(payload.inlineLimit) > 0) setInlineLimit(Number(payload.inlineLimit));
        setDocsState({ phase: 'ready', error: null });
        setActiveId((current) => (current && list.some((doc) => doc.id === current) ? current : list[0] ? list[0].id : null));
      } catch (error) {
        setDocsState({ phase: 'error', error: String((error && error.message) || error) });
      }
    }, []);

    useEffect(() => {
      loadDocs();
    }, [loadDocs]);

    /* ── ingestion ─────────────────────────────────────────────────────── */

    const ingestPdf = useCallback(
      async (doc) => {
        const extract = pdfModule && typeof pdfModule.extractText === 'function' ? pdfModule.extractText : null;
        if (!extract) {
          notify('PDF 阅读器没加载，这篇暂时只能看，不能同步全文');
          return doc;
        }
        try {
          const result = await extract(API + '/doc/raw?id=' + encodeURIComponent(doc.id));
          if (!result || !result.text) return doc;
          await api('/doc/text?id=' + encodeURIComponent(doc.id), { method: 'POST', body: { text: result.text } });
          return { ...doc, chars: result.text.length, hasText: true };
        } catch (error) {
          notify('PDF 全文抽取失败（' + String((error && error.message) || error) + '）：这篇只能靠划词提问');
          return doc;
        }
      },
      [notify],
    );

    const uploadFiles = useCallback(
      async (fileList) => {
        const files = Array.from(fileList || []);
        for (const file of files) {
          const ext = extOf(file.name);
          if (ACCEPTED.indexOf(ext) < 0) {
            notify('不支持 .' + ext + '（支持 ' + ACCEPTED.join(' / ') + '）');
            continue;
          }
          setUploading((count) => count + 1);
          try {
            const response = await fetch(API + '/docs?name=' + encodeURIComponent(file.name), {
              method: 'POST',
              body: file,
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || !payload || payload.ok !== true) {
              throw new Error((payload && payload.error && payload.error.message) || 'HTTP ' + response.status);
            }
            let doc = payload.doc;
            if (doc.ext === 'pdf') doc = await ingestPdf(doc);
            setDocs((previous) => [doc, ...previous.filter((entry) => entry.id !== doc.id)]);
            setActiveId(doc.id);
            setCompareId(null);
            notify('已加入研究区：' + doc.name + (doc.hasText ? '（已同步 ' + doc.chars + ' 字）' : ''));
          } catch (error) {
            notify('加入失败：' + String((error && error.message) || error));
          } finally {
            setUploading((count) => Math.max(0, count - 1));
          }
        }
      },
      [ingestPdf, notify],
    );

    const removeDoc = useCallback(
      async (id) => {
        try {
          await api('/docs?id=' + encodeURIComponent(id), { method: 'DELETE' });
          setDocs((previous) => previous.filter((doc) => doc.id !== id));
          setCompareId((current) => (current === id ? null : current));
          setActiveId((current) => (current === id ? null : current));
          notify('已从研究区移除');
        } catch (error) {
          notify('移除失败：' + String((error && error.message) || error));
        }
      },
      [notify],
    );

    /* ── per-document session + memory + marks ─────────────────────────── */

    useEffect(() => {
      if (!activeId) {
        setSessionId(null);
        setSessionError(null);
        setMemory('');
        setMemoryState({ phase: 'idle', error: null });
        setHighlights([]);
        setHighlightsState({ phase: 'idle', error: null });
        return undefined;
      }
      let cancelled = false;
      setSessionError(null);
      setMemoryState({ phase: 'loading', error: null });
      setHighlightsState({ phase: 'loading', error: null });
      (async () => {
        try {
          const payload = await api('/doc/session?id=' + encodeURIComponent(activeId));
          if (cancelled) return;
          setSessionId(payload.sessionId);
          if (payload.injected && notifyRef.current) {
            notifyRef.current(
              payload.hasText
                ? '已把全文同步给 AI（' + payload.chars + ' 字）'
                : '这篇没有可抽取的正文，AI 只能看到你划选的段落',
            );
          }
        } catch (error) {
          if (cancelled) return;
          setSessionId(null);
          setSessionError(String((error && error.message) || error));
        }
        try {
          const payload = await api('/doc/memory?id=' + encodeURIComponent(activeId));
          if (cancelled) return;
          setMemory(payload.memory || '');
          setMemoryState({ phase: 'ready', error: null });
        } catch (error) {
          if (cancelled) return;
          setMemoryState({ phase: 'error', error: String((error && error.message) || error) });
        }
        try {
          const payload = await api('/doc/highlights?id=' + encodeURIComponent(activeId));
          if (cancelled) return;
          setHighlights(Array.isArray(payload.items) ? payload.items : []);
          setHighlightsState({ phase: 'ready', error: null });
        } catch (error) {
          if (cancelled) return;
          setHighlightsState({ phase: 'error', error: String((error && error.message) || error) });
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [activeId, memoryTick]);

    const saveMemory = useCallback(
      async (text) => {
        if (!activeId) return;
        try {
          await api('/doc/memory?id=' + encodeURIComponent(activeId), { method: 'POST', body: { memory: text } });
          setMemory(text);
          notify('研究记忆已保存');
        } catch (error) {
          notify('保存失败：' + String((error && error.message) || error));
        }
      },
      [activeId, notify],
    );

    const resync = useCallback(async () => {
      if (!activeId) return;
      try {
        const payload = await api('/doc/resync?id=' + encodeURIComponent(activeId));
        notify(payload.injected ? '已重新同步全文、记忆与划线' : '同步没成功（会话可能还没起来）');
      } catch (error) {
        notify('同步失败：' + String((error && error.message) || error));
      }
    }, [activeId, notify]);

    /* ── marks ─────────────────────────────────────────────────────────── */

    const saveHighlight = useCallback(
      async (item, quiet) => {
        if (!activeId) return;
        try {
          const payload = await api('/doc/highlights?id=' + encodeURIComponent(activeId), {
            method: 'POST',
            body: { item },
          });
          setHighlights(Array.isArray(payload.items) ? payload.items : []);
          if (!quiet) notify('已标记为「' + (COLOR_LABEL[item.color] || '重点') + '」');
        } catch (error) {
          notify('标记失败：' + String((error && error.message) || error));
        }
      },
      [activeId, notify],
    );

    const deleteHighlight = useCallback(
      async (hid) => {
        if (!activeId) return;
        try {
          const payload = await api(
            '/doc/highlights?id=' + encodeURIComponent(activeId) + '&hid=' + encodeURIComponent(hid),
            { method: 'DELETE' },
          );
          setHighlights(Array.isArray(payload.items) ? payload.items : []);
          setActiveHighlight((current) => (current === hid ? null : current));
        } catch (error) {
          notify('删除失败：' + String((error && error.message) || error));
        }
      },
      [activeId, notify],
    );

    const noteHighlight = useCallback(
      (item, note) => {
        saveHighlight({ ...item, note }, true);
      },
      [saveHighlight],
    );

    /* ── painting the marks (CSS Custom Highlight API) ─────────────────── */

    const activeViewer = useCallback(() => {
      const rootElement = rootRef.current;
      if (!rootElement || !activeId) return null;
      const pane = rootElement.querySelector('.dm-pane[data-doc-id="' + activeId + '"]');
      return pane ? pane.querySelector('[data-dm-viewer]') : null;
    }, [activeId]);

    const paintHighlights = useCallback(() => {
      const container = activeViewer();
      if (!container) return;
      try {
        applyHighlights(container, highlightsRef.current);
      } catch (error) {
        /* painting is cosmetic: never let it break the panel */
      }
    }, [activeViewer]);

    // Repaint when the document or the mark set changes…
    useEffect(() => {
      paintHighlights();
    }, [paintHighlights, highlights, activeId]);

    // …and whenever the reading surface rewrites its DOM (async load, PDF lazy render,
    // zoom, pane switch). `applyHighlights` only touches `CSS.highlights`, never the DOM,
    // so this observer cannot feed itself.
    useEffect(() => {
      const rootElement = rootRef.current;
      if (!rootElement || typeof MutationObserver === 'undefined') return undefined;
      let timer = 0;
      const observer = new MutationObserver(() => {
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = 0;
          paintHighlights();
        }, 160);
      });
      observer.observe(rootElement, { childList: true, subtree: true });
      return () => {
        observer.disconnect();
        if (timer) window.clearTimeout(timer);
      };
    }, [paintHighlights]);

    /* ── 阅读位置：每篇文档记住上次读到哪儿 ─────────────────────────────── */

    useEffect(() => {
      if (!activeId) return undefined;
      const key = 'docmate.pos.' + activeId;
      let container = null;
      let saveTimer = 0;
      let retryTimer = 0;
      let alignTimer = 0;
      let cancelled = false;

      function save() {
        if (!container) return;
        try {
          lsSet(key, String(Math.round(container.scrollTop)));
        } catch (error) {
          /* 存不下就只是不记忆，不影响阅读 */
        }
      }

      function onScroll() {
        if (saveTimer) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(save, 260);
      }

      function watch(target) {
        container = target;
        container.addEventListener('scroll', onScroll, { passive: true });
        const saved = Number(lsGet(key) || '0') || 0;
        if (!(saved > 0)) return;
        container.scrollTop = saved;
        // 公式 / 图片排完版高度会变，稍后再对齐一次；用户先动了就不再抢他的滚动条
        let touched = false;
        const touch = () => {
          touched = true;
        };
        container.addEventListener('wheel', touch, { passive: true, once: true });
        container.addEventListener('touchstart', touch, { passive: true, once: true });
        alignTimer = window.setTimeout(() => {
          if (!touched && !cancelled && container) container.scrollTop = saved;
        }, 340);
      }

      /* 正文是异步读进来的：等容器真的长出内容再恢复，否则恢复的是空文档的 0。 */
      function attach(attempt) {
        if (cancelled) return;
        const found = activeViewer();
        const ready = found && found.scrollHeight > found.clientHeight + 40;
        if (!ready) {
          if (attempt < 24) retryTimer = window.setTimeout(() => attach(attempt + 1), 120);
          else if (found) watch(found);
          return;
        }
        watch(found);
      }

      attach(0);
      return () => {
        cancelled = true;
        if (saveTimer) window.clearTimeout(saveTimer);
        if (retryTimer) window.clearTimeout(retryTimer);
        if (alignTimer) window.clearTimeout(alignTimer);
        if (container) {
          container.removeEventListener('scroll', onScroll);
          save();
        }
      };
    }, [activeId, activeViewer]);

    /* 换文档就收起目录：它列的是上一篇的标题节点。 */
    useEffect(() => {
      setOutline(null);
      setOutlineViewer(null);
    }, [activeId]);

    /* 这篇文档的伴随会话是不是已经开过口了（决定要不要显示起手牌）。 */
    useEffect(() => {
      if (!activeId) {
        setChatStarted(false);
        return;
      }
      try {
        setChatStarted(lsGet('docmate.chatstarted.' + activeId) === '1');
      } catch (error) {
        setChatStarted(false);
      }
    }, [activeId]);

    const handlePdfOutline = useCallback((id, items) => {
      setPdfOutlines((current) => ({ ...current, [id]: Array.isArray(items) ? items : [] }));
    }, []);

    const toggleOutline = useCallback(() => {
      setMoreOpen(false);
      if (outline) {
        setOutline(null);
        setOutlineViewer(null);
        return;
      }
      const viewer = activeViewer();
      const isPdf = activeDoc && String(activeDoc.ext).toLowerCase() === 'pdf';
      const pdfItems = isPdf ? pdfOutlines[activeDoc.id] : null;
      const items = scanOutline(viewer, pdfItems);
      if (!items) {
        notify(isPdf && !Array.isArray(pdfItems) ? 'PDF 目录还在读取，请稍候再试' : '这篇文档没有可用目录');
        return;
      }
      setOutline(items);
      setOutlineViewer(viewer);
    }, [activeViewer, activeDoc, pdfOutlines, notify, outline]);

    const pickHeading = useCallback(
      (item) => {
        if (!item) return;
        if (item.page) {
          setPageJump({ page: item.page, nonce: Date.now() });
          return;
        }
        const viewer = outlineViewer || activeViewer();
        const node = item.node;
        if (!viewer || !node) return;
        const top = node.getBoundingClientRect().top - viewer.getBoundingClientRect().top + viewer.scrollTop - 14;
        viewer.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      },
      [activeViewer, outlineViewer],
    );

    /* ── 文档内搜索 ─────────────────────────────────────────────────────── */

    const runFind = useCallback(
      (value) => {
        setFindQuery(value);
        const viewer = activeViewer();
        if (!viewer || !String(value).trim()) {
          setFindResult({ matches: [], truncated: false });
          setFindIndex(0);
          clearMatches();
          return;
        }
        const found = findIn(viewer, value);
        setFindResult(found);
        setFindIndex(0);
        paintMatches(found.matches, 0);
        if (found.matches.length) scrollToMatch(viewer, found.matches[0]);
      },
      [activeViewer, clearMatches, findIn, paintMatches, scrollToMatch],
    );

    const stepFind = useCallback(
      (delta) => {
        const matches = findResult.matches;
        if (!matches.length) return;
        const next = (findIndex + delta + matches.length) % matches.length;
        setFindIndex(next);
        paintMatches(matches, next);
        const viewer = activeViewer();
        if (viewer) scrollToMatch(viewer, matches[next]);
      },
      [findResult, findIndex, activeViewer, paintMatches, scrollToMatch],
    );

    const closeFind = useCallback(() => {
      setFindOpen(false);
      setFindQuery('');
      setFindResult({ matches: [], truncated: false });
      setFindIndex(0);
      clearMatches();
    }, [clearMatches]);

    // Ctrl/Cmd+F 只在「焦点在面板里」或「鼠标正悬在面板上」时接管，别抢宿主自己的查找。
    useEffect(() => {
      function onKeyDown(event) {
        const rootElement = rootRef.current;
        if (!rootElement) return;
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && String(event.key).toLowerCase() === 'f') {
          const focused = document.activeElement;
          const inside = (focused && rootElement.contains(focused)) || rootElement.matches(':hover');
          if (!inside || !activeId) return;
          event.preventDefault();
          setFindOpen(true);
        }
      }
      document.addEventListener('keydown', onKeyDown, true);
      return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [activeId]);

    // 换文档时命中位置全变了：重搜一遍，而不是留着一堆指向旧节点的 Range。
    useEffect(() => {
      if (!findOpen || !findQuery.trim()) return;
      const timer = window.setTimeout(() => runFind(findQuery), 180);
      return () => window.clearTimeout(timer);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeId]);

    const jumpToHighlight = useCallback(
      (item) => {
        const container = activeViewer();
        if (!container) return;
        setActiveHighlight(item.id);
        const page = item.anchor && item.anchor.scope === 'page' ? item.anchor.page : null;
        if (page) {
          // The PDF text layer is rendered lazily: ask the viewer to go to the page first,
          // then look for the range once it exists.
          setPageJump({ page, nonce: Date.now() });
          window.setTimeout(() => {
            const fresh = activeViewer();
            if (fresh && !scrollToHighlight(fresh, item)) notify('这一页还在渲染，再点一次就跳过去了');
          }, 480);
          return;
        }
        if (!scrollToHighlight(container, item)) notify('这条划线暂时定位不到（文档可能改过了）');
      },
      [activeViewer, notify],
    );

    /* ── sending ───────────────────────────────────────────────────────── */

    const post = useCallback(
      async (text, image) => {
        if (!sessionId) {
          notify('伴随会话还没准备好，稍等一下再试');
          return false;
        }
        setBusy(true);
        try {
          // Every sixth question carries a one-line nudge, so memory gets sedimented
          // without a separate model call and without the user having to remember.
          const count = askCountRef.current;
          let outgoing = text;
          if (count > 0 && count % 6 === 0) {
            outgoing +=
              '\n\n（这是第 ' +
              count +
              ' 个问题。回答完之后，请顺手用 docmate_memory 把这一轮里值得长期记住的结论沉淀一下。）';
          }
          await api('/ask', {
            method: 'POST',
            body: { sessionId, text: outgoing, docId: activeId, image: image || undefined },
          });
          askCountRef.current = count + 1;
          // 第一条问出去之后，伴随栏的「起手牌」就收起来；记在 localStorage 里，
          // 刷新页面也不会又冒出来压住历史对话。
          if (activeId) {
            setChatStarted(true);
            try {
              lsSet('docmate.chatstarted.' + activeId, '1');
            } catch (error) {
              /* 记不住就只是下次还会看到起手牌 */
            }
          }
          return true;
        } catch (error) {
          notify('发送失败：' + String((error && error.message) || error));
          return false;
        } finally {
          setBusy(false);
        }
      },
      [sessionId, notify, activeId],
    );

    const sendPlain = useCallback((text) => post(text), [post]);

    const send = useCallback(
      async (question, quote) => {
        if (!quote) return;
        // 框选截图走另一条路：没有可引用的文字，只有一张图和出处。
        if (quote.shot) {
          const ok = await post(buildShotMessage(activeDoc, quote, question, viewportRef.current), quote.shot);
          if (ok) setPending(null);
          return;
        }
        if (!quote.text) return;
        const ok = await post(buildMessage(quote, question, viewportRef.current));
        if (!ok) return;
        setPending(null);
        // Every question leaves a trail: the passage it was asked about becomes a
        // "quote" mark, so the left column can take you back to it later.
        if (quote.anchor && activeId) {
          saveHighlight(
            {
              id: 'q' + hashText(quote.text),
              color: 'question',
              text: quote.text,
              note: '',
              anchor: quote.anchor,
              kind: 'quote',
              createdAt: Date.now(),
            },
            true,
          );
        }
      },
      [post, activeId, saveHighlight, activeDoc],
    );

    /* ── 导出：把这篇文档的研究记忆 + 划线落成一个 md ───────────────────── */

    const exportNotes = useCallback(() => {
      if (!activeDoc) return;
      const pad = (n) => (n < 10 ? '0' + n : String(n));
      const now = new Date();
      const stamp =
        now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes());
      const when = now.toLocaleString('zh-CN');
      const lines = [];
      lines.push('# ' + activeDoc.name + ' · 伴读笔记');
      lines.push('');
      lines.push('- 导出时间：' + when);
      lines.push('- 文档：' + activeDoc.name + (activeDoc.chars ? '（' + activeDoc.chars + ' 字）' : ''));
      lines.push('');
      lines.push('## 研究记忆');
      lines.push('');
      lines.push(memory.trim() ? memory.trim() : '_（还没有研究记忆）_');
      lines.push('');
      lines.push('## 划线（' + highlights.length + ' 条）');
      lines.push('');
      if (!highlights.length) {
        lines.push('_（还没有划线）_');
      } else {
        highlights.forEach((item, index) => {
          const label = COLOR_LABEL[item.color] || item.color || '划线';
          const time = item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '';
          lines.push('### ' + (index + 1) + '. ' + label + (time ? ' · ' + time : ''));
          lines.push('');
          lines.push(
            String(item.text || '')
              .split('\n')
              .map((line) => '> ' + line)
              .join('\n'),
          );
          if (item.note) {
            lines.push('');
            lines.push('备注：' + item.note);
          }
          lines.push('');
        });
      }
      const safeName = String(activeDoc.name || 'docmate')
        .replace(/\.[^.]+$/, '')
        .replace(/[\\/:*?"<>|]/g, '_');
      const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = safeName + '-伴读-' + stamp + '.md';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      notify('已导出研究记忆和 ' + highlights.length + ' 条划线');
    }, [activeDoc, memory, highlights, notify]);

    /* ── drag & drop ───────────────────────────────────────────────────── */

    useEffect(() => {
      const element = rootRef.current;
      if (!element) return undefined;
      let depth = 0;
      const carriesFiles = (event) => {
        const types = event.dataTransfer && event.dataTransfer.types;
        if (!types) return false;
        for (let index = 0; index < types.length; index += 1) {
          if (types[index] === 'Files') return true;
        }
        return false;
      };
      function onDragEnter(event) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth += 1;
        setDragOver(true);
      }
      function onDragOver(event) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        try {
          event.dataTransfer.dropEffect = 'copy';
        } catch (ignored) {
          /* older browsers */
        }
      }
      function onDragLeave(event) {
        if (!carriesFiles(event)) return;
        depth = Math.max(0, depth - 1);
        if (depth === 0) setDragOver(false);
      }
      function onDrop(event) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth = 0;
        setDragOver(false);
        const files = event.dataTransfer && event.dataTransfer.files;
        if (files && files.length) uploadFiles(files);
      }
      element.addEventListener('dragenter', onDragEnter);
      element.addEventListener('dragover', onDragOver);
      element.addEventListener('dragleave', onDragLeave);
      element.addEventListener('drop', onDrop);
      return () => {
        element.removeEventListener('dragenter', onDragEnter);
        element.removeEventListener('dragover', onDragOver);
        element.removeEventListener('dragleave', onDragLeave);
        element.removeEventListener('drop', onDrop);
      };
    }, [uploadFiles]);

    /* ── where the reader is looking ───────────────────────────────────── */

    useEffect(() => {
      function readViewport(scroller) {
        try {
          const box = scroller.getBoundingClientRect();
          const pages = scroller.querySelectorAll('[data-page]');
          if (pages.length > 0) {
            for (const page of pages) {
              const rect = page.getBoundingClientRect();
              if (rect.bottom < box.top + 8) continue;
              return {
                heading: '第 ' + page.getAttribute('data-page') + ' 页',
                excerpt: (page.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
              };
            }
            return null;
          }
          const blocks = scroller.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,table,blockquote');
          let heading = '';
          for (const block of blocks) {
            const rect = block.getBoundingClientRect();
            if (rect.bottom < box.top + 8) {
              if (/^H[1-6]$/.test(block.tagName)) heading = (block.textContent || '').trim();
              continue;
            }
            if (rect.top > box.bottom) break;
            return { heading, excerpt: (block.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240) };
          }
          return null;
        } catch (error) {
          return null;
        }
      }
      function onScroll(event) {
        const target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        if (!target.closest('[data-dm-viewer]')) return;
        viewportRef.current = readViewport(target);
      }
      document.addEventListener('scroll', onScroll, true);
      return () => document.removeEventListener('scroll', onScroll, true);
    }, []);

    /* ── keep the floating bar inside the panel ────────────────────────── */

    // The bar's width depends on its buttons, so it is first placed centred on the
    // selection and then nudged back inside the panel once its real width is known.
    useEffect(() => {
      const element = selBarRef.current;
      const rootElement = rootRef.current;
      if (!element || !rootElement || !selBar) return;
      const box = rootElement.getBoundingClientRect();
      const width = element.getBoundingClientRect().width;
      const left = Math.max(8, Math.min(selBar.centerX - width / 2, box.width - width - 8));
      element.style.left = left + 'px';
      element.style.transform = 'none';
    }, [selBar]);

    /* ── Obsidian wiki links: jump to the heading they name ─────────────── */

    useEffect(() => {
      function onClick(event) {
        const link = event.target && event.target.closest ? event.target.closest('.dm-md-wikilink') : null;
        if (!link) return;
        event.preventDefault();
        const needle = String(link.getAttribute('data-anchor') || link.getAttribute('data-target') || '')
          .replace(/^#/, '')
          .trim();
        const viewer = link.closest('[data-dm-viewer]');
        if (!needle || !viewer) return;
        const headings = Array.from(viewer.querySelectorAll('h1,h2,h3,h4,h5,h6'));
        const exact = headings.find((node) => (node.textContent || '').trim() === needle);
        const loose = exact || headings.find((node) => (node.textContent || '').trim().indexOf(needle) >= 0);
        if (loose) {
          loose.scrollIntoView({ block: 'start', behavior: 'smooth' });
        } else {
          notify('这篇文档里没有「' + needle + '」这一节（笔记之间的跳转需要原库）');
        }
      }
      document.addEventListener('click', onClick, true);
      return () => document.removeEventListener('click', onClick, true);
    }, [notify]);

    /* ── selection bridge ──────────────────────────────────────────────── */

    useEffect(() => {
      function onMouseUp(event) {
        if (event.target && event.target.closest && !event.target.closest('.dm-topbar__more')) setMoreOpen(false);
        if (event.target && event.target.closest && event.target.closest('.dm-selbar')) return;
        // 框选模式下拖拽是「画框」，不是「选文字」。
        if (shotModeRef.current) return;
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          setSelBar(null);
          setHlMenu(false);
          return;
        }
        const text = selection.toString().trim();
        if (text.length < 2) {
          setSelBar(null);
          return;
        }
        const range = selection.getRangeAt(0);
        const anchor = range.commonAncestorContainer;
        const element = anchor.nodeType === 1 ? anchor : anchor.parentElement;
        if (!element || !element.closest) {
          setSelBar(null);
          return;
        }
        const viewer = element.closest('[data-dm-viewer]');
        if (!viewer) {
          setSelBar(null);
          return;
        }
        const pane = element.closest('[data-doc-id]');
        const docId = pane ? pane.getAttribute('data-doc-id') : null;
        const pageNode = element.closest('[data-page]');
        const page = pageNode ? Number(pageNode.getAttribute('data-page')) || null : null;
        const rect = range.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) {
          setSelBar(null);
          return;
        }
        // Selecting inside the comparison pane means "I am looking at this one now": move
        // the active document so the conversation on the right follows the eye.
        if (docId && docId !== activeId) setActiveId(docId);
        const box = rootRef.current ? rootRef.current.getBoundingClientRect() : { left: 0, top: 0, width: 1200 };
        let computed = null;
        try {
          computed = computeAnchor(viewer, range);
        } catch (error) {
          computed = null;
        }
        setSelBar({
          text: text.slice(0, 8000),
          page,
          docId,
          anchor: computed,
          centerX: rect.left + rect.width / 2 - box.left,
          top: rect.top - box.top,
        });
      }
      function onKeyDown(event) {
        if (event.key === 'Escape') {
          setSelBar(null);
          setPending(null);
          setHlMenu(false);
          setMoreOpen(false);
          setShotMode(false);
          setShotCard(null);
        }
      }
      function onScroll() {
        setSelBar(null);
        setHlMenu(false);
      }
      document.addEventListener('mouseup', onMouseUp, true);
      document.addEventListener('keydown', onKeyDown);
      window.addEventListener('resize', onScroll);
      return () => {
        document.removeEventListener('mouseup', onMouseUp, true);
        document.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('resize', onScroll);
      };
    }, [activeId, computeAnchor]);

    /* ── 框选截图：扫描件 / 图片没有文字层，只能框一块发给识图模型 ───────── */

    shotModeRef.current = shotMode;

    useEffect(() => {
      if (!shotMode) return undefined;
      const rootElement = rootRef.current;
      if (!rootElement) return undefined;
      let start = null;
      let drag = null;

      function localPoint(event) {
        const box = rootElement.getBoundingClientRect();
        return { x: event.clientX - box.left, y: event.clientY - box.top };
      }

      function onDown(event) {
        if (event.button !== 0) return;
        const target = event.target;
        const viewer = target && target.closest ? target.closest('[data-dm-viewer]') : null;
        if (!viewer) return;
        event.preventDefault();
        event.stopPropagation();
        const selection = window.getSelection();
        if (selection) selection.removeAllRanges();
        start = localPoint(event);
        drag = { left: start.x, top: start.y, width: 0, height: 0 };
        setShotDrag(drag);
      }

      function onMove(event) {
        if (!start) return;
        const p = localPoint(event);
        drag = {
          left: Math.min(start.x, p.x),
          top: Math.min(start.y, p.y),
          width: Math.abs(p.x - start.x),
          height: Math.abs(p.y - start.y),
        };
        setShotDrag(drag);
      }

      function onUp() {
        if (!start) return;
        const box = rootElement.getBoundingClientRect();
        const finished = drag;
        start = null;
        drag = null;
        setShotDrag(null);
        if (!finished || finished.width < 10 || finished.height < 10) {
          setShotMode(false);
          return;
        }
        const viewer = activeViewer();
        if (!viewer) {
          setShotMode(false);
          notify('这块区域不在阅读区里');
          return;
        }
        if (!captureRegion) {
          setShotMode(false);
          notify('截图模块没加载（48-shot.js）');
          return;
        }
        const viewportRect = {
          left: finished.left + box.left,
          top: finished.top + box.top,
          right: finished.left + box.left + finished.width,
          bottom: finished.top + box.top + finished.height,
          width: finished.width,
          height: finished.height,
        };
        setShotBusy(true);
        captureRegion(viewer, viewportRect)
          .then((result) => {
            setShotBusy(false);
            setShotMode(false);
            if (!result || !result.ok) {
              const reason = result && result.reason;
              notify(
                reason === 'too-small'
                  ? '框太小了，再拉大一点'
                  : reason === 'tainted'
                    ? '这张图跨域了，截不下来；可以试试直接划词'
                    : reason === 'empty'
                      ? '这块区域里没有可截的内容'
                      : '截图失败，换个区域试试',
              );
              return;
            }
            const pageNode = viewer.querySelector('[data-page]');
            setShotCard({
              dataUrl: result.dataUrl,
              mediaType: result.mediaType || 'image/png',
              width: result.width,
              height: result.height,
              kind: result.kind || 'html',
              page: pageNode ? Number(pageNode.getAttribute('data-page')) || null : null,
              centerX: finished.left + finished.width / 2,
              top: finished.top,
              dragHeight: finished.height,
            });
          })
          .catch(() => {
            setShotBusy(false);
            setShotMode(false);
            notify('截图失败，换个区域试试');
          });
      }

      rootElement.addEventListener('mousedown', onDown, true);
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      return () => {
        rootElement.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
      };
    }, [shotMode, activeId, activeViewer, captureRegion, notify]);

    const askAboutShot = useCallback(
      (action) => {
        const card = shotCard;
        if (!card || !action) return;
        const payload = {
          mediaType: card.mediaType,
          data: card.dataUrl,
          name: 'selection.' + (card.mediaType === 'image/jpeg' ? 'jpg' : 'png'),
        };
        if (!action.question) {
          // 「追问…」不直接发：把截图挂到伴随栏的待发条上，让用户自己写问题。
          setPending({ shot: payload, docName: activeDoc ? activeDoc.name : '', page: card.page });
          setShotCard(null);
          return;
        }
        const text = buildShotMessage(activeDoc, card, action.question, viewportRef.current);
        post(text, payload);
        setShotCard(null);
      },
      [shotCard, activeDoc, post],
    );

    const clearSelection = useCallback(() => {
      const selection = window.getSelection();
      if (selection) selection.removeAllRanges();
      setSelBar(null);
      setHlMenu(false);
    }, []);

    const quoteOfSelection = useCallback(() => {
      if (!selBar) return null;
      const source = docs.find((doc) => doc.id === selBar.docId) || activeDoc;
      return {
        text: selBar.text,
        page: selBar.page,
        docName: source ? source.name : '',
        docPath: source ? source.id : '',
        anchor: selBar.anchor,
      };
    }, [selBar, docs, activeDoc]);

    const runAction = useCallback(
      (action) => {
        const quote = quoteOfSelection();
        if (!quote) return;
        clearSelection();
        if (action.question === null) {
          setPending(quote);
          return;
        }
        send(action.question, quote);
      },
      [quoteOfSelection, clearSelection, send],
    );

    const markSelection = useCallback(
      (color) => {
        const quote = quoteOfSelection();
        if (!quote) return;
        if (!quote.anchor) {
          notify('这段选区的定位算不出来，暂时标不了（换一段试试）');
          clearSelection();
          return;
        }
        // A PDF selection that spans two pages falls back to whole-viewer offsets, and the
        // PDF text layer is rendered lazily — those offsets would drift between sessions.
        // Refuse the mark instead of painting it in the wrong place later.
        const viewer = activeViewer();
        if (quote.anchor.scope === 'doc' && viewer && viewer.querySelector('[data-page]')) {
          notify('PDF 里跨页的选区定位不稳，请分页划');
          clearSelection();
          return;
        }
        saveHighlight({
          id: 'h' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
          color,
          text: quote.text,
          note: '',
          anchor: quote.anchor,
          kind: 'mark',
          createdAt: Date.now(),
        });
        clearSelection();
      },
      [quoteOfSelection, notify, clearSelection, saveHighlight, activeViewer],
    );

    /* ── marks as a question ───────────────────────────────────────────── */

    const askAboutHighlight = useCallback(
      (item) => {
        if (!item) return;
        send('请解释这段内容，并说明它为什么值得标记。', {
          text: item.text,
          page: item.anchor && item.anchor.scope === 'page' ? item.anchor.page : null,
          docName: activeDoc ? activeDoc.name : '',
          docPath: activeDoc ? activeDoc.id : '',
          anchor: item.anchor,
        });
      },
      [send, activeDoc],
    );

    const askAllHighlights = useCallback(() => {
      const marks = highlights.filter((item) => item.kind === 'mark');
      if (marks.length === 0) {
        notify('还没有手划的线（引用记录不算）');
        return;
      }
      const lines = marks
        .slice(-60)
        .map((item, index) => {
          const where = item.anchor && item.anchor.scope === 'page' && item.anchor.page ? '（第 ' + item.anchor.page + ' 页）' : '';
          return index + 1 + '. [' + (COLOR_LABEL[item.color] || '重点') + ']' + where + ' ' + oneLine(item.text, 120);
        })
        .join('\n');
      sendPlain(
        '这是我在这篇文档里划下的线（共 ' +
          marks.length +
          ' 条）：\n\n' +
          lines +
          '\n\n请据此回答三件事：① 我关注的重心是什么；② 哪些疑问我还没解决；③ 接下来我该重点读哪里。',
      );
    }, [highlights, notify, sendPlain]);

    /**
     * 唯一写 docmate.panes 的地方。
     *
     * 这个键里同时住着「栏的折叠状态」（side / chat / manual）和「三栏宽度」
     * （leftW / rightW），所以每次写都要**合并**：先读出当前对象，只覆盖这次要改的字段，
     * 再交给 writeSizes 补上宽度。直接 lsSet 一个新对象会把折叠状态清掉 —— 用户拖一次
     * 分隔条，下次刷新左栏就自己弹回来了。
     */
    const persistPanes = useCallback((side, chat, sizes) => {
      const stored = util.lsGet('docmate.panes', null);
      const base = stored && typeof stored === 'object' ? Object.assign({}, stored) : {};
      base.side = side;
      base.chat = chat;
      base.manual = true;
      writeSizes(util.lsSet, sizes || paneSizesRef.current, base);
    }, [writeSizes]);

    /** 拖动中：只改「想要的宽度」，渲染宽度由 resolveSizes 这一帧重新算。 */
    const dragPane = useCallback((side, next) => {
      const current = paneSizesRef.current;
      const merged =
        side === 'left'
          ? { left: next, right: current.right }
          : { left: current.left, right: next };
      paneSizesRef.current = merged;
      setPaneSizes(merged);
    }, []);

    /** 双击 / Enter：把这一栏恢复默认宽度，并立刻落盘。 */
    const resetPane = useCallback((side) => {
      const current = paneSizesRef.current;
      const merged =
        side === 'left'
          ? { left: PANE_DEFAULTS.left, right: current.right }
          : { left: current.left, right: PANE_DEFAULTS.right };
      paneSizesRef.current = merged;
      setPaneSizes(merged);
      persistPanes(showSide, showChat, merged);
    }, [persistPanes, showSide, showChat]);

    // A narrow panel cannot hold three columns. Fold the research rail whenever the panel
    // is too narrow — including when the window shrinks while it is open — and restore the
    // user's own preference once there is room again.
    useEffect(() => {
      const element = rootRef.current;
      if (!element) return undefined;
      const NARROW = 1000;
      const apply = (width) => {
        if (width <= 0) return;
        // 同一份测量结果喂两处：折叠策略，以及三栏宽度的分配。
        setPanelWidth(width);
        setShowSide(width < NARROW ? false : !sideOffRef.current);
      };
      apply(element.getBoundingClientRect().width);
      if (typeof ResizeObserver === 'undefined') return undefined;
      const observer = new ResizeObserver((entries) => {
        apply(entries[0] && entries[0].contentRect ? entries[0].contentRect.width : 0);
      });
      try {
        observer.observe(element);
      } catch (error) {
        return undefined;
      }
      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      askCountRef.current = 0;
    }, [activeId]);

    /* ── spaced review + cross-document question ───────────────────────── */

    const scheduleReview = useCallback(async () => {
      if (!activeId) return;
      let timeZone = 'Asia/Shanghai';
      try {
        timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone;
      } catch (error) {
        /* keep the default */
      }
      try {
        const payload = await api('/doc/review?id=' + encodeURIComponent(activeId), {
          method: 'POST',
          body: { time: '20:00', timeZone },
        });
        notify('已安排每天 ' + payload.time + ' 复习这篇的「待复习」划线（在侧栏的定时任务里能看到）');
      } catch (error) {
        notify('安排失败：' + String((error && error.message) || error));
      }
    }, [activeId, notify]);

    const askAcross = useCallback(() => {
      if (!compareId || !activeDoc) return;
      const other = docs.find((doc) => doc.id === compareId);
      if (!other) return;
      sendPlain(
        '我现在并排在看两篇文档：《' +
          activeDoc.name +
          '》和《' +
          other.name +
          '》。\n\n请对照它们回答三件事：\n① 各自的核心论点 / 结论是什么；\n② 它们在哪些地方一致、哪些地方冲突；\n③ 如果我要把两篇合起来用，最该注意什么。\n\n（需要《' +
          other.name +
          '》的正文时，用 docmate_read 传 doc="' +
          other.name +
          '" 读取。）',
      );
    }, [compareId, docs, activeDoc, sendPlain]);

    /* ── centre panes ──────────────────────────────────────────────────── */

    const paneIds = compareId && compareId !== activeId ? [activeId, compareId] : [activeId];
    const canCompare = docs.length > 1;

    const toggleCompare = useCallback(() => {
      if (compareId) {
        setCompareId(null);
        return;
      }
      const other = docs.find((doc) => doc.id !== activeId);
      if (other) setCompareId(other.id);
    }, [compareId, docs, activeId]);

    /* ── render ────────────────────────────────────────────────────────── */

    const markCount = highlights.filter((item) => item.kind === 'mark').length;

    /** One row of the top bar's overflow menu. */
    function menuRow(label, icon, onClick, disabled) {
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'dm-topbar__menu-item',
          disabled: !!disabled,
          onClick: () => {
            setMoreOpen(false);
            onClick();
          },
        },
        h(Icon, { name: icon, size: 13 }),
        label,
      );
    }

    /* 抓到的截图：缩略图 + 三个动作。位置跟着框走，贴边时自动翻到上方。 */
    function renderShotCard() {
      if (!shotCard) return null;
      const rootBox = rootRef.current ? rootRef.current.getBoundingClientRect() : { width: 1200, height: 800 };
      const cardWidth = 300;
      const left = clamp(shotCard.centerX - cardWidth / 2, 8, Math.max(8, rootBox.width - cardWidth - 8));
      const below = shotCard.top + shotCard.dragHeight + 12;
      const top = below + 240 > rootBox.height ? Math.max(8, shotCard.top - 240) : below;
      const kindLabel = shotCard.kind === 'pdf' ? 'PDF' : shotCard.kind === 'img' ? '图片' : '正文';
      return h(
        'div',
        { className: 'dm-shotcard', style: { left: left + 'px', top: top + 'px', width: cardWidth + 'px' } },
        h('img', { className: 'dm-shotcard__img', src: shotCard.dataUrl, alt: '框选截图' }),
        h(
          'div',
          { className: 'dm-shotcard__meta' },
          shotCard.width +
            ' × ' +
            shotCard.height +
            ' · ' +
            kindLabel +
            (shotCard.page ? ' · 第 ' + shotCard.page + ' 页' : ''),
        ),
        h(
          'div',
          { className: 'dm-shotcard__acts' },
          SHOT_ACTIONS.map((action) =>
            h(
              'button',
              {
                key: action.id,
                type: 'button',
                className: cx('dm-shotcard__btn', action.id === 'explain' && 'is-primary'),
                onClick: () => askAboutShot(action),
              },
              action.label,
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dm-shotcard__btn dm-shotcard__btn--ghost',
              onClick: () => setShotCard(null),
            },
            '取消',
          ),
        ),
      );
    }

    /* ── 三栏宽度 ───────────────────────────────────────────────────────── */

    // 这一帧真正渲染的宽度。折叠的栏会被算成 0，所以它的分隔条也不占宽度。
    const sizes = resolveSizes(panelWidth, paneSizes.left, paneSizes.right, {
      showLeft: showSide,
      showRight: showChat,
    });
    const sideStyle = { flex: '0 1 ' + sizes.left + 'px', width: sizes.left + 'px', minWidth: 0 };
    const railStyle = { flex: '0 1 ' + sizes.right + 'px', width: sizes.right + 'px', minWidth: 0 };

    function renderPaneHandle(side) {
      if (!PaneHandle) return null;
      const isLeft = side === 'left';
      const limits = isLeft ? PANE_LIMITS.left : PANE_LIMITS.right;
      return h(PaneHandle, {
        side: side,
        width: isLeft ? sizes.left : sizes.right,
        min: limits.min,
        max: limits.max,
        // 框选截图模式下拖拽是「画框」，分隔条要让路（CSS 里还会再关一次 pointer-events）。
        disabled: shotMode,
        onDrag: (next) => dragPane(side, next),
        onDragStart: () => setResizing(side),
        onDragEnd: () => {
          setResizing(null);
          // 拖动结束才落盘：pointermove 每次都写 localStorage 太浪费。
          persistPanes(showSide, showChat);
        },
        onReset: () => resetPane(side),
      });
    }

    return h(
      'div',
      { className: cx('dm-root', shotMode && 'is-shot', resizing && 'is-resizing'), ref: rootRef },

      // The hidden picker lives at the panel root, not inside the research rail: the rail
      // can be folded away, and dropping a document must still work from the welcome screen.
      h('input', {
        ref: fileRef,
        type: 'file',
        multiple: true,
        accept: ACCEPTED.map((ext) => '.' + ext).join(','),
        style: { display: 'none' },
        onChange: (event) => {
          const files = event.target.files;
          if (files && files.length) uploadFiles(files);
          event.target.value = '';
        },
      }),

      /* left rail — the research workspace */
      showSide
        ? h(
        'div',
        { className: 'dm-side', style: sideStyle },
        h(
          'div',
          { className: 'dm-side__head' },
          h('span', { className: 'dm-side__title' }, '研究区'),
          h(
            'button',
            {
              type: 'button',
              className: 'dm-btn dm-btn--icon',
              title: '加入文档',
              onClick: () => fileRef.current && fileRef.current.click(),
            },
            h(Icon, { name: 'plus' }),
          ),
          h(
            'button',
            { type: 'button', className: 'dm-btn dm-btn--icon', title: '刷新列表', onClick: loadDocs },
            h(Icon, { name: 'refresh' }),
          ),
        ),
        uploading > 0
          ? h('div', { className: 'dm-side__hint' }, h('span', { className: 'dm-spinner' }), ' 正在解析 ' + uploading + ' 个文件…')
          : null,
        docsState.phase === 'error'
          ? h('div', { className: 'dm-empty' }, h('div', { className: 'dm-empty__title' }, '读不到研究区'), h('div', null, docsState.error))
          : h(LeftBoundary, null, h(DocList, {
              docs,
              activeId,
              compareId,
              onSelect: (id) => {
                setActiveId(id);
                setSelBar(null);
              },
              onRemove: removeDoc,
              onCompare: (id) => {
                if (id === activeId) return;
                setCompareId((current) => (current === id ? null : id));
              },
            })),
        HighlightList
          ? h(LeftBoundary, null, h(HighlightList, {
              items: highlights,
              activeId: activeHighlight,
              loading: highlightsState.phase === 'loading',
              error: highlightsState.error,
              onJump: jumpToHighlight,
              onDelete: deleteHighlight,
              onNote: noteHighlight,
              onAskAbout: askAboutHighlight,
              onAskAll: askAllHighlights,
            }))
          : null,
        h(LeftBoundary, null, h(MemoryPanel, {
          doc: activeDoc,
          memory,
          loading: memoryState.phase === 'loading',
          error: memoryState.error,
          onSave: saveMemory,
          onRefresh: () => setMemoryTick((tick) => tick + 1),
        })),
      )
        : null,

      /* 左分隔条：只有左栏在的时候才有意义 */
      showSide ? renderPaneHandle('left') : null,

      /* centre */
      h(
        'div',
        { className: 'dm-main' },
        h(
          'div',
          { className: 'dm-topbar' },
          h(
            'button',
            {
              type: 'button',
              className: cx('dm-btn', 'dm-btn--icon', !showSide && 'is-off'),
              title: showSide ? '收起研究区（给阅读让地方）' : '展开研究区',
              onClick: () => {
                const next = !showSide;
                sideOffRef.current = !next;
                setShowSide(next);
                persistPanes(next, showChat);
              },
            },
            h(Icon, { name: 'layout', size: 14 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dm-btn dm-btn--icon',
              title: '加入文档',
              onClick: () => fileRef.current && fileRef.current.click(),
            },
            h(Icon, { name: 'plus', size: 14 }),
          ),
          h(
            'div',
            { className: 'dm-topbar__title' },
            h('span', { className: 'dm-topbar__name' }, activeDoc ? activeDoc.name : '研究区'),
            activeDoc
              ? h(
                  'span',
                  {
                    className: 'dm-topbar__path',
                    title: !activeDoc.hasText
                      ? '这篇文档还没抽出正文'
                      : activeDoc.chars > inlineLimit
                        ? '全文 ' +
                          activeDoc.chars +
                          ' 字，注入伴随会话的是前 ' +
                          inlineLimit +
                          ' 字；剩下的它会用 docmate_read 按需读取'
                        : '全文已注入伴随会话',
                  },
                  (activeDoc.hasText
                    ? activeDoc.chars > inlineLimit
                      ? activeDoc.chars + ' 字 · 注入前 ' + inlineLimit + ' 字'
                      : activeDoc.chars + ' 字已同步'
                    : '未抽取正文') + (markCount > 0 ? ' · ' + markCount + ' 条划线' : ''),
                )
              : null,
          ),
          activeDoc
            ? h(
                'button',
                {
                  type: 'button',
                  className: cx('dm-btn', 'dm-btn--icon', outline && 'is-on'),
                  title: outline ? '收起目录' : '文档目录：按标题快速跳转',
                  onClick: toggleOutline,
                },
                h(Icon, { name: 'list', size: 14 }),
              )
            : null,
          activeDoc
            ? h(
                'button',
                {
                  type: 'button',
                  className: cx('dm-btn', 'dm-btn--icon', shotMode && 'is-on'),
                  title: shotMode ? '退出框选（Esc）' : '框选一块区域发给 AI（扫描件 / 图片没有文字层时用）',
                  onClick: () => {
                    setShotMode((on) => !on);
                    setSelBar(null);
                    setShotCard(null);
                  },
                },
                h(Icon, { name: 'crop', size: 14 }),
              )
            : null,
          h(
            'div',
            { className: 'dm-topbar__more' },
            h(
              'button',
              {
                type: 'button',
                className: cx('dm-btn', 'dm-btn--icon', moreOpen && 'is-open'),
                title: '更多操作',
                onClick: () => setMoreOpen((open) => !open),
              },
              h(Icon, { name: 'more', size: 14 }),
            ),
            moreOpen
              ? h(
                  'div',
                  { className: 'dm-topbar__menu', role: 'menu' },
                  activeDoc
                    ? menuRow('通读全文：让 AI 给出整体结构', 'doc', () => sendPlain(WHOLE_DOC_QUESTION), busy || !sessionId)
                    : null,
                  activeDoc
                    ? menuRow('重新同步全文、记忆与划线', 'refresh', resync, false)
                    : null,
                  activeDoc
                    ? menuRow('在文档里搜索（Ctrl+F）', 'search', () => {
                        setMoreOpen(false);
                        setFindOpen(true);
                      }, false)
                    : null,
                  activeDoc
                    ? menuRow('沉淀记忆：把结论写进研究记忆', 'spark', () => sendPlain(DISTILL_QUESTION), busy || !sessionId)
                    : null,
                  activeDoc
                    ? menuRow('导出笔记：研究记忆 + 划线存成 md', 'file', exportNotes, false)
                    : null,
                  activeDoc
                    ? menuRow('安排复习：每天用「待复习」划线考你', 'book', scheduleReview, !sessionId)
                    : null,
                  compareId
                    ? menuRow('对照提问：让 AI 对比两篇文档', 'panel', askAcross, busy || !sessionId)
                    : null,
                )
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              className: cx('dm-btn', compareId && 'dm-btn--solid'),
              title: canCompare ? '并排对照两篇文档' : '至少要有两篇文档才能对照',
              disabled: !canCompare,
              onClick: toggleCompare,
            },
            h(Icon, { name: 'panel', size: 14 }),
            compareId ? '退出对照' : '对照',
          ),
          h(
            'button',
            {
              type: 'button',
              className: cx('dm-btn', 'dm-btn--icon', !showChat && 'is-off'),
              title: showChat ? '收起伴随 AI（全宽阅读）' : '展开伴随 AI',
              onClick: () => {
                const next = !showChat;
                setShowChat(next);
                persistPanes(showSide, next);
              },
            },
            h(Icon, { name: 'message', size: 14 }),
          ),
        ),
        outline
          ? h(DocOutline, {
              items: outline,
              viewer: outlineViewer,
              onPick: pickHeading,
              onClose: () => {
                setOutline(null);
                setOutlineViewer(null);
              },
            })
          : null,
        findOpen && FindBar
          ? h(FindBar, {
              query: findQuery,
              count: findResult.matches.length,
              index: findIndex,
              onQuery: runFind,
              onPrev: () => stepFind(-1),
              onNext: () => stepFind(1),
              onClose: closeFind,
            })
          : null,
        docsState.phase === 'loading' && docs.length === 0
          ? h('div', { className: 'dm-loading' }, h('span', { className: 'dm-spinner' }), '载入研究区…')
          : docs.length === 0
            ? h(
                'div',
                { className: 'dm-welcome' },
                h('div', { className: 'dm-welcome__mark' }, h(Icon, { name: 'book', size: 26, strokeWidth: 1.6 })),
                h('div', { className: 'dm-welcome__title' }, '把要深读的文档拖进来'),
                h(
                  'div',
                  { className: 'dm-welcome__hint' },
                  '拖进这个面板（或点左上角 ＋），它就进了研究区：',
                  h('br'),
                  'AI 会先通读全文，再陪你在正文里逐段抠细节；划下的线会一直留着。',
                ),
                h(
                  'div',
                  { className: 'dm-chips' },
                  ['md', 'docx', 'pdf', 'txt'].map((ext) => h('span', { key: ext, className: 'dm-chip' }, ext.toUpperCase())),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dm-btn dm-btn--solid', onClick: () => fileRef.current && fileRef.current.click() },
                  h(Icon, { name: 'plus', size: 14 }),
                  '选择文件',
                ),
              )
            : h(
                'div',
                { className: cx('dm-panes', paneIds.length > 1 && 'is-split') },
                paneIds.map((id) => {
                  const doc = docs.find((entry) => entry.id === id);
                  if (!doc) return null;
                  return h(
                    'div',
                    { key: id, className: 'dm-pane', 'data-doc-id': id },
                    paneIds.length > 1
                      ? h(
                          'div',
                          { className: 'dm-pane__head' },
                          h('span', { className: 'dm-pane__name', title: doc.name }, doc.name),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dm-btn dm-btn--icon',
                              title: id === activeId ? '换成另一篇' : '关掉这一格',
                              onClick: () => {
                                if (id === activeId) setCompareId(null);
                                else {
                                  setActiveId(compareId);
                                  setCompareId(null);
                                }
                              },
                            },
                            h(Icon, { name: 'close', size: 13 }),
                          ),
                        )
                      : null,
                    h(CentreBoundary, null, h(DocBody, {
                      doc,
                      pageJump: id === activeId ? pageJump : null,
                      onOutline: (items) => handlePdfOutline(id, items),
                      onStatus: () => {},
                    })),
                  );
                }),
              ),
      ),

      /* 右分隔条：只有右栏在的时候才有意义 */
      showChat ? renderPaneHandle('right') : null,

      /* right rail — the companion conversation */
      showChat
        ? h(
        'div',
        { className: 'dm-rail-right', style: railStyle },
        h(RightBoundary, null, h(ChatPanel, {
          sessionId,
          hostKit,
          pending,
          busy,
          error: sessionError,
          docName: activeDoc ? activeDoc.name : '',
          starter: !chatStarted,
          docHasText: activeDoc ? activeDoc.hasText !== false : true,
          onStartShot: () => setShotMode(true),
          onSend: ({ question, quote }) => (quote ? send(question, quote) : sendPlain(question)),
          onCancelPending: () => setPending(null),
          onNewSession: null,
          onRetainFailed: (reason) => {
            setSessionError('伴随会话失效：' + reason + '（点「重新同步」会重建）');
            setSessionId(null);
          },
        })),
      )
        : null,

      /* floating selection bar */
      selBar
        ? h(
            'div',
            {
              className: 'dm-selbar',
              ref: selBarRef,
              style: {
                left: selBar.centerX + 'px',
                top: Math.max(8, selBar.top - 46) + 'px',
                transform: 'translateX(-50%)',
              },
              onMouseDown: (event) => event.preventDefault(),
            },
            QUICK_ACTIONS.map((action, index) =>
              h(
                'button',
                {
                  key: action.id,
                  type: 'button',
                  className: cx('dm-selbar__btn', index === 0 && 'dm-selbar__btn--primary'),
                  onClick: () => runAction(action),
                  disabled: busy,
                },
                h(Icon, { name: action.icon, size: 13 }),
                action.label,
              ),
            ),
            h('span', { className: 'dm-selbar__divider' }),
            h(
              'button',
              {
                type: 'button',
                className: cx('dm-selbar__btn', hlMenu && 'is-open'),
                onClick: () => setHlMenu((open) => !open),
                disabled: !selBar.anchor,
                title: selBar.anchor ? '把这段标成重点 / 疑问 / 待复习' : '这段选区的定位算不出来',
              },
              h(Icon, { name: 'quote', size: 13 }),
              '划线',
            ),
            hlMenu
              ? h(
                  'div',
                  { className: 'dm-selbar__menu' },
                  COLORS.map((color) =>
                    h(
                      'button',
                      {
                        key: color.id,
                        type: 'button',
                        className: 'dm-selbar__color',
                        onClick: () => markSelection(color.id),
                      },
                      h('span', { className: 'dm-selbar__dot dm-selbar__dot--' + color.id }),
                      color.label,
                    ),
                  ),
                )
              : null,
          )
        : null,

      /* 框选：拖拽框 / 提示 / 抓到的图 */
      shotMode
        ? h(
            'div',
            { className: 'dm-shot-hint' },
            shotBusy ? '正在截图…' : '拖拽框选要发给 AI 的区域 · Esc 取消',
          )
        : null,
      shotDrag
        ? h(
            'div',
            {
              className: 'dm-shot-marquee',
              style: {
                left: shotDrag.left + 'px',
                top: shotDrag.top + 'px',
                width: shotDrag.width + 'px',
                height: shotDrag.height + 'px',
              },
            },
            h('span', { className: 'dm-shot-marquee__size' }, Math.round(shotDrag.width) + ' × ' + Math.round(shotDrag.height)),
          )
        : null,
      shotCard ? renderShotCard() : null,

      dragOver ? h(DropOverlay, { visible: true }) : null,
      toast ? h('div', { className: 'dm-toast' }, toast) : null,
    );
  }

  /* ── sidebar entry ───────────────────────────────────────────────────── */

  /**
   * The left-rail glyph. The sidebar hands every panel icon
   * `SidebarPanelIconOwnerProps = { size, active }`, so honour both.
   */
  function DocMateIcon(props) {
    const size = props && typeof props.size === 'number' ? props.size : 20;
    const active = !!(props && props.active);
    return h(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 2 : 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5Z' }),
      h('path', { d: 'M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5' }),
      h('path', { d: 'M9 8h6' }),
      h('path', { d: 'M9 11.5h4' }),
    );
  }

  return { DocMateApp, DocMateIcon, _test: { scanOutline } };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createApp };
