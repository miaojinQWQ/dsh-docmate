/* ===== 40-pdf.js ===== */
/* DocMate —— PDF 阅读器（pdf.js v3 UMD 全局版）
 *
 * 约束（见 CONTRACT.md §0/§1/§4）：
 *   - 只依赖参数 React；无 JSX、无 import/export、无顶层 await、无动态 import。
 *   - 只写 class 名（dm-pdf-*），样式由 Lead 注入；仅保留少量「不写就坏」的内联布局。
 *   - 任何失败都渲染 dm-pdf-error 并回调 onError，绝不让异常冒泡到 slot。
 *
 * 导出：createPdfViewer(React) -> { PdfViewer, extractText }
 * 组件：h(PdfViewer, { url, onTextSelection, onError })
 *   onTextSelection({ text, page })  —— page 为 1 基页码
 *   onError(Error)                   —— Error.message 已是可读中文
 * 工具：extractText(url) -> Promise<{ text, pages, chars }>
 *   抽全文给上传流程用（Host 半没有 PDF 文本抽取能力，只能靠浏览器里的 pdf.js）。
 */
function createPdfViewer(React) {
  const h = React.createElement;
  const useState = React.useState;
  const useRef = React.useRef;
  const useEffect = React.useEffect;
  const useMemo = React.useMemo;

  /* ================= 常量 ================= */

  const ASSET_BASE = '/api/docmate/asset/pdfjs/';
  const PDFJS_SRC = ASSET_BASE + 'pdf.min.js';
  const WORKER_SRC = ASSET_BASE + 'pdf.worker.min.js';
  /* 中文 / 日韩 PDF 的 CMap（pdfjs-dist@3.11.174 的 168 个 .bcmap）。
   * 必须以 '/' 结尾：pdf.js 内部拼成 baseUrl + name + '.bcmap'。
   * 注意 cMapUrl / cMapPacked 是 getDocument() 的参数，不是 GlobalWorkerOptions 的。 */
  const CMAP_URL = ASSET_BASE + 'cmaps/';

  const MIN_SCALE = 0.25;
  const MAX_SCALE = 4;
  const ZOOM_STEP = 0.15;
  const PRELOAD_PX = 800; // 视口上下各预渲染这么多像素
  const PAGE_GUTTER = 12;
  const MAX_DPR = 2;
  const LOAD_TIMEOUT_MS = 20000;
  const LARGE_DOC_PAGES = 200; // 超过就提示「按需渲染」
  const EAGER_DIMS_PAGES = 100; // 超过就不预扫每页尺寸（用首页尺寸占位）
  const MAX_SELECTION_CHARS = 20000;
  const DEFAULT_PAGE_DIMS = { width: 612, height: 792 };
  const PDFJS_VERSION = '3.11.174';
  const PDFJS_LIB_KEY = '__dmPdfJsLib__';
  const PDFJS_PROMISE_KEY = '__dmPdfJsPromise__';

  /* ================= 纯工具（无 DOM，可单测） ================= */

  function clamp(n, lo, hi) {
    const v = Number(n);
    if (!isFinite(v)) return lo;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  /* 2D 仿射矩阵乘法，语义同 pdf.js 的 Util.transform(m1, m2)。 */
  function mulTransform(m1, m2) {
    const a = m1 || [1, 0, 0, 1, 0, 0];
    const b = m2 || [1, 0, 0, 1, 0, 0];
    return [
      a[0] * b[0] + a[2] * b[1],
      a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3],
      a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4],
      a[1] * b[4] + a[3] * b[5] + a[5],
    ];
  }

  /* 把 pdf.js / 网络 / 解析错误翻译成一句人话。 */
  function formatError(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    const name = err.name || '';
    const raw = err.message || String(err);
    if (name === 'MissingPDFException') return '找不到这个 PDF 文件：' + raw;
    if (name === 'InvalidPDFException') return 'PDF 文件已损坏或格式不受支持：' + raw;
    if (name === 'PasswordException') return '这个 PDF 有密码保护，暂时无法打开。';
    if (name === 'UnexpectedResponseException') return '读取 PDF 失败：' + raw;
    if (name === 'AbortException') return 'PDF 加载已取消。';
    if (name === 'ResponseException') return '读取 PDF 失败：' + raw;
    return raw || name || '未知错误';
  }

  /* 渲染被主动取消（切缩放 / 卸载）不算错误。 */
  function isCancelError(err) {
    if (!err) return false;
    const name = err.name || '';
    if (name === 'RenderingCancelledException' || name === 'AbortException') return true;
    const msg = String(err.message || err);
    return /cancel|abort/i.test(msg) && /render|task|operation/i.test(msg);
  }

  function cssFontFamily(name) {
    const raw = typeof name === 'string' && name.trim() ? name.trim() : 'sans-serif';
    if (/^[A-Za-z0-9_-]+$/.test(raw)) return raw;
    if (/^["'].*["']$/.test(raw)) return raw;
    return '"' + raw.replace(/"/g, '') + '"';
  }

  async function outlinePage(doc, dest) {
    try {
      const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || !explicit[0]) return 0;
      const page = Math.floor(Number(await doc.getPageIndex(explicit[0]))) + 1;
      const total = Math.floor(Number(doc.numPages)) || 0;
      return page > 0 && (!total || page <= total) ? page : 0;
    } catch (e) {
      return 0;
    }
  }

  async function readOutline(doc) {
    if (!doc || typeof doc.getOutline !== 'function') return [];
    const root = await doc.getOutline();
    const items = [];

    async function walk(nodes, depth) {
      for (const entry of nodes || []) {
        if (!entry || typeof entry !== 'object') continue;
        const text = String(entry.title || '').replace(/\s+/g, ' ').trim();
        const page = entry.dest ? await outlinePage(doc, entry.dest) : 0;
        if (text && page) items.push({ text: text, page: page, depth: depth });
        if (Array.isArray(entry.items) && entry.items.length) await walk(entry.items, depth + 1);
      }
    }

    await walk(Array.isArray(root) ? root : [], 0);
    return items;
  }

  /* 单个 textContent item 的定位换算（pdf.js v3 文本层同款公式）。
   * 返回的 left/top/fontSize 单位是「当前 scale 下的 CSS px」，
   * targetWidth 是该段文字在页面上的目标宽度（CSS px），用来算 scaleX。 */
  function computeTextSpan(item, style, viewport) {
    const vt = (viewport && viewport.transform) || [1, 0, 0, 1, 0, 0];
    const it = (item && item.transform) || [1, 0, 0, 1, 0, 0];
    const tx = mulTransform(vt, it);
    let angle = Math.atan2(tx[1], tx[0]);
    if (style && style.vertical) angle += Math.PI / 2;
    const fontSize = Math.hypot(tx[2], tx[3]);
    const rawAscent = style && typeof style.ascent === 'number' ? style.ascent : NaN;
    const ascent = isFinite(rawAscent) && rawAscent > 0 && rawAscent < 2 ? rawAscent : 0.8;
    const fontAscent = fontSize * ascent;
    let left;
    let top;
    if (angle === 0) {
      left = tx[4];
      top = tx[5] - fontAscent;
    } else {
      left = tx[4] + fontAscent * Math.sin(angle);
      top = tx[5] - fontAscent * Math.cos(angle);
    }
    const scale = (viewport && isFinite(viewport.scale) ? viewport.scale : 0) || 1;
    const w = item && typeof item.width === 'number' && isFinite(item.width) ? item.width : 0;
    return { left: left, top: top, fontSize: fontSize, angle: angle, targetWidth: w * scale };
  }

  /* ================= 测量用离屏 canvas（懒建，避免工厂期副作用） ================= */

  let measureCtx = null;
  let measureCtxBroken = false;

  function getMeasureContext() {
    if (measureCtx || measureCtxBroken) return measureCtx;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 8;
      canvas.height = 8;
      measureCtx = canvas.getContext('2d');
      if (!measureCtx) measureCtxBroken = true;
    } catch (e) {
      measureCtxBroken = true;
      measureCtx = null;
    }
    return measureCtx;
  }

  /* ================= pdf.js 加载（模块级 Promise 缓存，只加载一次） ================= */

  /* 只负责 worker。CMap 相关参数（cMapUrl / cMapPacked）是 getDocument() 的参数，
   * 见下方加载流程里的 lib.getDocument({...})，不要塞进 GlobalWorkerOptions。 */
  function configurePdfJs(lib) {
    if (!lib) return;
    try {
      const opts = lib.GlobalWorkerOptions;
      if (opts && opts.workerSrc !== WORKER_SRC) opts.workerSrc = WORKER_SRC;
    } catch (e) {
      /* 设不上 worker 也能退化成 fake worker */
    }
  }

  function loadPdfJs() {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return Promise.reject(new Error('当前环境没有 window/document，无法预览 PDF'));
    }
    const cached = window[PDFJS_LIB_KEY];
    if (cached) {
      configurePdfJs(cached);
      return Promise.resolve(cached);
    }
    if (window[PDFJS_PROMISE_KEY]) return window[PDFJS_PROMISE_KEY];
    const previousLib = window.pdfjsLib || null;
    if (previousLib && previousLib.version === PDFJS_VERSION) {
      window[PDFJS_LIB_KEY] = previousLib;
      configurePdfJs(previousLib);
      return Promise.resolve(previousLib);
    }

    const promise = new Promise(function (resolve, reject) {
      let settled = false;
      let timer = 0;
      let poll = 0;

      function cleanupTimers() {
        if (timer) {
          clearTimeout(timer);
          timer = 0;
        }
        if (poll) {
          clearInterval(poll);
          poll = 0;
        }
      }

      function finish(err) {
        if (settled) return;
        settled = true;
        cleanupTimers();
        if (err) {
          reject(err);
          return;
        }
        const lib = window.pdfjsLib;
        if (previousLib && previousLib !== lib) window.pdfjsLib = previousLib;
        if (!lib) {
          reject(new Error('pdf.js 脚本已加载，但没有找到可用的库'));
          return;
        }
        if (lib.version && lib.version !== PDFJS_VERSION) {
          reject(new Error('pdf.js 版本不匹配：需要 ' + PDFJS_VERSION + '，实际为 ' + lib.version));
          return;
        }
        window[PDFJS_LIB_KEY] = lib;
        configurePdfJs(lib);
        resolve(lib);
      }

      // 没有可复用库时才轮询全局变量；异版本共存时只认自己脚本的 load 事件。
      poll = setInterval(function () {
        if (!previousLib && window.pdfjsLib) finish(null);
      }, 50);

      let script = null;
      try {
        script = document.querySelector('script[data-dm-pdfjs]');
      } catch (e) {
        script = null;
      }

      if (script) {
        script.addEventListener('load', function () {
          finish(null);
        });
        script.addEventListener('error', function () {
          finish(new Error('pdf.js 脚本加载失败：' + PDFJS_SRC));
        });
      } else {
        try {
          script = document.createElement('script');
          script.src = PDFJS_SRC;
          script.async = true;
          script.setAttribute('data-dm-pdfjs', '1');
          script.onload = function () {
            finish(null);
          };
          script.onerror = function () {
            finish(new Error('pdf.js 脚本加载失败：' + PDFJS_SRC));
          };
          (document.head || document.documentElement).appendChild(script);
        } catch (e) {
          finish(new Error('无法插入 pdf.js 脚本：' + (e && e.message ? e.message : e)));
          return;
        }
      }

      timer = setTimeout(function () {
        finish(new Error('加载 pdf.js 超时（' + Math.round(LOAD_TIMEOUT_MS / 1000) + ' 秒）'));
      }, LOAD_TIMEOUT_MS);
    });

    window[PDFJS_PROMISE_KEY] = promise;
    // 失败后允许重试（否则缓存住一个 rejected promise 就永久坏了）
    promise.catch(function () {
      if (window[PDFJS_PROMISE_KEY] === promise) window[PDFJS_PROMISE_KEY] = null;
    });
    return promise;
  }

  /* ================= 全文抽取（给「拖进来就让 AI 读全文」用） ================= */

  /* 把 pdf.js / 网络 / 解析错误包成一句可读中文；调用方 catch 后可以原样展示。 */
  function toExtractError(err) {
    const raw = formatError(err);
    const msg = raw.indexOf('抽取 PDF 全文失败') === 0 ? raw : '抽取 PDF 全文失败：' + raw;
    const wrapped = new Error(msg);
    try {
      wrapped.cause = err;
    } catch (e) {
      /* ignore */
    }
    return wrapped;
  }

  /* 抽取文本的轻量清洗：统一换行 → 去行尾空白 → 3 个以上连续换行压成 2 个 → trim。 */
  function cleanExtractedText(raw) {
    return String(raw == null ? '' : raw)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\u00a0]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * 抽取一份 PDF 的全文（纯文本），给「拖进来就让 AI 同步读全文」用。
   * @param {string} url  同源可 fetch 的地址（blob: 或 /api/docmate/...）
   * @returns {Promise<{ text: string, pages: number, chars: number }>}
   */
  async function extractText(url) {
    const target = typeof url === 'string' ? url.trim() : '';
    if (!target) throw new Error('抽取 PDF 全文失败：没有提供 PDF 地址');

    let lib;
    try {
      // 复用模块级加载缓存：不重复插 script，worker 配置也沿用 configurePdfJs 的。
      lib = await loadPdfJs();
    } catch (err) {
      throw toExtractError(err);
    }

    let task = null;
    let doc = null;
    try {
      try {
        // 参数与组件里的加载流程完全一致（cMap 是中文 / 日韩 PDF 的必需项）。
        task = lib.getDocument({ url: target, cMapUrl: CMAP_URL, cMapPacked: true });
        doc = await task.promise;
      } catch (err) {
        throw toExtractError(err);
      }

      const total = doc && doc.numPages > 0 ? Math.floor(doc.numPages) : 0;
      if (!total) throw new Error('抽取 PDF 全文失败：这个 PDF 没有任何页面');

      const blocks = [];
      let okPages = 0;
      let hasText = false;

      for (let n = 1; n <= total; n++) {
        let body = '';
        try {
          const page = await doc.getPage(n);
          const content = await page.getTextContent();
          const items = (content && content.items) || [];
          const parts = [];
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item || typeof item.str !== 'string') continue;
            parts.push(item.str);
            if (item.hasEOL) parts.push('\n');
          }
          body = cleanExtractedText(parts.join(''));
          try {
            if (typeof page.cleanup === 'function') page.cleanup();
          } catch (e) {
            /* 释放单页资源失败不影响结果 */
          }
        } catch (err) {
          // 单页失败不拖垮整份：留个占位，继续下一页
          blocks.push('--- 第 ' + n + ' 页（抽取失败）---');
          continue;
        }
        okPages += 1;
        if (body) hasText = true;
        blocks.push(body ? '--- 第 ' + n + ' 页 ---\n' + body : '--- 第 ' + n + ' 页 ---');
      }

      if (!okPages) throw new Error('抽取 PDF 全文失败：所有页面都抽取失败，请改用划线提问');
      if (!hasText) {
        throw new Error('抽取 PDF 全文失败：这篇 PDF 抽不出文字（可能是扫描版 / 纯图片），请改用划线提问');
      }

      // 页与页之间空一行；页码分隔行让 AI 能引用「第 N 页」，和划词提问对得上。
      const text = cleanExtractedText(blocks.join('\n\n'));
      return { text: text, pages: total, chars: text.length };
    } finally {
      // 成功失败都释放，否则 pdf.js 的 worker 内存会一直挂着
      if (doc && typeof doc.destroy === 'function') {
        try {
          await doc.destroy();
        } catch (e) {
          /* 释放失败不影响结果 */
        }
      } else if (task && typeof task.destroy === 'function') {
        try {
          await task.destroy();
        } catch (e) {
          /* ignore */
        }
      }
    }
  }

  /* ================= 错误 UI ================= */

  function renderErrorBox(message, onRetry) {
    return h(
      'div',
      { className: 'dm-pdf-error', role: 'alert' },
      h('div', { className: 'dm-pdf-error-title' }, 'PDF 打开失败'),
      h('div', { className: 'dm-pdf-error-msg' }, message || '未知错误'),
      onRetry
        ? h('button', { type: 'button', className: 'dm-pdf-error-retry', onClick: onRetry }, '重试')
        : null
    );
  }

  /* 渲染期兜底：即使正文组件 render 抛异常，也只降级成一块错误提示。 */
  function makeErrorBoundary() {
    const Base =
      (React && React.Component) ||
      class {
        constructor(props) {
          this.props = props;
          this.state = {};
        }
        setState(partial) {
          const next = typeof partial === 'function' ? partial(this.state, this.props) : partial;
          this.state = Object.assign({}, this.state, next || {});
        }
      };

    class PdfErrorBoundary extends Base {
      constructor(props) {
        super(props);
        this.state = { error: null };
        this.reset = this.reset.bind(this);
      }

      static getDerivedStateFromError(error) {
        return { error: error || new Error('未知渲染错误') };
      }

      componentDidCatch(error) {
        const cb = this.props && this.props.onError;
        if (typeof cb === 'function') {
          try {
            cb(error instanceof Error ? error : new Error(formatError(error)));
          } catch (e) {
            /* 回调自己抛错也不能冒泡 */
          }
        }
      }

      reset() {
        this.setState({ error: null });
      }

      render() {
        const err = this.state && this.state.error;
        if (err) return renderErrorBox(formatError(err), this.reset);
        return this.props ? this.props.children : null;
      }
    }

    return PdfErrorBoundary;
  }

  const PdfErrorBoundary = makeErrorBoundary();

  /* ================= 文本层 ================= */

  /* 自己算文本层：每段一个绝对定位 span，left/top 用百分比（相对页面宽高），
   * 字号用 transform 推出的 fontHeight，宽度用 measureText + scaleX 贴合。
   * 不用 pdf.js 的 TextLayer 类（版本差异大）。 */
  function buildTextLayer(pageEl, viewport, textContent) {
    if (!pageEl) return;
    const layer = pageEl.querySelector('.dm-pdf-text-layer');
    if (!layer) return;

    while (layer.firstChild) layer.removeChild(layer.firstChild);

    const items = (textContent && textContent.items) || [];
    const styles = (textContent && textContent.styles) || {};
    if (!items.length) return;

    const vw = viewport && viewport.width > 0 ? viewport.width : 1;
    const vh = viewport && viewport.height > 0 ? viewport.height : 1;
    const ctx = getMeasureContext();
    const frag = document.createDocumentFragment();
    const pending = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item.str !== 'string') continue;
      const str = item.str;
      const hasEOL = !!item.hasEOL;
      if (!str) {
        // 空串但换行：补一个 <br>，让跨行选中时 toString() 带换行
        if (hasEOL) frag.appendChild(document.createElement('br'));
        continue;
      }
      const style = styles[item.fontName] || {};
      const info = computeTextSpan(item, style, viewport);
      if (!(info.fontSize > 0)) continue;

      const span = document.createElement('span');
      span.textContent = str;
      const st = span.style;
      st.position = 'absolute';
      st.left = ((info.left / vw) * 100).toFixed(4) + '%';
      st.top = ((info.top / vh) * 100).toFixed(4) + '%';
      st.fontSize = info.fontSize.toFixed(3) + 'px';
      st.fontFamily = cssFontFamily(style.fontFamily);
      st.lineHeight = '1';
      st.whiteSpace = 'pre';
      st.transformOrigin = '0% 0%';
      st.color = 'transparent';
      st.cursor = 'text';
      st.userSelect = 'text';
      st.webkitUserSelect = 'text';
      st.margin = '0';
      st.padding = '0';
      st.border = '0';
      st.background = 'transparent';
      frag.appendChild(span);
      pending.push({
        span: span,
        text: str,
        fontFamily: st.fontFamily,
        fontSize: info.fontSize,
        angle: info.angle,
        targetWidth: info.targetWidth,
      });
      if (hasEOL) frag.appendChild(document.createElement('br'));
    }

    layer.appendChild(frag);

    // 先全部挂 DOM，再统一测量 + 写 transform，避免读写交错触发多次重排
    for (let k = 0; k < pending.length; k++) {
      const p = pending[k];
      let scaleX = 1;
      if (p.targetWidth > 0 && ctx) {
        try {
          ctx.font = p.fontSize + 'px ' + p.fontFamily;
          const measured = ctx.measureText(p.text).width;
          if (measured > 0.01) scaleX = p.targetWidth / measured;
        } catch (e) {
          scaleX = 1;
        }
        if (!isFinite(scaleX) || scaleX <= 0) scaleX = 1;
        scaleX = clamp(scaleX, 0.05, 20);
      }
      const parts = [];
      if (p.angle) parts.push('rotate(' + p.angle.toFixed(5) + 'rad)');
      if (Math.abs(scaleX - 1) > 0.002) parts.push('scaleX(' + scaleX.toFixed(4) + ')');
      if (parts.length) p.span.style.transform = parts.join(' ');
    }
  }

  /* ================= 组件主体 ================= */

  function PdfViewerInner(props) {
    const url = props && props.url ? String(props.url) : '';
    const onTextSelection = props ? props.onTextSelection : null;
    const onError = props ? props.onError : null;
    const onOutline = props ? props.onOutline : null;

    /* ---- state ---- */
    const [status, setStatus] = useState('loading'); // loading | ready | error
    const [errorMessage, setErrorMessage] = useState('');
    const [numPages, setNumPages] = useState(0);
    const [dims, setDims] = useState([]); // 每页 scale=1 时的 {width,height}
    const [page, setPage] = useState(1);
    const [pageInput, setPageInput] = useState('1');
    const [scale, setScale] = useState(1);
    const [fit, setFit] = useState(true);
    const [reloadKey, setReloadKey] = useState(0);
    const [pageErrors, setPageErrors] = useState({});

    /* ---- refs ---- */
    const containerRef = useRef(null);
    const inputRef = useRef(null);
    const docRef = useRef(null);
    const loadingTaskRef = useRef(null);
    const pagesRef = useRef(new Map()); // idx -> DOM
    const pageRefSetters = useRef(new Map()); // idx -> 稳定 ref callback
    const observerRef = useRef(null);
    const resizeObsRef = useRef(null);
    const tasksRef = useRef(new Map()); // idx -> renderTask
    const renderingRef = useRef(new Set());
    const renderedRef = useRef(new Map()); // idx -> 已渲染时的 scale
    const generationRef = useRef(0); // 缩放换代，作废在途渲染
    const aliveRef = useRef(true);
    const scaleRef = useRef(1);
    const fitRef = useRef(true);
    const totalRef = useRef(0);
    const pageRef = useRef(1);
    const baseDimsRef = useRef([]);
    const scrollRafRef = useRef(0);
    const lastErrorRef = useRef('');
    const propsRef = useRef({ onTextSelection: onTextSelection, onError: onError, onOutline: onOutline });

    /* 回调走 ref，避免异步流程拿到过期 props */
    useEffect(
      function () {
        propsRef.current.onTextSelection = onTextSelection;
        propsRef.current.onError = onError;
        propsRef.current.onOutline = onOutline;
      },
      [onTextSelection, onError, onOutline]
    );

    /* ---------------- 小工具 ---------------- */

    function swallow(p) {
      if (p && typeof p.then === 'function') {
        try {
          p.then(
            function () {},
            function () {}
          );
        } catch (e) {
          /* ignore */
        }
      }
    }

    function reportError(err, message) {
      const msg = message || formatError(err);
      if (lastErrorRef.current === msg) return;
      lastErrorRef.current = msg;
      const cb = propsRef.current.onError;
      if (typeof cb !== 'function') return;
      try {
        cb(err instanceof Error ? err : new Error(msg));
      } catch (e) {
        /* 回调自己抛错也不能冒泡 */
      }
    }

    function emitOutline(items) {
      const cb = propsRef.current.onOutline;
      if (typeof cb !== 'function') return;
      try {
        cb(items);
      } catch (e) {
        /* 目录回调失败不影响正文 */
      }
    }

    function fail(err) {
      const message = formatError(err);
      setErrorMessage(message);
      setStatus('error');
      reportError(err, message);
    }

    function cancelAllTasks() {
      tasksRef.current.forEach(function (task) {
        if (!task) return;
        try {
          if (typeof task.cancel === 'function') task.cancel();
        } catch (e) {
          /* ignore */
        }
        try {
          if (typeof task.destroy === 'function') task.destroy();
        } catch (e) {
          /* ignore */
        }
      });
      tasksRef.current.clear();
      renderingRef.current.clear();
      renderedRef.current.clear();
    }

    function teardown() {
      aliveRef.current = false;
      if (scrollRafRef.current) {
        try {
          cancelAnimationFrame(scrollRafRef.current);
        } catch (e) {
          /* ignore */
        }
        scrollRafRef.current = 0;
      }
      cancelAllTasks();
      if (observerRef.current) {
        try {
          observerRef.current.disconnect();
        } catch (e) {
          /* ignore */
        }
        observerRef.current = null;
      }
      if (resizeObsRef.current) {
        try {
          resizeObsRef.current.disconnect();
        } catch (e) {
          /* ignore */
        }
        resizeObsRef.current = null;
      }
      const doc = docRef.current;
      docRef.current = null;
      if (doc && typeof doc.destroy === 'function') {
        try {
          swallow(doc.destroy());
        } catch (e) {
          /* ignore */
        }
      } else {
        const task = loadingTaskRef.current;
        if (task && typeof task.destroy === 'function') {
          try {
            swallow(task.destroy());
          } catch (e) {
            /* ignore */
          }
        }
      }
      loadingTaskRef.current = null;
      pagesRef.current.clear();
      pageRefSetters.current.clear();
    }

    function getPageRefSetter(index) {
      let fn = pageRefSetters.current.get(index);
      if (fn) return fn;
      fn = function (el) {
        if (el) pagesRef.current.set(index, el);
        else pagesRef.current.delete(index);
      };
      pageRefSetters.current.set(index, fn);
      return fn;
    }

    /* ---------------- 缩放 ---------------- */

    function applyScale(next, isFit) {
      const wanted = clamp(next, MIN_SCALE, MAX_SCALE);
      const rounded = Math.round(wanted * 1000) / 1000;
      const changed = Math.abs(rounded - scaleRef.current) > 0.004;
      if (!changed && !!isFit === fitRef.current) return;
      scaleRef.current = rounded;
      fitRef.current = !!isFit;
      generationRef.current += 1;
      cancelAllTasks();
      setScale(rounded);
      setFit(!!isFit);
      setPageErrors({});
    }

    function computeFitScale() {
      const container = containerRef.current;
      const base = baseDimsRef.current && baseDimsRef.current[0];
      if (!container || !base || !(base.width > 0)) return 0;
      const avail = container.clientWidth - PAGE_GUTTER * 2;
      if (!(avail > 40)) return 0;
      return avail / base.width;
    }

    function applyFit() {
      const next = computeFitScale();
      if (!(next > 0)) return;
      // 2% 死区，避免滚动条出现/消失导致来回抖
      if (Math.abs(next - scaleRef.current) / Math.max(scaleRef.current, 0.001) < 0.02) return;
      applyScale(next, true);
    }

    function zoomBy(delta) {
      applyScale(scaleRef.current + delta, false);
    }

    /* ---------------- 渲染单页 ---------------- */

    function renderPage(index) {
      const doc = docRef.current;
      const pageEl = pagesRef.current.get(index);
      if (!doc || !pageEl) return;
      const currentScale = scaleRef.current;
      if (renderedRef.current.get(index) === currentScale) return;
      if (renderingRef.current.has(index)) return;

      const canvas = pageEl.querySelector('canvas.dm-pdf-canvas');
      if (!canvas) return;

      renderingRef.current.add(index);
      const generation = generationRef.current;

      doc
        .getPage(index + 1)
        .then(function (pdfPage) {
          if (!aliveRef.current || generation !== generationRef.current) return null;
          const viewport = pdfPage.getViewport({ scale: currentScale });
          const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, MAX_DPR);
          const pixelWidth = Math.max(1, Math.floor(viewport.width * dpr));
          const pixelHeight = Math.max(1, Math.floor(viewport.height * dpr));

          canvas.width = pixelWidth;
          canvas.height = pixelHeight;

          // 用真实页面尺寸回填占位高度，保证「div 尺寸 == 画布尺寸」
          const baseW = viewport.width / currentScale;
          const baseH = viewport.height / currentScale;
          const known = baseDimsRef.current[index];
          if (!known || Math.abs(known.width - baseW) > 0.5 || Math.abs(known.height - baseH) > 0.5) {
            baseDimsRef.current[index] = { width: baseW, height: baseH };
            setDims(baseDimsRef.current.slice());
          }

          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('浏览器不支持 canvas 2D 上下文');
          // 白底：不依赖 CSS 也能看清页面
          try {
            ctx.save();
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, pixelWidth, pixelHeight);
            ctx.restore();
          } catch (e) {
            /* ignore */
          }

          const params = { canvasContext: ctx, viewport: viewport };
          if (dpr !== 1) params.transform = [dpr, 0, 0, dpr, 0, 0];

          const task = pdfPage.render(params);
          tasksRef.current.set(index, task);

          return task.promise.then(function () {
            tasksRef.current.delete(index);
            if (!aliveRef.current || generation !== generationRef.current) return null;
            renderedRef.current.set(index, currentScale);
            return pdfPage.getTextContent().then(function (textContent) {
              if (!aliveRef.current || generation !== generationRef.current) return;
              try {
                buildTextLayer(pageEl, viewport, textContent);
              } catch (e) {
                /* 文本层失败不影响看图 */
              }
              try {
                if (typeof pdfPage.cleanup === 'function') pdfPage.cleanup();
              } catch (e) {
                /* ignore */
              }
            });
          });
        })
        .catch(function (err) {
          tasksRef.current.delete(index);
          if (!aliveRef.current || generation !== generationRef.current) return;
          if (isCancelError(err)) return;
          const msg = formatError(err);
          setPageErrors(function (prev) {
            const next = Object.assign({}, prev);
            next[index] = msg;
            return next;
          });
        })
        .then(function () {
          renderingRef.current.delete(index);
        });
    }

    function isNearViewport(el, container) {
      if (!el || !container) return false;
      const cRect = container.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.bottom >= cRect.top - PRELOAD_PX && r.top <= cRect.bottom + PRELOAD_PX;
    }

    function rerenderVisible() {
      const container = containerRef.current;
      if (!container) return;
      pagesRef.current.forEach(function (el, idx) {
        if (isNearViewport(el, container)) renderPage(idx);
      });
    }

    /* ---------------- 页码 / 滚动 ---------------- */

    function scrollToPage(n) {
      const el = pagesRef.current.get(n - 1);
      const container = containerRef.current;
      if (!el || !container) return;
      try {
        const cRect = container.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        container.scrollTop += r.top - cRect.top - PAGE_GUTTER;
      } catch (e) {
        /* ignore */
      }
    }

    function goToPage(n) {
      const total = totalRef.current || 1;
      let target = Math.round(Number(n));
      if (!isFinite(target)) target = pageRef.current;
      target = Math.min(Math.max(1, target), total);
      pageRef.current = target;
      setPage(target);
      setPageInput(String(target));
      scrollToPage(target);
      renderPage(target - 1);
    }

    function handleScroll() {
      if (scrollRafRef.current) return;
      const raf =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : function (fn) {
              return setTimeout(fn, 16);
            };
      scrollRafRef.current = raf(function () {
        scrollRafRef.current = 0;
        const container = containerRef.current;
        if (!container) return;
        let best = pageRef.current;
        let bestDist = Infinity;
        const cRect = container.getBoundingClientRect();
        pagesRef.current.forEach(function (el, idx) {
          if (!el) return;
          const r = el.getBoundingClientRect();
          if (r.bottom <= cRect.top + 1 || r.top >= cRect.bottom) return;
          const dist = Math.abs(r.top - cRect.top);
          if (dist < bestDist) {
            bestDist = dist;
            best = idx + 1;
          }
        });
        if (best !== pageRef.current) {
          pageRef.current = best;
          setPage(best);
          const input = inputRef.current;
          const focused = typeof document !== 'undefined' && document.activeElement === input;
          if (!focused) setPageInput(String(best));
        }
      });
    }

    function handlePageInputChange(event) {
      const raw = event && event.target ? String(event.target.value || '') : '';
      setPageInput(raw.replace(/[^\d]/g, '').slice(0, 6));
    }

    function commitPageInput() {
      const n = parseInt(pageInput, 10);
      if (!isFinite(n) || n < 1) {
        setPageInput(String(pageRef.current));
        return;
      }
      goToPage(n);
    }

    function handlePageInputKeyDown(event) {
      if (!event) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        commitPageInput();
      } else if (event.key === 'Escape') {
        setPageInput(String(pageRef.current));
      }
    }

    /* ---------------- 划词 ---------------- */

    function handleMouseUp() {
      try {
        const container = containerRef.current;
        if (!container) return;
        const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        const anchor = sel.anchorNode;
        if (!anchor || !container.contains(anchor)) return;
        const raw = String(sel.toString() || '').trim();
        if (!raw) return;
        const text = raw.length > MAX_SELECTION_CHARS ? raw.slice(0, MAX_SELECTION_CHARS) : raw;

        let pageNumber = 0;
        let node = anchor.nodeType === 3 ? anchor.parentNode : anchor;
        while (node && node !== container) {
          if (node.nodeType === 1 && node.getAttribute) {
            const attr = node.getAttribute('data-page');
            if (attr) {
              const n = parseInt(attr, 10);
              if (n > 0) {
                pageNumber = n;
                break;
              }
            }
          }
          node = node.parentNode;
        }
        if (!pageNumber) pageNumber = pageRef.current || 1;

        const cb = propsRef.current.onTextSelection;
        if (typeof cb === 'function') cb({ text: text, page: pageNumber });
      } catch (e) {
        /* 划词处理绝不冒泡 */
      }
    }

    /* ---------------- 每页尺寸预扫（≤100 页） ---------------- */

    function refinePageDims(doc, list) {
      const total = list.length;
      if (total <= 1 || total > EAGER_DIMS_PAGES) return;
      let cursor = 1;
      const step = function () {
        if (!aliveRef.current || docRef.current !== doc) return;
        if (cursor >= total) {
          setDims(list.slice());
          return;
        }
        const batch = [];
        for (let k = 0; k < 8 && cursor < total; k++) {
          batch.push(cursor);
          cursor += 1;
        }
        Promise.all(
          batch.map(function (idx) {
            return doc
              .getPage(idx + 1)
              .then(function (p) {
                const v = p.getViewport({ scale: 1 });
                list[idx] = { width: v.width, height: v.height };
              })
              .catch(function () {
                /* 单页拿不到尺寸就沿用首页尺寸 */
              });
          })
        ).then(function () {
          if (!aliveRef.current || docRef.current !== doc) return;
          setDims(list.slice());
          step();
        });
      };
      step();
    }

    /* ---------------- 加载 / 卸载 ---------------- */

    useEffect(
      function () {
        emitOutline([]);
        if (!url) {
          setErrorMessage('未提供 PDF 地址');
          setStatus('error');
          return undefined;
        }

        let cancelled = false;
        aliveRef.current = true;
        lastErrorRef.current = '';

        // 重置
        setStatus('loading');
        setErrorMessage('');
        setNumPages(0);
        setDims([]);
        setPage(1);
        setPageInput('1');
        setPageErrors({});
        pageRef.current = 1;
        totalRef.current = 0;
        baseDimsRef.current = [];
        scaleRef.current = 1;
        fitRef.current = true;
        setScale(1);
        setFit(true);
        generationRef.current += 1;
        cancelAllTasks();

        loadPdfJs()
          .then(function (lib) {
            if (cancelled) return null;
            const task = lib.getDocument({
              url: url,
              // 中文 / 日韩 PDF 的 CMap：Host 半按子路径投送 assets/pdfjs/cmaps/*.bcmap
              cMapUrl: CMAP_URL,
              cMapPacked: true,
              // standardFontDataUrl 故意不设：assets/pdfjs/ 下没有 standard_fonts/，
              // 交给 pdf.js 用内置兜底（缺字体只会影响字形，不会让整篇打不开）。
            });
            loadingTaskRef.current = task;
            return task.promise;
          })
          .then(function (doc) {
            if (!doc) return null;
            if (cancelled) {
              try {
                swallow(doc.destroy());
              } catch (e) {
                /* ignore */
              }
              return null;
            }
            docRef.current = doc;
            readOutline(doc).then(
              function (items) {
                if (!cancelled && docRef.current === doc) emitOutline(items);
              },
              function () {
                if (!cancelled && docRef.current === doc) emitOutline([]);
              }
            );
            const total = doc.numPages || 0;
            totalRef.current = total;
            if (!total) throw new Error('这个 PDF 没有任何页面');
            return doc.getPage(1).then(function (firstPage) {
              if (cancelled) return null;
              const vp = firstPage.getViewport({ scale: 1 });
              const base = { width: vp.width, height: vp.height };
              const list = new Array(total);
              for (let i = 0; i < total; i++) list[i] = base;
              baseDimsRef.current = list;
              if (cancelled) return null;
              setNumPages(total);
              setDims(list);
              setStatus('ready');
              refinePageDims(doc, list);
              return null;
            });
          })
          .catch(function (err) {
            if (cancelled) return;
            fail(err);
          });

        return function () {
          cancelled = true;
          teardown();
        };
      },
      [url, reloadKey]
    );

    /* 文档就绪：先适应宽度，再渲染首屏 */
    useEffect(
      function () {
        if (status !== 'ready' || !numPages) return;
        if (fitRef.current) applyFit();
        renderPage(0);
        rerenderVisible();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      },
      [status, numPages]
    );

    /* 缩放变化：作废旧渲染后重画可见页 */
    useEffect(
      function () {
        if (!totalRef.current) return;
        rerenderVisible();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      },
      [scale]
    );

    /* 懒渲染观察器 */
    useEffect(
      function () {
        if (status !== 'ready' || !numPages) return undefined;
        const container = containerRef.current;
        if (!container) return undefined;

        if (typeof IntersectionObserver === 'undefined') {
          // 没有 IO 就退化成「渲染前 3 页」
          for (let i = 0; i < Math.min(3, numPages); i++) renderPage(i);
          return undefined;
        }

        const observer = new IntersectionObserver(
          function (entries) {
            for (let i = 0; i < entries.length; i++) {
              const entry = entries[i];
              if (!entry || !entry.isIntersecting) continue;
              const raw = entry.target.getAttribute('data-page');
              const n = raw ? parseInt(raw, 10) : 0;
              if (n > 0) renderPage(n - 1);
            }
          },
          { root: container, rootMargin: PRELOAD_PX + 'px 0px', threshold: 0 }
        );
        observerRef.current = observer;
        pagesRef.current.forEach(function (el) {
          if (el) observer.observe(el);
        });

        return function () {
          try {
            observer.disconnect();
          } catch (e) {
            /* ignore */
          }
          if (observerRef.current === observer) observerRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      },
      [status, numPages]
    );

    /* 外部要求翻到某一页（划线与目录跳转用）：pageJump 带页码和 nonce，nonce 变一次翻一次 */
    useEffect(
      function () {
        const jump = props && props.pageJump;
        if (!jump || !jump.page) return;
        if (status !== 'ready') return;
        goToPage(jump.page);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      },
      [status, props && props.pageJump ? props.pageJump.nonce : 0]
    );

    /* 容器尺寸变化：适应宽度模式下重算 */
    useEffect(
      function () {
        const container = containerRef.current;
        if (!container || typeof ResizeObserver === 'undefined') return undefined;
        let raf = 0;
        const ro = new ResizeObserver(function () {
          if (raf) return;
          raf = requestAnimationFrame(function () {
            raf = 0;
            if (fitRef.current) applyFit();
          });
        });
        try {
          ro.observe(container);
        } catch (e) {
          return undefined;
        }
        resizeObsRef.current = ro;
        return function () {
          if (raf) {
            try {
              cancelAnimationFrame(raf);
            } catch (e) {
              /* ignore */
            }
          }
          try {
            ro.disconnect();
          } catch (e) {
            /* ignore */
          }
          if (resizeObsRef.current === ro) resizeObsRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      },
      []
    );

    /* ---------------- 渲染 ---------------- */

    /* 页列表单独 memo：滚动时 page 变化只重画工具条，不重建 N 个页面 div。
     * 注意必须放在任何提前 return 之前，保证 hook 调用顺序恒定。 */
    const pagesNode = useMemo(
      function () {
        if (status !== 'ready' || !numPages) return null;
        const pages = [];
        for (let i = 0; i < numPages; i++) {
          const d = (dims && dims[i]) || (dims && dims[0]) || DEFAULT_PAGE_DIMS;
          const w = d.width * scale;
          const hgt = d.height * scale;
          pages.push(
            h(
              'div',
              {
                key: i,
                className: 'dm-pdf-page',
                'data-page': i + 1,
                ref: getPageRefSetter(i),
                style: {
                  position: 'relative',
                  flex: '0 0 auto',
                  overflow: 'hidden',
                  background: '#ffffff',
                  width: w,
                  height: hgt,
                },
              },
              h('canvas', {
                className: 'dm-pdf-canvas',
                style: {
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  zIndex: 1,
                  display: 'block',
                  width: w,
                  height: hgt,
                },
              }),
              h('div', {
                className: 'dm-pdf-text-layer',
                style: {
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  zIndex: 2,
                  overflow: 'hidden',
                  width: w,
                  height: hgt,
                },
              }),
              pageErrors[i]
                ? h(
                    'div',
                    {
                      className: 'dm-pdf-page-error',
                      style: {
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                        zIndex: 3,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '12px',
                        textAlign: 'center',
                      },
                    },
                    pageErrors[i]
                  )
                : null
            )
          );
        }
        return h(
          'div',
          {
            className: 'dm-pdf-pages',
            style: {
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: PAGE_GUTTER,
              padding: PAGE_GUTTER,
            },
          },
          pages
        );
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [status, numPages, dims, scale, pageErrors]
    );

    if (status === 'error') {
      return renderErrorBox(errorMessage, function () {
        setReloadKey(function (k) {
          return k + 1;
        });
      });
    }

    const toolbar = h(
      'div',
      { className: 'dm-pdf-toolbar' },
      h(
        'button',
        {
          type: 'button',
          className: 'dm-pdf-btn',
          title: '上一页',
          'aria-label': '上一页',
          disabled: status !== 'ready' || page <= 1,
          onClick: function () {
            goToPage(pageRef.current - 1);
          },
        },
        '‹'
      ),
      h(
        'span',
        { className: 'dm-pdf-pageinfo' },
        h('input', {
          ref: inputRef,
          className: 'dm-pdf-page-input',
          type: 'text',
          inputMode: 'numeric',
          value: pageInput,
          'aria-label': '页码',
          disabled: status !== 'ready',
          onChange: handlePageInputChange,
          onKeyDown: handlePageInputKeyDown,
          onBlur: commitPageInput,
        }),
        h('span', { className: 'dm-pdf-page-total' }, '/ ' + (numPages || 1))
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'dm-pdf-btn',
          title: '下一页',
          'aria-label': '下一页',
          disabled: status !== 'ready' || page >= numPages,
          onClick: function () {
            goToPage(pageRef.current + 1);
          },
        },
        '›'
      ),
      h('span', { className: 'dm-pdf-sep' }),
      h(
        'button',
        {
          type: 'button',
          className: 'dm-pdf-btn',
          title: '缩小',
          'aria-label': '缩小',
          disabled: status !== 'ready',
          onClick: function () {
            zoomBy(-ZOOM_STEP);
          },
        },
        '−'
      ),
      h('span', { className: 'dm-pdf-zoom-label' }, Math.round(scale * 100) + '%'),
      h(
        'button',
        {
          type: 'button',
          className: 'dm-pdf-btn',
          title: '放大',
          'aria-label': '放大',
          disabled: status !== 'ready',
          onClick: function () {
            zoomBy(ZOOM_STEP);
          },
        },
        '+'
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'dm-pdf-btn' + (fit ? ' dm-pdf-btn-active' : ''),
          title: '适应宽度',
          'aria-label': '适应宽度',
          disabled: status !== 'ready',
          onClick: function () {
            applyFit();
          },
        },
        '适应宽度'
      )
    );

    const notice =
      numPages > LARGE_DOC_PAGES
        ? h(
            'div',
            { className: 'dm-pdf-notice' },
            '文档共 ' + numPages + ' 页，已启用按需渲染（滚动到哪页渲染哪页）。'
          )
        : null;

    const body = status === 'loading' ? h('div', { className: 'dm-pdf-loading' }, '正在加载 PDF…') : pagesNode;

    return h(
      'div',
      {
        className: 'dm-pdf-root',
        style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' },
      },
      toolbar,
      notice,
      h(
        'div',
        {
          className: 'dm-pdf-scroll',
          ref: containerRef,
          onMouseUp: handleMouseUp,
          onScroll: handleScroll,
          style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', position: 'relative' },
        },
        body
      )
    );
  }

  /* ================= 对外组件 ================= */

  function PdfViewer(props) {
    const safe = props || {};
    return h(PdfErrorBoundary, { onError: safe.onError }, h(PdfViewerInner, safe));
  }

  /* _test 只给 node 单测用，宿主代码请忽略。 */
  return {
    PdfViewer: PdfViewer,
    extractText: extractText,
    _test: {
      clamp: clamp,
      mulTransform: mulTransform,
      formatError: formatError,
      isCancelError: isCancelError,
      computeTextSpan: computeTextSpan,
      cssFontFamily: cssFontFamily,
      readOutline: readOutline,
    },
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createPdfViewer };
