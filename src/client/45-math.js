/* ===== 45-math.js ===== */
/**
 * 数学公式排版：把 markdown 渲染器留下的 `[data-tex]` 占位（行内 span.dm-md-math /
 * 块级 div.dm-md-math-block）交给 KaTeX 真正排出来。
 *
 * 为什么是「渲染后补一遍 DOM」而不是在渲染器里直接出 HTML：
 *  - `30-markdown.js` 保持纯函数（81 组单测不依赖 DOM / 不依赖 KaTeX 是否加载）；
 *  - KaTeX 是 277 KB 的运行时，只在真的出现公式时才拉；
 *  - 没拉到（离线、资源缺失）时，占位里的等宽原文仍然可读，只是不漂亮。
 *
 * 样式和字体由宿主前端自带（它自己也用 KaTeX 渲染对话里的公式），这里只补几条
 * 兜底规则，宿主换版本时最多退化成衬线体，不会排版崩掉。
 *
 * Exposed as `createMath(util) -> { ensure, renderIn, engine }`.
 */
function createMath(util) {
  const SRC = '/api/docmate/asset/katex/katex.min.js';

  let loading = null;
  let broken = false;

  /** 已经挂上来的 KaTeX；没有就返回 null（绝不抛）。 */
  function engine() {
    if (typeof window === 'undefined') return null;
    const katex = window.katex;
    return katex && typeof katex.render === 'function' ? katex : null;
  }

  /** 只拉一次脚本；失败后不再重试，调用方按「没有公式引擎」降级。 */
  function ensure() {
    const ready = engine();
    if (ready) return Promise.resolve(ready);
    if (broken) return Promise.reject(new Error('KaTeX 不可用'));
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SRC;
      script.async = true;
      script.setAttribute('data-dsh-docmate', 'katex');
      script.onload = () => {
        const katex = engine();
        if (katex) resolve(katex);
        else {
          broken = true;
          reject(new Error('KaTeX 加载后没有挂到 window 上'));
        }
      };
      script.onerror = () => {
        broken = true;
        reject(new Error('KaTeX 脚本加载失败'));
      };
      document.head.appendChild(script);
    });
    loading.catch(() => {
      loading = null;
    });
    return loading;
  }

  /**
   * 把 root 里还没排过的 `[data-tex]` 全部排出来。幂等：排过的打 `data-tex-done`，
   * 所以可以在每次 React 渲染后无脑调用，代价只是多一次 querySelectorAll。
   * @returns 本次真的排出来的公式数
   */
  function renderIn(root) {
    const katex = engine();
    if (!root || !katex || typeof root.querySelectorAll !== 'function') return 0;
    const nodes = root.querySelectorAll('[data-tex]:not([data-tex-done])');
    let count = 0;
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const tex = node.getAttribute('data-tex') || '';
      if (!tex.trim()) {
        node.setAttribute('data-tex-done', 'empty');
        continue;
      }
      const display = node.classList.contains('dm-md-math-block');
      try {
        katex.render(tex, node, {
          displayMode: display,
          throwOnError: false,
          strict: false,
          trust: false,
        });
        node.setAttribute('data-tex-done', '1');
        node.classList.add('dm-math-on');
        count += 1;
      } catch (error) {
        /* 排不出来就保留等宽原文，比空白强 */
        node.setAttribute('data-tex-done', 'error');
      }
    }
    return count;
  }

  return { ensure, renderIn, engine };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createMath };
