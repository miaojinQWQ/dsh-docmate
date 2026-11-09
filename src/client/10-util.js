/* ===== 10-util.js ===== */
/**
 * Small shared helpers. Everything here is a pure function or a tiny wrapper around
 * browser APIs; the module factory returns them as one object so later fragments can
 * destructure what they need.
 */
function createUtil(React) {
  const h = React.createElement;

  /** `cx('a', cond && 'b')` → 'a b' */
  function cx() {
    const out = [];
    for (let i = 0; i < arguments.length; i += 1) {
      const value = arguments[i];
      if (value) out.push(value);
    }
    return out.join(' ');
  }

  /** Join a POSIX-ish relative path with a segment. */
  function joinPath(base, name) {
    if (!base) return name;
    return base.endsWith('/') ? base + name : base + '/' + name;
  }

  function dirName(p) {
    if (!p) return '';
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }

  function baseName(p) {
    if (!p) return '';
    const i = p.lastIndexOf('/');
    return i < 0 ? p : p.slice(i + 1);
  }

  function extOf(p) {
    const name = baseName(p);
    const i = name.lastIndexOf('.');
    return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
  }

  function stripExt(p) {
    const name = baseName(p);
    const i = name.lastIndexOf('.');
    return i <= 0 ? name : name.slice(0, i);
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /** Clamp a number into [min, max]. */
  function clamp(value, min, max) {
    if (!isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  /** Read a JSON value from localStorage without ever throwing. */
  function lsGet(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      /* private mode / quota — the panel still works, it just forgets */
    }
  }

  function lsDel(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      /* ignore */
    }
  }

  /**
   * One JSON round-trip against our own Host routes.
   *
   * The Host answers with `{ ok: true, ... }` or `{ ok: false, error: { code, message } }`;
   * anything else (a proxy page, a 404 from a stale profile) becomes a readable failure so
   * callers never have to render `undefined`.
   */
  async function api(pathname, options) {
    const opts = options || {};
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (opts.signal) init.signal = opts.signal;
    let response;
    try {
      response = await fetch(API + pathname, init);
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      throw new Error('连不上 DocMate 的 Host 半：' + String((error && error.message) || error));
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }
    if (!response.ok || !payload || payload.ok !== true) {
      const reason =
        (payload && payload.error && payload.error.message) ||
        (payload && payload.message) ||
        'HTTP ' + response.status;
      const failure = new Error(reason);
      failure.code = (payload && payload.error && payload.error.code) || 'http-' + response.status;
      throw failure;
    }
    return payload;
  }

  /** A stable, readable key for a selection. */
  function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  /** Collapse runs of whitespace so a selection reads like one line in a chip. */
  function oneLine(text, max) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (!max || flat.length <= max) return flat;
    return flat.slice(0, max - 1) + '…';
  }

  /** Fire `fn` at most once per `wait` ms. Returns a function with `.cancel()`. */
  function debounce(fn, wait) {
    let timer = 0;
    function wrapped() {
      const args = arguments;
      const self = this;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        fn.apply(self, args);
      }, wait);
    }
    wrapped.cancel = () => {
      if (timer) window.clearTimeout(timer);
      timer = 0;
    };
    return wrapped;
  }

  /** A tiny inline glyph set — original 16px strokes, inherits `currentColor`. */
  function Icon(props) {
    const name = props.name;
    const size = props.size || 16;
    const common = {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: props.strokeWidth || 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      className: props.className,
    };
    const paths = {
      book: ['M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5Z', 'M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5'],
      folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
      file: ['M6 3h8l4 4v14H6Z', 'M14 3v4h4'],
      chevron: ['M9 6l6 6-6 6'],
      search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'M21 21l-4.3-4.3'],
      refresh: ['M20 12a8 8 0 1 1-2.3-5.6', 'M20 4v5h-5'],
      quote: ['M7 7h4v6H7a3 3 0 0 0 3 3', 'M15 7h4v6h-4a3 3 0 0 0 3 3'],
      send: ['M4 12l16-8-6 16-2.5-6.5Z'],
      close: ['M6 6l12 12', 'M18 6L6 18'],
      spark: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z'],
      plus: ['M12 5v14', 'M5 12h14'],
      minus: ['M5 12h14'],
      fit: ['M4 9V4h5', 'M20 15v5h-5', 'M4 15v5h5', 'M20 9V4h-5'],
      left: ['M15 6l-6 6 6 6'],
      right: ['M9 6l6 6-6 6'],
      doc: ['M7 3h7l4 4v14H7Z', 'M10 12h7', 'M10 16h7'],
      panel: ['M4 5h16v14H4Z', 'M10 5v14'],
      layout: ['M3 5h18v14H3Z', 'M9 5v14', 'M15 5v14'],
      message: ['M4 5h16v11H9l-5 4Z', 'M8 9h8', 'M8 12h5'],
      more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
      list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
      crop: ['M6 2v14a2 2 0 0 0 2 2h14', 'M2 6h14a2 2 0 0 1 2 2v14'],
      external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5H5V6h5'],
    };
    const d = paths[name] || paths.file;
    return h(
      'svg',
      common,
      d.map((segment, index) => h('path', { key: index, d: segment })),
    );
  }

  /**
   * A minimal error boundary. A throwing child would otherwise blank the whole slot entry
   * (the framework only logs `slot entry crashed`), so each column gets its own fence and
   * the rest of the panel keeps working.
   */
  function makeBoundary(label) {
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[docmate] ' + label + ' 崩了：', error, info);
        }
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'dm-error', style: { margin: '16px' } },
            h('div', { className: 'dm-error__title' }, label + ' 渲染失败'),
            h('div', null, String((this.state.error && this.state.error.message) || this.state.error)),
            h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dm-text-3)' } }, '其余区域仍可用。'),
          );
        }
        return this.props.children;
      }
    }
    return Boundary;
  }

  return {
    h,
    cx,
    joinPath,
    dirName,
    baseName,
    extOf,
    stripExt,
    formatBytes,
    clamp,
    lsGet,
    lsSet,
    lsDel,
    api,
    hashText,
    oneLine,
    debounce,
    Icon,
    makeBoundary,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createUtil };
