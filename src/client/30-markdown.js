/* ===== 30-markdown.js ===== */
/* 模块 A —— Markdown 渲染（唯一契约：CONTRACT.md §3）
 *
 *   createMarkdown(React) -> { Markdown, parseMarkdown }
 *
 * - 只用 React.createElement，不用 JSX，不注入原始 HTML（一切走 React 元素）。
 * - parseMarkdown(source) 是纯函数：返回块级 AST 数组。
 * - 任何畸形输入都不抛异常，最差降级成纯文本段落。
 * - 只依赖参数 React，不引用本包其它片段里的任何变量。
 *
 * 块级 AST：
 *   { type:'heading', level:1..6, children:inline[] }
 *   { type:'paragraph', children:inline[] }
 *   { type:'code', lang:string, code:string }
 *   { type:'hr' }
 *   { type:'blockquote', children:block[] }
 *   { type:'callout', kind:string, fold:''|'+'|'-', title:inline[], blocks:block[] }
 *   { type:'list', ordered:boolean, start:number, items:listItem[] }
 *   { type:'listItem', checked:true|false|null, blocks:block[] }
 *   { type:'table', align:(null|'left'|'center'|'right')[],
 *     header:inline[][], rows:inline[][][] }
 *   { type:'frontmatter', data:{k:string|string[]}, raw:string }
 *   { type:'mathBlock', tex:string }
 * 行内 AST：
 *   { type:'text', value } | { type:'br' } | { type:'code', value }
 *   { type:'strong'|'em'|'del'|'mark', children:inline[] }
 *   { type:'link', href, title?, children:inline[] }
 *   { type:'image', src, alt }
 *   { type:'wikilink', target, anchor, label }
 *   { type:'embed', target, label }
 *   { type:'tag', name }
 *   { type:'math', tex, display:boolean }
 *   { type:'comment' }            // Obsidian %% 注释，不渲染
 *
 * Obsidian 方言（本模块额外支持）：
 *   YAML frontmatter / > [!type] callout（含 +/- 折叠标记）/ [[wikilink]] /
 *   ![[embed]] / ==highlight== / #tag / %%comment%% / $行内公式$ / $$块级公式$$
 *
 * 图片：<img> 加载失败（onError）时换成 dm-md-img-missing 占位块（相对路径图片
 * 常常不随文档导入，避免浏览器碎图标）。外链图片正常显示，失败也走同一占位。
 * 公式：不接 KaTeX，只去掉 $ / $$ 定界符并把原文放进 data-tex（CSS 用等宽字体）。
 *
 * class 清单（dm-md-*，CSS 由 Lead 统一写；本文件只保证 class 稳定）：
 *   根：dm-md
 *   块：dm-md-h1..h6 dm-md-p dm-md-ul dm-md-ol dm-md-li dm-md-task dm-md-task-done
 *       dm-md-checkbox dm-md-quote dm-md-pre dm-md-code dm-md-hr
 *       dm-md-table dm-md-thead dm-md-tbody dm-md-tr dm-md-th dm-md-td
 *       dm-md-align-left|center|right
 *   行内：dm-md-strong dm-md-em dm-md-del dm-md-code-inline dm-md-a dm-md-img dm-md-br
 *   Obsidian 新增：
 *     dm-md-meta is-open dm-md-meta__item dm-md-meta__key
 *     dm-md-meta__value dm-md-meta__tag dm-md-meta__hint
 *     dm-md-callout dm-md-callout--<kind> dm-md-callout--blue|green|yellow|red|gray
 *     dm-md-callout--foldable dm-md-callout--folded
 *     dm-md-callout__title dm-md-callout__body
 *     dm-md-wikilink dm-md-embed dm-md-mark dm-md-tag
 *   图片占位（加载失败）：
 *     dm-md-img-missing dm-md-img-missing__icon dm-md-img-missing__name
 *     dm-md-img-missing__hint
 *   公式（无排版引擎的降级）：
 *     dm-md-math dm-md-math--display（行内出现的 $$..$$ 降级）dm-md-math-block
 *     data-tex 属性 = 去掉定界符后的原文
 */
function createMarkdown(React) {
  const h = React.createElement;

  const MAX_INLINE_DEPTH = 24;
  const MAX_BLOCK_DEPTH = 16;
  const SCAN_BUDGET = 5000000;
  const PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

  /* Obsidian callout：类型 → 5 组配色；无标题时用的中文默认名 */
  const CALLOUT_GROUPS = {
    info: 'blue', todo: 'blue',
    tip: 'green', success: 'green', check: 'green',
    warning: 'yellow', caution: 'yellow', attention: 'yellow',
    danger: 'red', error: 'red', failure: 'red', bug: 'red',
    note: 'gray', quote: 'gray', cite: 'gray',
  };
  const CALLOUT_NAMES = {
    info: '信息', note: '笔记', tip: '提示', warning: '注意',
    danger: '危险', todo: '待办', quote: '引用', success: '完成',
  };
  /* 这些 #xxx 是 C 预处理指令，不该被当成 Obsidian 标签（#include 等） */
  const TAG_BLOCKLIST = {
    include: 1, define: 1, ifdef: 1, ifndef: 1, endif: 1, pragma: 1,
    'import': 1, undef: 1, elif: 1, error: 1, line: 1, region: 1, endregion: 1,
  };

  /* 属性条折叠状态需要 hooks；万一宿主 React 没有 useState 就退化成静态条 */
  const useState = (React && typeof React.useState === 'function')
    ? function (initial) { return React.useState(initial); }
    : function (initial) { return [initial, function () {}]; };

  /* 扫描预算：防止病态输入（成千上万个 * / ` / [）退化成 O(n^2) 卡死。
   * 每次 parseMarkdown 开头重置；纯函数语义不受影响（同步单线程，无重入）。 */
  let scanBudget = SCAN_BUDGET;

  function tick() {
    scanBudget -= 1;
    return scanBudget > 0;
  }

  /* ---------------- 基础小工具 ---------------- */

  function isBlank(line) {
    return typeof line !== 'string' || /^[ \t]*$/.test(line);
  }

  function indentOf(line) {
    let n = 0;
    for (let i = 0; i < line.length; i += 1) {
      const c = line.charCodeAt(i);
      if (c === 32) n += 1;
      else if (c === 9) n += 4;
      else break;
    }
    return n;
  }

  function stripIndent(line, count) {
    let removed = 0;
    let i = 0;
    while (i < line.length && removed < count) {
      const c = line.charCodeAt(i);
      if (c === 32) { removed += 1; i += 1; }
      else if (c === 9) { removed += 4; i += 1; }
      else break;
    }
    return line.slice(i);
  }

  function isEscapable(ch) {
    return typeof ch === 'string' && ch.length === 1 && PUNCT.indexOf(ch) >= 0;
  }

  function safeText(value) {
    return typeof value === 'string' ? value : (value == null ? '' : String(value));
  }

  /* ---------------- 块级识别 ---------------- */

  function matchFence(line) {
    const m = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(line);
    if (!m) return null;
    if (m[1].charAt(0) === '`' && m[2].indexOf('`') >= 0) return null;
    return { ch: m[1].charAt(0), len: m[1].length, info: m[2].trim() };
  }

  function isClosingFence(line, fence) {
    const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (!m) return false;
    return m[1].charAt(0) === fence.ch && m[1].length >= fence.len;
  }

  function matchHeading(line) {
    const m = /^ {0,3}(#{1,6})([ \t]+|$)(.*)$/.exec(line);
    if (!m) return null;
    let text = m[3] || '';
    text = text.replace(/[ \t]+#+[ \t]*$/, '');
    return { level: m[1].length, text: text.trim() };
  }

  function isHr(line) {
    const t = line.replace(/^ {0,3}/, '').replace(/[ \t]+$/, '');
    if (t.length < 3) return false;
    const c = t.charAt(0);
    if (c !== '-' && c !== '*' && c !== '_') return false;
    let count = 0;
    for (let i = 0; i < t.length; i += 1) {
      const ch = t.charAt(i);
      if (ch === c) count += 1;
      else if (ch !== ' ' && ch !== '\t') return false;
    }
    return count >= 3;
  }

  function isQuoteLine(line) {
    return /^ {0,3}>/.test(line);
  }

  function stripQuote(line) {
    return line.replace(/^ {0,3}> ?/, '');
  }

  function splitTableRow(line) {
    let s = safeText(line).trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.length > 0 && s.charAt(s.length - 1) === '|') {
      let bs = 0;
      let p = s.length - 2;
      while (p >= 0 && s.charAt(p) === '\\') { bs += 1; p -= 1; }
      if (bs % 2 === 0) s = s.slice(0, -1);
    }
    const cells = [];
    let cur = '';
    let wikiNoClose = false;
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charAt(i);
      if (c === '\\' && s.charAt(i + 1) === '|') { cur += '|'; i += 1; continue; }
      /* Obsidian：[[笔记|别名]] 里的竖线不是列分隔符 */
      if (!wikiNoClose && c === '[' && s.charAt(i + 1) === '[') {
        const close = s.indexOf(']]', i + 2);
        if (close >= 0) { cur += s.slice(i, close + 2); i = close + 1; continue; }
        wikiNoClose = true;
      }
      /* 行内码里的竖线同理 */
      if (c === '`') {
        let j = i;
        while (j < s.length && s.charAt(j) === '`') j += 1;
        const run = s.slice(i, j);
        const close = s.indexOf(run, j);
        if (close >= 0) { cur += s.slice(i, close + run.length); i = close + run.length - 1; continue; }
        cur += run;
        i = j - 1;
        continue;
      }
      if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }

  function isDelimiterRow(line) {
    if (typeof line !== 'string' || line.indexOf('-') < 0) return false;
    const cells = splitTableRow(line);
    if (cells.length === 0) return false;
    for (let i = 0; i < cells.length; i += 1) {
      if (!/^:?-+:?$/.test(cells[i])) return false;
    }
    return true;
  }

  function alignOf(cell) {
    const s = safeText(cell);
    const left = s.charAt(0) === ':';
    const right = s.charAt(s.length - 1) === ':';
    if (left && right) return 'center';
    if (left) return 'left';
    if (right) return 'right';
    return null;
  }

  function isTableStart(lines, i) {
    const head = lines[i];
    if (typeof head !== 'string' || head.indexOf('|') < 0) return false;
    const delim = lines[i + 1];
    if (typeof delim !== 'string' || isBlank(delim)) return false;
    if (!isDelimiterRow(delim)) return false;
    return splitTableRow(head).length === splitTableRow(delim).length;
  }

  function matchListMarker(line) {
    const m = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+|$)(.*)$/.exec(line);
    if (!m) return null;
    const indent = indentOf(m[1]);
    const marker = m[2];
    const ordered = /^\d/.test(marker);
    const gap = m[3] ? m[3].length : 0;
    const contentIndent = indent + marker.length + (gap > 0 ? Math.min(gap, 4) : 1);
    return { indent: indent, ordered: ordered, marker: marker, content: m[4], contentIndent: contentIndent };
  }

  /* ---------------- 行内解析 ---------------- */

  function findCodeClose(text, from, runLen) {
    let i = from;
    const n = text.length;
    while (i < n) {
      if (!tick()) return -1;
      if (text.charAt(i) === '`') {
        let j = i;
        while (j < n && text.charAt(j) === '`') j += 1;
        if (j - i === runLen) return i;
        i = j;
        continue;
      }
      i += 1;
    }
    return -1;
  }

  function isEmphasisOpener(text, i, ch) {
    const next = text.charAt(i + 1);
    if (!next || /\s/.test(next)) return false;
    if (ch === '_') {
      const prev = i > 0 ? text.charAt(i - 1) : '';
      if (prev && /[0-9A-Za-z]/.test(prev)) return false;
    }
    return true;
  }

  function findEmphasisClose(text, from, ch) {
    const n = text.length;
    for (let i = from; i < n; i += 1) {
      if (!tick()) return -1;
      if (text.charAt(i) !== ch) continue;
      if (text.charAt(i + 1) === ch) { i += 1; continue; }
      if (text.charAt(i - 1) === ch) continue;
      if (i === from) continue;
      const prev = text.charAt(i - 1);
      const next = text.charAt(i + 1);
      if (prev === ' ' || prev === '\n' || prev === '\t') continue;
      if (ch === '_' && prev && /[0-9A-Za-z]/.test(prev) && next && /[0-9A-Za-z]/.test(next)) continue;
      return i;
    }
    return -1;
  }

  function parseEmphasis(text, i, depth) {
    const ch = text.charAt(i);
    if (ch === '*' && text.charAt(i + 1) === '*' && text.charAt(i + 2) === '*') {
      const close = text.indexOf('***', i + 3);
      if (close > i + 3) {
        return {
          node: {
            type: 'strong',
            children: [{ type: 'em', children: parseInline(text.slice(i + 3, close), depth + 1) }],
          },
          end: close + 3,
        };
      }
    }
    if (text.charAt(i + 1) === ch) {
      const close = text.indexOf(ch + ch, i + 2);
      if (close > i + 2) {
        return {
          node: { type: 'strong', children: parseInline(text.slice(i + 2, close), depth + 1) },
          end: close + 2,
        };
      }
    }
    if (!isEmphasisOpener(text, i, ch)) return null;
    const close = findEmphasisClose(text, i + 1, ch);
    if (close > i + 1) {
      return {
        node: { type: 'em', children: parseInline(text.slice(i + 1, close), depth + 1) },
        end: close + 1,
      };
    }
    return null;
  }

  function safeUrl(url, isImage) {
    const u = safeText(url).trim();
    if (!u) return isImage ? '' : '#';
    const cleaned = u.replace(/[\u0000-\u001F\u007F]/g, '');
    if (!cleaned) return isImage ? '' : '#';
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
    if (!m) return cleaned;
    const scheme = m[1].toLowerCase();
    if (scheme === 'javascript' || scheme === 'vbscript') return '';
    if (scheme === 'data') {
      if (isImage && /^data:image\//i.test(cleaned)) return cleaned;
      return '';
    }
    return cleaned;
  }

  function plainText(label) {
    return safeText(label).replace(/[*_~`]/g, '');
  }

  /* ---------------- Obsidian：frontmatter ---------------- */

  function stripYamlQuotes(value) {
    const s = safeText(value).trim();
    if (s.length >= 2) {
      const a = s.charAt(0);
      const b = s.charAt(s.length - 1);
      if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1);
    }
    return s;
  }

  function parseYamlValue(raw) {
    let v = safeText(raw).trim();
    if (!v) return '';
    /* 行尾注释（仅未加引号时） */
    if (v.charAt(0) !== '"' && v.charAt(0) !== "'") {
      const ci = v.search(/[ \t]#/);
      if (ci >= 0) v = v.slice(0, ci).trim();
    }
    if (v.charAt(0) === '[') {
      const end = v.lastIndexOf(']');
      const inner = end > 0 ? v.slice(1, end) : v.slice(1);
      const arr = [];
      const parts = inner.split(',');
      for (let i = 0; i < parts.length; i += 1) {
        const item = stripYamlQuotes(parts[i]);
        if (item !== '') arr.push(item);
      }
      return arr;
    }
    return stripYamlQuotes(v);
  }

  /* 极简 YAML：只认 `key: value`、`key: [a, b]`、`key:` + 缩进 `- item`。
   * 值一律保留为字符串（日期/数字不转类型，避免时区与精度问题）。 */
  function parseYamlLite(lines) {
    const data = {};
    const n = lines.length;
    let i = 0;
    while (i < n) {
      const line = safeText(lines[i]);
      if (!line.trim() || /^\s*#/.test(line)) { i += 1; continue; }
      const m = /^([^:\s][^:]*?)\s*:\s*(.*)$/.exec(line);
      if (!m) { i += 1; continue; }
      const key = m[1].trim();
      if (!key) { i += 1; continue; }
      const rawVal = m[2];
      if (rawVal.trim() === '') {
        /* 可能是块状数组：
         * tags:
         *   - a
         *   - b
         */
        const arr = [];
        let j = i + 1;
        while (j < n) {
          const im = /^\s+-\s*(.*)$/.exec(safeText(lines[j]));
          if (!im) break;
          const item = stripYamlQuotes(im[1]);
          if (item !== '') arr.push(item);
          j += 1;
        }
        if (arr.length > 0) {
          data[key] = arr;
          i = j;
          continue;
        }
        data[key] = '';
        i += 1;
        continue;
      }
      let value = parseYamlValue(rawVal);
      /* Obsidian 用户常写 `tags: a, b`（YAML 里是字符串），也拆成数组 */
      if ((key === 'tags' || key === 'tag') && typeof value === 'string' && /[,，]/.test(value)) {
        const arr = [];
        const parts = value.split(/[,，]/);
        for (let k = 0; k < parts.length; k += 1) {
          const item = stripYamlQuotes(parts[k]);
          if (item !== '') arr.push(item);
        }
        value = arr;
      }
      data[key] = value;
      i += 1;
    }
    return data;
  }

  /* 源串开头 `---\n...\n---` → frontmatter。返回 { node, end } 或 null。
   * 解析不出任何键、但内容非空时**不**当 frontmatter，避免吞掉正文。 */
  function parseFrontmatter(lines) {
    if (!Array.isArray(lines) || lines.length < 2) return null;
    if (!/^---[ \t]*$/.test(safeText(lines[0]))) return null;
    let end = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (/^(---|\.\.\.)[ \t]*$/.test(safeText(lines[i]))) { end = i; break; }
    }
    if (end < 0) return null;
    const rawLines = lines.slice(1, end);
    const raw = rawLines.map(safeText).join('\n');
    let data = {};
    try { data = parseYamlLite(rawLines); } catch (e) { data = {}; }
    if (Object.keys(data).length === 0 && raw.trim() !== '') return null;
    return { node: { type: 'frontmatter', data: data, raw: raw }, end: end + 1 };
  }

  /* ---------------- Obsidian：callout ---------------- */

  function matchCallout(line) {
    const m = /^\s*\[!([\w-]+)\]([+-])?\s*(.*)$/.exec(safeText(line));
    if (!m) return null;
    const kind = m[1].toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!kind) return null;
    return { kind: kind, fold: m[2] || '', title: m[3] || '' };
  }

  function calloutGroup(kind) {
    return CALLOUT_GROUPS[kind] || 'gray';
  }

  function calloutName(kind) {
    return CALLOUT_NAMES[kind] || kind;
  }

  /* ---------------- Obsidian：wikilink / embed ---------------- */

  function wikiLabel(target, alias, isEmbed) {
    const t = safeText(target).trim();
    /* 嵌入的别名通常是宽度数字（![[img.png|300]]），不拿来当文字 */
    if (alias && !(isEmbed && /^\d+$/.test(alias))) return alias;
    if (!t) return alias || '';
    if (t.charAt(0) === '#') return t.slice(1).trim() || t;
    const h = t.indexOf('#');
    if (h >= 0) {
      const note = t.slice(0, h).trim();
      const head = t.slice(h + 1).trim();
      if (note && head) return note + ' › ' + head;
      if (head) return head;
      return note;
    }
    return t;
  }

  /* text[start] 必须是 wiki 的第一个 '['。
   * cache 记住「后面再没有 ]]」，避免病态输入（成千上万个 [[）退化成 O(n^2)。 */
  function parseWiki(text, start, isEmbed, cache) {
    if (cache && cache.noClose) return null;
    const close = text.indexOf(']]', start + 2);
    if (close < 0) {
      if (cache) cache.noClose = true;
      return null;
    }
    const inner = text.slice(start + 2, close);
    if (!inner || inner.indexOf('[[') >= 0) return null;
    let target = inner;
    let alias = '';
    const pipe = inner.indexOf('|');
    if (pipe >= 0) {
      target = inner.slice(0, pipe);
      alias = inner.slice(pipe + 1);
    }
    target = safeText(target).trim();
    alias = safeText(alias).trim();
    if (!target && !alias) return null;
    const label = wikiLabel(target, alias, isEmbed);
    if (isEmbed) {
      return { node: { type: 'embed', target: target, label: label }, end: close + 2 };
    }
    const anchor = target.charAt(0) === '#' ? target.slice(1).trim() : '';
    return {
      node: { type: 'wikilink', target: target, anchor: anchor, label: label },
      end: close + 2,
    };
  }

  function preventDefaultClick(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
  }

  /* ---------------- Obsidian：#tag ---------------- */

  function isTagChar(ch) {
    if (!ch) return false;
    const c = ch.charCodeAt(0);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
    if (c === 95 || c === 45 || c === 47) return true; /* _ - / */
    if (c >= 0x3400 && c <= 0x9fff) return true; /* CJK */
    if (c >= 0xf900 && c <= 0xfaff) return true; /* CJK 兼容区 */
    if (c >= 0x3040 && c <= 0x30ff) return true; /* 日文假名 */
    if (c >= 0xac00 && c <= 0xd7af) return true; /* 韩文 */
    return false;
  }

  /* text[i] === '#'；前面必须是行首或空白，避免 URL 锚点 / a#b 误伤 */
  function matchTag(text, i) {
    if (i > 0 && !/\s/.test(text.charAt(i - 1))) return null;
    let j = i + 1;
    while (j < text.length && isTagChar(text.charAt(j))) j += 1;
    if (j === i + 1) return null;
    const name = text.slice(i + 1, j);
    if (/^[0-9]+$/.test(name)) return null; /* 纯数字不是标签 */
    if (TAG_BLOCKLIST[name.toLowerCase()] === 1) return null;
    return { name: name, end: j };
  }

  /* ---------------- 数学公式（不接 KaTeX，只去定界符 + data-tex） ---------------- */

  /* 行内 $...$。误伤防护：
   *  - `$ 5` 这种 $ 后跟空白的当钱，不算；
   *  - 前面是 ASCII 字母/数字/下划线/斜杠（a$b$、URL 里的 $）不算；
   *  - 不跨行；未闭合不算；行内码 / \$ 转义在更早分支已处理。 */
  function parseInlineMath(text, i) {
    const n = text.length;
    const next = text.charAt(i + 1);
    if (!next || /\s/.test(next)) return null;
    const prev = i > 0 ? text.charAt(i - 1) : '';
    if (prev && /[0-9A-Za-z_/]/.test(prev)) return null;
    if (next === '$') {
      /* 行内出现的 $$...$$（行首的块级情况已在 parseBlocks 处理）→ 降级成 display 行内公式 */
      const close = text.indexOf('$$', i + 2);
      if (close < 0) return null;
      const tex = text.slice(i + 2, close);
      if (!tex || tex.indexOf('\n') >= 0) return null;
      return { node: { type: 'math', tex: tex, display: true }, end: close + 2 };
    }
    let j = i + 1;
    while (j < n) {
      if (!tick()) return null;
      const c = text.charAt(j);
      if (c === '\n') return null;
      if (c === '$') {
        const before = text.charAt(j - 1);
        if (j > i + 1 && before && !/\s/.test(before)) {
          return { node: { type: 'math', tex: text.slice(i + 1, j), display: false }, end: j + 1 };
        }
      }
      j += 1;
    }
    return null;
  }

  function isMathLine(line) {
    return /^ {0,3}\$\$/.test(safeText(line));
  }

  /* 块级 $$...$$：行首开始，单行或跨行；未闭合、或收尾还有正文 → 不当公式（返回 null）。 */
  function parseMathBlock(lines, start) {
    const first = safeText(lines[start]);
    const open = first.indexOf('$$');
    if (open < 0) return null;
    const rest = first.slice(open + 2);
    const same = rest.indexOf('$$');
    if (same >= 0) {
      if (rest.slice(same + 2).trim() !== '') return null;
      const tex1 = rest.slice(0, same).trim();
      if (!tex1) return null;
      return { node: { type: 'mathBlock', tex: tex1 }, next: start + 1 };
    }
    const parts = [rest];
    let j = start + 1;
    const n = lines.length;
    while (j < n) {
      const l2 = safeText(lines[j]);
      const c = l2.indexOf('$$');
      if (c >= 0) {
        if (l2.slice(c + 2).trim() !== '') return null;
        parts.push(l2.slice(0, c));
        const tex = parts.join('\n').replace(/^\s+|\s+$/g, '');
        if (!tex) return null;
        return { node: { type: 'mathBlock', tex: tex }, next: j + 1 };
      }
      parts.push(l2);
      j += 1;
    }
    return null;
  }

  function parseLinkOrImage(text, start, isImage, depth) {
    const n = text.length;
    let level = 0;
    let labelEnd = -1;
    let i = start;
    for (; i < n; i += 1) {
      if (!tick()) return null;
      const c = text.charAt(i);
      if (c === '\\') { i += 1; continue; }
      if (c === '[') level += 1;
      else if (c === ']') {
        level -= 1;
        if (level === 0) { labelEnd = i; break; }
      }
    }
    if (labelEnd < 0) return null;
    if (text.charAt(labelEnd + 1) !== '(') return null;
    let pdepth = 0;
    let destEnd = -1;
    for (let k = labelEnd + 1; k < n; k += 1) {
      if (!tick()) return null;
      const c = text.charAt(k);
      if (c === '\\') { k += 1; continue; }
      if (c === '(') pdepth += 1;
      else if (c === ')') {
        pdepth -= 1;
        if (pdepth === 0) { destEnd = k; break; }
      }
    }
    if (destEnd < 0) return null;
    const label = text.slice(start + 1, labelEnd);
    const rawDest = text.slice(labelEnd + 2, destEnd).trim();
    let url = rawDest;
    let title = '';
    const tm = /^(\S+)\s+("[^"]*"|'[^']*'|\([^)]*\))\s*$/.exec(rawDest);
    if (tm) { url = tm[1]; title = tm[2].slice(1, -1); }
    if (url.charAt(0) === '<' && url.charAt(url.length - 1) === '>') url = url.slice(1, -1);
    url = url.trim();
    if (isImage) {
      const src = safeUrl(url, true);
      if (!src) return { node: { type: 'text', value: plainText(label) }, end: destEnd + 1 };
      return { node: { type: 'image', src: src, alt: plainText(label) }, end: destEnd + 1 };
    }
    const href = safeUrl(url, false);
    if (!href) return { node: { type: 'text', value: plainText(label) }, end: destEnd + 1 };
    const node = { type: 'link', href: href, children: parseInline(label, depth + 1) };
    if (title) node.title = title;
    return { node: node, end: destEnd + 1 };
  }

  function parseInline(text, depth) {
    const out = [];
    if (typeof text !== 'string' || text.length === 0) return out;
    if (!(depth >= 0)) depth = 0;
    if (depth > MAX_INLINE_DEPTH) {
      out.push({ type: 'text', value: text });
      return out;
    }
    const n = text.length;
    let i = 0;
    let buf = '';
    const wikiCache = { noClose: false };
    const flush = () => {
      if (buf) { out.push({ type: 'text', value: buf }); buf = ''; }
    };
    while (i < n) {
      if (!tick()) { buf += text.slice(i); i = n; break; }
      const ch = text.charAt(i);

      if (ch === '\\') {
        const nx = text.charAt(i + 1);
        if (isEscapable(nx)) { buf += nx; i += 2; continue; }
        buf += ch;
        i += 1;
        continue;
      }

      if (ch === '`') {
        let j = i;
        while (j < n && text.charAt(j) === '`') j += 1;
        const runLen = j - i;
        const close = findCodeClose(text, j, runLen);
        if (close >= 0) {
          flush();
          let content = text.slice(j, close);
          if (content.length >= 2 && content.charAt(0) === ' ' &&
              content.charAt(content.length - 1) === ' ' && /[^ ]/.test(content)) {
            content = content.slice(1, -1);
          }
          out.push({ type: 'code', value: content });
          i = close + runLen;
          continue;
        }
        buf += text.slice(i, j);
        i = j;
        continue;
      }

      /* Obsidian 嵌入 ![[图片.png]] —— 必须排在普通图片 ![]() 前面 */
      if (ch === '!' && text.charAt(i + 1) === '[' && text.charAt(i + 2) === '[') {
        const embed = parseWiki(text, i + 1, true, wikiCache);
        if (embed) { flush(); out.push(embed.node); i = embed.end; continue; }
        buf += '!';
        i += 1;
        continue;
      }

      if (ch === '!' && text.charAt(i + 1) === '[') {
        const link = parseLinkOrImage(text, i + 1, true, depth);
        if (link) { flush(); out.push(link.node); i = link.end; continue; }
        buf += '!';
        i += 1;
        continue;
      }

      /* Obsidian wiki 链接 [[目标]] / [[目标|别名]] / [[笔记#标题]] */
      if (ch === '[' && text.charAt(i + 1) === '[') {
        const wiki = parseWiki(text, i, false, wikiCache);
        if (wiki) { flush(); out.push(wiki.node); i = wiki.end; continue; }
        buf += '[';
        i += 1;
        continue;
      }

      if (ch === '[') {
        const link = parseLinkOrImage(text, i, false, depth);
        if (link) { flush(); out.push(link.node); i = link.end; continue; }
        buf += '[';
        i += 1;
        continue;
      }

      /* Obsidian 高亮 ==文字== */
      if (ch === '=' && text.charAt(i + 1) === '=') {
        const close = text.indexOf('==', i + 2);
        if (close > i + 2) {
          flush();
          out.push({ type: 'mark', children: parseInline(text.slice(i + 2, close), depth + 1) });
          i = close + 2;
          continue;
        }
        buf += '==';
        i += 2;
        continue;
      }

      /* Obsidian 注释 %%...%% —— 不渲染 */
      if (ch === '%' && text.charAt(i + 1) === '%') {
        const close = text.indexOf('%%', i + 2);
        if (close >= 0) {
          flush();
          out.push({ type: 'comment' });
          i = close + 2;
          continue;
        }
        buf += '%%';
        i += 2;
        continue;
      }

      /* Obsidian 标签 #标签 */
      if (ch === '#') {
        const tag = matchTag(text, i);
        if (tag) { flush(); out.push({ type: 'tag', name: tag.name }); i = tag.end; continue; }
        buf += '#';
        i += 1;
        continue;
      }

      /* 数学公式 $...$ / 行内 $$...$$ */
      if (ch === '$') {
        const math = parseInlineMath(text, i);
        if (math) { flush(); out.push(math.node); i = math.end; continue; }
        buf += '$';
        i += 1;
        continue;
      }

      if (ch === '*' || ch === '_') {
        const em = parseEmphasis(text, i, depth);
        if (em) { flush(); out.push(em.node); i = em.end; continue; }
        buf += ch;
        i += 1;
        continue;
      }

      if (ch === '~' && text.charAt(i + 1) === '~') {
        const close = text.indexOf('~~', i + 2);
        if (close > i + 2) {
          flush();
          out.push({ type: 'del', children: parseInline(text.slice(i + 2, close), depth + 1) });
          i = close + 2;
          continue;
        }
        buf += '~~';
        i += 2;
        continue;
      }

      if (ch === '\n') {
        const m = / {2,}$/.exec(buf);
        if (m) {
          buf = buf.slice(0, buf.length - m[0].length);
          flush();
          out.push({ type: 'br' });
        } else {
          buf += ' ';
        }
        i += 1;
        continue;
      }

      buf += ch;
      i += 1;
    }
    flush();
    return out;
  }

  /* ---------------- 块级解析 ---------------- */

  function startsNewBlock(lines, j) {
    const l = lines[j];
    if (typeof l !== 'string' || isBlank(l)) return true;
    if (/^ {0,3}%%/.test(l)) return true;
    if (isMathLine(l)) return true;
    if (matchFence(l)) return true;
    if (matchHeading(l)) return true;
    if (isHr(l)) return true;
    if (isQuoteLine(l)) return true;
    if (matchListMarker(l)) return true;
    if (isTableStart(lines, j)) return true;
    return false;
  }

  function parseList(lines, start, baseIndent, ordered, depth) {
    const items = [];
    const n = lines.length;
    let i = start;
    let listStart = 1;
    let guard = 0;
    while (i < n) {
      guard += 1;
      if (guard > 20000 || !tick()) break;
      const line = typeof lines[i] === 'string' ? lines[i] : '';
      if (isBlank(line)) {
        let j = i;
        while (j < n && isBlank(lines[j])) j += 1;
        const nm = j < n ? matchListMarker(lines[j]) : null;
        if (nm && nm.indent === baseIndent && nm.ordered === ordered) { i = j; continue; }
        break;
      }
      const m = matchListMarker(line);
      if (!m || m.indent !== baseIndent || m.ordered !== ordered) break;
      if (items.length === 0 && ordered) {
        const num = parseInt(m.marker, 10);
        if (isFinite(num) && num > 0) listStart = num;
      }
      const itemLines = [m.content];
      let j = i + 1;
      while (j < n) {
        if (!tick()) break;
        const l2 = typeof lines[j] === 'string' ? lines[j] : '';
        if (isBlank(l2)) {
          let k = j;
          while (k < n && isBlank(lines[k])) k += 1;
          if (k < n && typeof lines[k] === 'string' && indentOf(lines[k]) > baseIndent) {
            itemLines.push('');
            j = k;
            continue;
          }
          break;
        }
        if (indentOf(l2) > baseIndent) {
          itemLines.push(stripIndent(l2, m.contentIndent));
          j += 1;
          continue;
        }
        break;
      }
      i = j;
      let checked = null;
      const tm = /^\[([ xX])\](?:[ \t]+|$)(.*)$/.exec(itemLines[0]);
      if (tm) {
        checked = tm[1] !== ' ';
        itemLines[0] = tm[2];
      }
      items.push({ type: 'listItem', checked: checked, blocks: parseBlocks(itemLines, depth + 1) });
    }
    return {
      node: { type: 'list', ordered: ordered, start: ordered ? listStart : 1, items: items },
      next: i > start ? i : start + 1,
    };
  }

  function parseBlocks(lines, depth) {
    const out = [];
    if (!Array.isArray(lines) || lines.length === 0) return out;
    if (!(depth >= 0)) depth = 0;
    if (depth > MAX_BLOCK_DEPTH) {
      const joined = lines.map(safeText).join('\n');
      if (joined.trim()) out.push({ type: 'paragraph', children: parseInline(joined, 0) });
      return out;
    }
    const n = lines.length;
    let i = 0;
    while (i < n) {
      if (!tick()) {
        const rest = lines.slice(i).map(safeText).join('\n');
        if (rest.trim()) out.push({ type: 'paragraph', children: [{ type: 'text', value: rest }] });
        break;
      }
      const line = typeof lines[i] === 'string' ? lines[i] : '';
      if (isBlank(line)) { i += 1; continue; }

      /* 0. Obsidian 块注释 %% ... %%（整段隐藏） */
      if (/^ {0,3}%%/.test(line)) {
        const rest = line.replace(/^ {0,3}%%/, '');
        if (rest.indexOf('%%') >= 0) { i += 1; continue; }
        let j = i + 1;
        while (j < n) {
          const l2 = typeof lines[j] === 'string' ? lines[j] : '';
          j += 1;
          if (l2.indexOf('%%') >= 0) break;
        }
        i = j;
        continue;
      }

      /* 1. 围栏代码块 */
      const fence = matchFence(line);
      if (fence) {
        const codeLines = [];
        let j = i + 1;
        while (j < n) {
          const l2 = typeof lines[j] === 'string' ? lines[j] : '';
          if (isClosingFence(l2, fence)) { j += 1; break; }
          codeLines.push(l2);
          j += 1;
        }
        out.push({
          type: 'code',
          lang: fence.info.split(/\s+/)[0] || '',
          code: codeLines.join('\n'),
        });
        i = j;
        continue;
      }

      /* 1.5 块级公式 $$...$$ */
      if (isMathLine(line)) {
        const mathBlock = parseMathBlock(lines, i);
        if (mathBlock) {
          out.push(mathBlock.node);
          i = mathBlock.next;
          continue;
        }
      }

      /* 2. ATX 标题 */
      const heading = matchHeading(line);
      if (heading) {
        out.push({ type: 'heading', level: heading.level, children: parseInline(heading.text, 0) });
        i += 1;
        continue;
      }

      /* 3. 分隔线 */
      if (isHr(line)) {
        out.push({ type: 'hr' });
        i += 1;
        continue;
      }

      /* 4. 引用 / Obsidian callout */
      if (isQuoteLine(line)) {
        const inner = [];
        let j = i;
        while (j < n) {
          const l2 = typeof lines[j] === 'string' ? lines[j] : '';
          if (isQuoteLine(l2)) { inner.push(stripQuote(l2)); j += 1; continue; }
          /* 空行（不含 >）结束引用：`> a` 与 `> b` 之间空一行是两个引用块，
           * 引用内部的空行应写成 `>` 而不是裸空行。 */
          break;
        }
        const callout = inner.length > 0 ? matchCallout(inner[0]) : null;
        if (callout) {
          out.push({
            type: 'callout',
            kind: callout.kind,
            fold: callout.fold,
            title: callout.title ? parseInline(callout.title, 0) : [],
            blocks: parseBlocks(inner.slice(1), depth + 1),
          });
        } else {
          out.push({ type: 'blockquote', children: parseBlocks(inner, depth + 1) });
        }
        i = j > i ? j : i + 1;
        continue;
      }

      /* 5. GFM 表格 */
      if (isTableStart(lines, i)) {
        const header = splitTableRow(line).map((cell) => parseInline(cell, 0));
        const align = splitTableRow(lines[i + 1]).map(alignOf);
        const rows = [];
        let j = i + 2;
        while (j < n) {
          const l2 = typeof lines[j] === 'string' ? lines[j] : '';
          if (isBlank(l2) || l2.indexOf('|') < 0) break;
          if (matchFence(l2) || matchHeading(l2) || isQuoteLine(l2)) break;
          const cells = splitTableRow(l2);
          const row = [];
          for (let c = 0; c < header.length; c += 1) {
            row.push(parseInline(cells[c] == null ? '' : cells[c], 0));
          }
          rows.push(row);
          j += 1;
        }
        out.push({ type: 'table', align: align, header: header, rows: rows });
        i = j > i ? j : i + 1;
        continue;
      }

      /* 6. 列表 */
      const lm = matchListMarker(line);
      if (lm) {
        const res = parseList(lines, i, lm.indent, lm.ordered, depth);
        out.push(res.node);
        i = res.next > i ? res.next : i + 1;
        continue;
      }

      /* 7. 段落（兜底） */
      const paraLines = [line.replace(/^[ \t]+/, '')];
      let j = i + 1;
      while (j < n) {
        if (!tick()) break;
        if (startsNewBlock(lines, j)) break;
        paraLines.push(safeText(lines[j]).replace(/^[ \t]+/, ''));
        j += 1;
      }
      out.push({ type: 'paragraph', children: parseInline(paraLines.join('\n'), 0) });
      i = j > i ? j : i + 1;
    }
    return out;
  }

  /* ---------------- 渲染 ---------------- */

  function alignClass(a) {
    return (a === 'left' || a === 'center' || a === 'right') ? ' dm-md-align-' + a : '';
  }

  function renderInline(nodes, keyPrefix) {
    const out = [];
    if (!Array.isArray(nodes)) return out;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const key = keyPrefix + 'i' + i;
      try {
        if (!node || typeof node !== 'object') continue;
        switch (node.type) {
          case 'text':
            if (typeof node.value === 'string' && node.value !== '') out.push(node.value);
            break;
          case 'br':
            out.push(h('br', { key: key, className: 'dm-md-br' }));
            break;
          case 'code':
            out.push(h('code', { key: key, className: 'dm-md-code-inline' },
              typeof node.value === 'string' ? node.value : ''));
            break;
          case 'strong':
            out.push(h('strong', { key: key, className: 'dm-md-strong' },
              renderInline(node.children, key + '_')));
            break;
          case 'em':
            out.push(h('em', { key: key, className: 'dm-md-em' },
              renderInline(node.children, key + '_')));
            break;
          case 'del':
            out.push(h('del', { key: key, className: 'dm-md-del' },
              renderInline(node.children, key + '_')));
            break;
          case 'mark':
            out.push(h('mark', { key: key, className: 'dm-md-mark' },
              renderInline(node.children, key + '_')));
            break;
          case 'wikilink': {
            const props = {
              key: key,
              className: 'dm-md-wikilink',
              href: '#',
              'data-target': typeof node.target === 'string' ? node.target : '',
              onClick: preventDefaultClick,
            };
            if (typeof node.anchor === 'string' && node.anchor) props['data-anchor'] = node.anchor;
            out.push(h('a', props, typeof node.label === 'string' ? node.label : ''));
            break;
          }
          case 'embed':
            out.push(h('span', { key: key, className: 'dm-md-embed' },
              typeof node.label === 'string' ? node.label : ''));
            break;
          case 'tag':
            out.push(h('span', { key: key, className: 'dm-md-tag' },
              '#' + (typeof node.name === 'string' ? node.name : '')));
            break;
          case 'comment':
            break;
          case 'link': {
            const props = {
              key: key,
              className: 'dm-md-a',
              href: typeof node.href === 'string' ? node.href : '#',
              target: '_blank',
              rel: 'noreferrer',
            };
            if (typeof node.title === 'string' && node.title) props.title = node.title;
            out.push(h('a', props, renderInline(node.children, key + '_')));
            break;
          }
          case 'image': {
            const src = typeof node.src === 'string' ? node.src : '';
            out.push(h(MarkdownImage, {
              key: key + '|' + src,
              src: src,
              alt: typeof node.alt === 'string' ? node.alt : '',
            }));
            break;
          }
          case 'math': {
            const tex = typeof node.tex === 'string' ? node.tex : '';
            out.push(h('span', {
              key: key,
              className: 'dm-md-math' + (node.display ? ' dm-md-math--display' : ''),
              'data-tex': tex,
            }, tex));
            break;
          }
          default:
            if (typeof node.value === 'string' && node.value) out.push(node.value);
            break;
        }
      } catch (e) {
        if (node && typeof node.value === 'string') out.push(node.value);
      }
    }
    return out;
  }

  /* 图片：加载失败（onError）→ 换成占位块。相对路径图片常不随文档导入，
   * 避免浏览器碎图标。外链图片正常显示，失败也走同一个占位。
   * key 里带 src（见 renderInline），换图时 React 重建组件、failed 状态自然复位。 */
  function imageName(src) {
    let s = safeText(src);
    const q = s.search(/[?#]/);
    if (q >= 0) s = s.slice(0, q);
    const parts = s.split('/');
    let name = parts.length > 0 ? parts[parts.length - 1] : s;
    if (!name) name = s;
    try { name = decodeURIComponent(name); } catch (e) { /* 解码失败就保留原样 */ }
    return name || safeText(src);
  }

  function MarkdownImage(props) {
    const p = props && typeof props === 'object' ? props : {};
    const src = typeof p.src === 'string' ? p.src : '';
    const alt = typeof p.alt === 'string' ? p.alt : '';
    const state = useState(false);
    const failed = !!state[0];
    const setFailed = typeof state[1] === 'function' ? state[1] : function () {};
    if (failed) {
      return h('span', {
        className: 'dm-md-img-missing',
        title: '原始路径：' + src,
      },
        h('span', { className: 'dm-md-img-missing__icon' }, '🖼'),
        h('span', { className: 'dm-md-img-missing__name' }, alt || imageName(src)),
        h('span', { className: 'dm-md-img-missing__hint' }, '图片未随文档导入'));
    }
    return h('img', {
      className: 'dm-md-img',
      src: src,
      alt: alt,
      loading: 'lazy',
      onError: function () { setFailed(true); },
    });
  }

  /* 属性条：一个 key 一个 item；tags 数组 → 多个 chip。
   * 默认折叠成一行（CSS 负责省略号），点一下展开/收起。 */
  function renderMetaItem(key, value, idx) {
    const kids = [h('b', { key: 'k', className: 'dm-md-meta__key' }, key)];
    if (Array.isArray(value)) {
      if (key === 'tags' || key === 'tag') {
        for (let i = 0; i < value.length; i += 1) {
          kids.push(h('span', { key: 't' + i, className: 'dm-md-meta__tag' }, safeText(value[i])));
        }
      } else {
        kids.push(h('span', { key: 'v', className: 'dm-md-meta__value' },
          value.map(safeText).join(', ')));
      }
    } else if (value !== '' && value != null) {
      kids.push(h('span', { key: 'v', className: 'dm-md-meta__value' }, safeText(value)));
    }
    return h('span', { key: 'mi' + idx, className: 'dm-md-meta__item' }, kids);
  }

  function MetaBar(props) {
    const p = props && typeof props === 'object' ? props : {};
    const data = p.data && typeof p.data === 'object' ? p.data : {};
    /* hooks 必须无条件调用，放在提前 return 之前 */
    const state = useState(false);
    const open = !!state[0];
    const setOpen = typeof state[1] === 'function' ? state[1] : function () {};
    const keys = Object.keys(data);
    if (keys.length === 0) return null;
    const toggle = function (event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      setOpen(!open);
    };
    const kids = keys.map((k, i) => renderMetaItem(k, data[k], i));
    kids.push(h('span', { key: 'hint', className: 'dm-md-meta__hint' },
      open ? '点击收起' : '点击展开'));
    return h('div', {
      className: 'dm-md-meta' + (open ? ' is-open' : ''),
      role: 'button',
      tabIndex: 0,
      'aria-expanded': open ? 'true' : 'false',
      title: open ? '点击收起属性' : '点击展开属性',
      onClick: toggle,
      onKeyDown: function (event) {
        if (!event) return;
        const k = event.key;
        if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          setOpen(!open);
        }
      },
    }, kids);
  }

  /* callout：带 +/- 标记的可折叠，点击标题展开/收起（CSS 用 --folded 隐藏 body） */
  function Callout(props) {
    const p = props && typeof props === 'object' ? props : {};
    const kind = typeof p.kind === 'string' && p.kind ? p.kind : 'note';
    const foldable = p.fold === '+' || p.fold === '-';
    const state = useState(p.fold === '-');
    const folded = foldable && !!state[0];
    const setFolded = typeof state[1] === 'function' ? state[1] : function () {};
    let cls = 'dm-md-callout dm-md-callout--' + kind + ' dm-md-callout--' + calloutGroup(kind);
    if (foldable) cls += ' dm-md-callout--foldable';
    if (folded) cls += ' dm-md-callout--folded';
    const titleKids = (Array.isArray(p.title) && p.title.length > 0)
      ? renderInline(p.title, 'ct_')
      : [calloutName(kind)];
    const titleProps = { className: 'dm-md-callout__title' };
    if (foldable) {
      titleProps.role = 'button';
      titleProps.tabIndex = 0;
      titleProps.title = folded ? '点击展开' : '点击收起';
      titleProps.onClick = function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        setFolded(!folded);
      };
      titleProps.onKeyDown = function (event) {
        if (!event) return;
        const k = event.key;
        if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          setFolded(!folded);
        }
      };
    }
    return h('div', { className: cls },
      h('div', titleProps, titleKids),
      h('div', { className: 'dm-md-callout__body' }, renderBlocks(p.blocks, 'cb_')));
  }

  function renderListItem(item, key) {
    const kids = [];
    if (item && typeof item === 'object') {
      const blocks = Array.isArray(item.blocks) ? item.blocks : [];
      let start = 0;
      if (blocks.length > 0 && blocks[0] && blocks[0].type === 'paragraph') {
        const inline = renderInline(blocks[0].children, key + 'p_');
        for (let i = 0; i < inline.length; i += 1) kids.push(inline[i]);
        start = 1;
      }
      for (let i = start; i < blocks.length; i += 1) {
        let el = null;
        try { el = renderBlock(blocks[i], key + 'b' + i); } catch (e) { el = null; }
        if (el != null) kids.push(el);
      }
      if (item.checked === true || item.checked === false) {
        kids.unshift(h('input', {
          key: key + 'cb',
          type: 'checkbox',
          className: 'dm-md-checkbox',
          checked: item.checked === true,
          readOnly: true,
          tabIndex: -1,
        }));
      }
    }
    const isTask = item && (item.checked === true || item.checked === false);
    const cls = isTask
      ? 'dm-md-li dm-md-task' + (item.checked === true ? ' dm-md-task-done' : '')
      : 'dm-md-li';
    return h('li', { key: key, className: cls }, kids);
  }

  function renderBlock(block, key) {
    if (!block || typeof block !== 'object') return null;
    switch (block.type) {
      case 'heading': {
        let level = parseInt(block.level, 10);
        if (!isFinite(level) || level < 1) level = 1;
        if (level > 6) level = 6;
        return h('h' + level, { key: key, className: 'dm-md-h' + level },
          renderInline(block.children, key + '_'));
      }
      case 'paragraph':
        return h('p', { key: key, className: 'dm-md-p' },
          renderInline(block.children, key + '_'));
      case 'code':
        return h('pre', { key: key, className: 'dm-md-pre' },
          h('code', { className: 'dm-md-code' },
            typeof block.code === 'string' ? block.code : ''));
      case 'hr':
        return h('hr', { key: key, className: 'dm-md-hr' });
      case 'mathBlock': {
        const tex = typeof block.tex === 'string' ? block.tex : '';
        return h('div', { key: key, className: 'dm-md-math-block', 'data-tex': tex }, tex);
      }
      case 'blockquote':
        return h('blockquote', { key: key, className: 'dm-md-quote' },
          renderBlocks(block.children, key + '_'));
      case 'frontmatter': {
        const data = block.data && typeof block.data === 'object' ? block.data : {};
        if (Object.keys(data).length === 0) return null;
        return h(MetaBar, { key: key, data: data });
      }
      case 'callout':
        return h(Callout, {
          key: key,
          kind: block.kind,
          fold: block.fold,
          title: block.title,
          blocks: block.blocks,
        });
      case 'list': {
        const ordered = !!block.ordered;
        const props = { key: key, className: ordered ? 'dm-md-ol' : 'dm-md-ul' };
        const startNum = parseInt(block.start, 10);
        if (ordered && isFinite(startNum) && startNum !== 1) props.start = startNum;
        const items = Array.isArray(block.items) ? block.items : [];
        return h(ordered ? 'ol' : 'ul', props,
          items.map((item, ii) => renderListItem(item, key + 'l' + ii)));
      }
      case 'table': {
        const align = Array.isArray(block.align) ? block.align : [];
        const header = Array.isArray(block.header) ? block.header : [];
        const rows = Array.isArray(block.rows) ? block.rows : [];
        const ths = header.map((cell, ci) => h('th', {
          key: 'th' + ci,
          className: 'dm-md-th' + alignClass(align[ci]),
        }, renderInline(cell, 'th' + ci + '_')));
        const trs = rows.map((row, ri) => {
          const cells = Array.isArray(row) ? row : [];
          return h('tr', { key: 'tr' + ri, className: 'dm-md-tr' },
            cells.map((cell, ci) => h('td', {
              key: 'td' + ci,
              className: 'dm-md-td' + alignClass(align[ci]),
            }, renderInline(cell, 'td' + ri + '_' + ci + '_'))));
        });
        return h('table', { key: key, className: 'dm-md-table' },
          h('thead', { key: 'thead', className: 'dm-md-thead' },
            h('tr', { key: 'htr', className: 'dm-md-tr' }, ths)),
          h('tbody', { key: 'tbody', className: 'dm-md-tbody' }, trs));
      }
      default:
        return h('p', { key: key, className: 'dm-md-p' },
          typeof block.value === 'string' ? block.value : '');
    }
  }

  function renderBlocks(blocks, keyPrefix) {
    const out = [];
    if (!Array.isArray(blocks)) return out;
    for (let i = 0; i < blocks.length; i += 1) {
      let el = null;
      try { el = renderBlock(blocks[i], keyPrefix + 'b' + i); } catch (e) { el = null; }
      if (el != null) out.push(el);
    }
    return out;
  }

  /* ---------------- 对外 API ---------------- */

  function normalizeSource(source) {
    let s;
    if (typeof source === 'string') s = source;
    else if (source == null) s = '';
    else s = String(source);
    s = s.replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
    return s.split('\n');
  }

  function parseMarkdown(source) {
    scanBudget = SCAN_BUDGET;
    let lines;
    try {
      lines = normalizeSource(source);
    } catch (e) {
      return [];
    }
    let bodyLines = lines;
    let frontmatter = null;
    try {
      frontmatter = parseFrontmatter(lines);
      if (frontmatter) bodyLines = lines.slice(frontmatter.end);
    } catch (e) {
      frontmatter = null;
      bodyLines = lines;
    }
    try {
      const out = [];
      if (frontmatter) out.push(frontmatter.node);
      const body = parseBlocks(bodyLines, 0);
      for (let i = 0; i < body.length; i += 1) out.push(body[i]);
      return out;
    } catch (e) {
      const text = typeof source === 'string' ? source : '';
      if (!text) return [];
      return [{ type: 'paragraph', children: [{ type: 'text', value: text }] }];
    }
  }

  function Markdown(props) {
    const p = props && typeof props === 'object' ? props : {};
    let blocks = [];
    try {
      blocks = parseMarkdown(p.source);
    } catch (e) {
      blocks = [];
    }
    let className = 'dm-md';
    if (typeof p.className === 'string' && p.className.trim() !== '') {
      className += ' ' + p.className.trim();
    }
    return h('div', { className: className }, renderBlocks(blocks, 'k'));
  }

  return { Markdown: Markdown, parseMarkdown: parseMarkdown };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createMarkdown };
