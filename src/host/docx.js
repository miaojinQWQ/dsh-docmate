/**
 * dsh-docmate —— Host 半：.docx → 语义 HTML
 * ============================================================
 * 纯 Node ESM，**零第三方依赖**（只用 node:zlib / node:buffer）。
 *
 * 入口：
 *   import { convertDocxToHtml } from './docx.js'
 *   const { html, title, warnings } = convertDocxToHtml(bytes)  // bytes: Uint8Array|Buffer|ArrayBuffer
 *
 * 设计要点：
 *   - 自己解 ZIP（EOCD → 中央目录 → 本地文件头；method 0 直拷 / method 8 inflateRawSync）
 *   - 自己写容错 XML 解析器（不做 DTD、不做校验，只求把 OOXML 读成树）
 *   - 命名空间归一化：把 WordprocessingML / DrawingML 等已知命名空间统一成 w: / a: / r: …
 *     这样即使生成器用了默认命名空间（xmlns="…/wordprocessingml/2006/main"）也能解析
 *   - 输出是 HTML **片段**（不带 <html>/<body>），外层包一个 <div class="dm-docx-doc">
 *
 * 支持的 Word 特性见文件末尾「特性清单」注释。
 */

import { inflateRawSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

/* ============================================================================
 * 0. 常量 / 错误 / 小工具
 * ========================================================================== */

/** 段内分页标记：XML 文本里不可能出现 \u0000，所以用它做占位符，块级渲染时再拆成 <hr> */
const PAGEBREAK = '\u0000dm-pb\u0000';

/** 警告条数上限，防止畸形文档刷屏 */
const MAX_WARNINGS = 40;

/** EMU（English Metric Unit）→ CSS px：1px = 9525 EMU（96dpi） */
const EMU_PER_PX = 9525;

class DocxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocxError';
    this.code = 'DOCX_INVALID';
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 文本 / 属性统一转义。文本里绝不允许漏出未转义的 < */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** 把一段 HTML 片段还原成纯文本（用于 title 兜底、标题文本） */
function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

function clampHeading(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(1, Math.min(6, Math.trunc(v)));
}

/** 把任意「字节数组」输入统一成 Buffer（尽量零拷贝） */
function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (bytes && typeof bytes === 'object' && bytes.buffer instanceof ArrayBuffer) {
    return Buffer.from(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength || 0);
  }
  throw new DocxError('输入不是字节数组：需要 Uint8Array / Buffer / ArrayBuffer。');
}

/* ============================================================================
 * 1. ZIP 读取（EOCD → 中央目录 → 本地文件头）
 * ========================================================================== */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

function u16(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}

function u32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function u64(buf, off) {
  return u32(buf, off) + u32(buf, off + 4) * 4294967296;
}

/** 从尾部向前找 EOCD（先严格校验注释长度，再退化到宽松匹配） */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x05 || buf[i + 3] !== 0x06) continue;
    const commentLen = u16(buf, i + 20);
    if (i + 22 + commentLen === buf.length) return i;
  }
  // 宽松兜底：文件尾部可能有多余垃圾字节
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
  }
  return -1;
}

/** ZIP64 EOCD（大文件才用得上，尽量支持，失败就返回 null 让调用方走普通路径） */
function readZip64Eocd(buf, eocdOffset) {
  try {
    const loc = eocdOffset - 20;
    if (loc < 0 || u32(buf, loc) !== SIG_ZIP64_LOCATOR) return null;
    const z64Offset = u64(buf, loc + 8);
    if (z64Offset + 56 > buf.length || u32(buf, z64Offset) !== SIG_ZIP64_EOCD) return null;
    return {
      total: u64(buf, z64Offset + 32),
      cdSize: u64(buf, z64Offset + 40),
      cdOffset: u64(buf, z64Offset + 48),
    };
  } catch {
    return null;
  }
}

/**
 * 解析中央目录，返回 Map<文件名, 条目信息>。
 * 条目信息：{ name, flags, method, compSize, uncompSize, localOffset }
 */
function readZipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) {
    throw new DocxError('不是有效的 .docx 文件：找不到 ZIP 结束标记（EOCD）。');
  }

  let total = u16(buf, eocd + 10);
  let cdOffset = u32(buf, eocd + 16);

  if (total === 0xffff || cdOffset === 0xffffffff) {
    const z64 = readZip64Eocd(buf, eocd);
    if (z64) {
      total = z64.total;
      cdOffset = z64.cdOffset;
    }
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || u32(buf, p) !== SIG_CENTRAL) break;

    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    let compSize = u32(buf, p + 20);
    let uncompSize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    let localOffset = u32(buf, p + 42);
    // 少数 Windows 打包器会写反斜杠，统一成正斜杠才能按路径查到
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');

    // ZIP64 扩展字段（0x0001）：只在对应 32 位字段是 0xFFFFFFFF 时才存在
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      const extraStart = p + 46 + nameLen;
      const extraEnd = extraStart + extraLen;
      let q = extraStart;
      while (q + 4 <= extraEnd) {
        const id = u16(buf, q);
        const size = u16(buf, q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (uncompSize === 0xffffffff && r + 8 <= extraEnd) { uncompSize = u64(buf, r); r += 8; }
          if (compSize === 0xffffffff && r + 8 <= extraEnd) { compSize = u64(buf, r); r += 8; }
          if (localOffset === 0xffffffff && r + 8 <= extraEnd) { localOffset = u64(buf, r); r += 8; }
          break;
        }
        q += 4 + size;
      }
    }

    if (name) {
      entries.set(name, { name, flags, method, compSize, uncompSize, localOffset });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/** 读一个 ZIP 条目的解压后字节 */
function readZipEntry(buf, entry) {
  if (!entry.uncompSize && !entry.compSize) return Buffer.alloc(0);

  const lo = entry.localOffset;
  if (lo + 30 > buf.length || u32(buf, lo) !== SIG_LOCAL) {
    throw new DocxError(`ZIP 条目损坏：${entry.name}`);
  }
  const nameLen = u16(buf, lo + 26);
  const extraLen = u16(buf, lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const end = start + entry.compSize;
  if (end > buf.length || start > end) {
    throw new DocxError(`ZIP 条目数据越界：${entry.name}`);
  }
  const raw = buf.subarray(start, end);

  if (entry.method === 0) return raw; // stored：直接拷
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw);
    } catch (e) {
      throw new DocxError(`解压失败：${entry.name}（${e && e.message ? e.message : e}）`);
    }
  }
  throw new DocxError(`不支持的 ZIP 压缩方式 ${entry.method}：${entry.name}`);
}

/** 把 rels 里的相对 Target 解析成 zip 内的绝对路径，baseDir 例如 'word' */
function resolveZipPath(baseDir, target) {
  if (!target) return '';
  let t = String(target).replace(/\\/g, '/');
  if (t.startsWith('/')) return t.replace(/^\/+/, '');
  const parts = (baseDir ? String(baseDir).split('/') : []).concat(t.split('/'));
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/* ============================================================================
 * 2. 容错 XML 解析器
 * ========================================================================== */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(input) {
  if (input.indexOf('&') === -1) return input;
  return input.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const v = XML_ENTITIES[body];
    return v === undefined ? match : v;
  });
}

function isXmlSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/**
 * 把 XML 文本解析成 { name, attrs, children } 树。
 * children 里字符串是文本节点，对象是元素节点。
 * 容错：标签不匹配就尽量弹栈、忽略注释 / 处理指令 / DOCTYPE / CDATA。
 */
function parseXml(text) {
  const root = { name: '#document', attrs: Object.create(null), children: [] };
  const stack = [root];
  const n = text.length;

  const pushText = (raw, fromCdata) => {
    if (!raw) return;
    const value = fromCdata ? raw : decodeEntities(raw);
    const parent = stack[stack.length - 1];
    const last = parent.children[parent.children.length - 1];
    if (typeof last === 'string') parent.children[parent.children.length - 1] = last + value;
    else parent.children.push(value);
  };

  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      pushText(text.slice(i), false);
      break;
    }
    if (lt > i) pushText(text.slice(i, lt), false);

    // 注释
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    // CDATA
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      pushText(text.slice(lt + 9, e < 0 ? n : e), true);
      i = e < 0 ? n : e + 3;
      continue;
    }
    // 处理指令 / DOCTYPE
    if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const e = text.indexOf('>', lt + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    // 结束标签
    if (text.charCodeAt(lt + 1) === 47 /* / */) {
      const e = text.indexOf('>', lt + 2);
      const name = text.slice(lt + 2, e < 0 ? n : e).trim();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].name === name) {
          stack.length = s;
          break;
        }
      }
      i = e < 0 ? n : e + 1;
      continue;
    }

    // 开始标签：找到真正的 '>'（跳过引号内的内容）
    let j = lt + 1;
    let quote = 0;
    for (; j < n; j++) {
      const c = text.charCodeAt(j);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 34 || c === 39) {
        quote = c;
      } else if (c === 62 /* > */) {
        break;
      }
    }
    const rawTag = text.slice(lt + 1, j);
    i = j + 1;

    let body = rawTag;
    let selfClose = false;
    if (body.endsWith('/')) {
      selfClose = true;
      body = body.slice(0, -1);
    }

    let k = 0;
    while (k < body.length && !isXmlSpaceCode(body.charCodeAt(k))) k++;
    const name = body.slice(0, k);
    if (!name) continue;

    const attrs = Object.create(null);
    const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    attrRe.lastIndex = k;
    let m;
    while ((m = attrRe.exec(body))) {
      attrs[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
    }

    const node = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }

  return root;
}

/* ============================================================================
 * 3. 命名空间归一化
 * ========================================================================== */

/** 已知命名空间 URI → 规范前缀。生成器用默认命名空间时也能解析。 */
const NS_CANON = {
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://schemas.openxmlformats.org/drawingml/2006/picture': 'pic',
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing': 'wp',
  'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing': 'wp',
  'http://schemas.openxmlformats.org/drawingml/2006/chart': 'c',
  'http://schemas.openxmlformats.org/drawingml/2006/diagram': 'dgm',
  'urn:schemas-microsoft-com:vml': 'v',
  'urn:schemas-microsoft-com:office:office': 'o',
  'urn:schemas-microsoft-com:office:word': 'w10',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape': 'wps',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup': 'wpg',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'pr',
  'http://purl.org/dc/elements/1.1/': 'dc',
  'http://purl.org/dc/terms/': 'dcterms',
  'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties': 'ep',
  'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties': 'cp',
  'http://www.w3.org/XML/1998/namespace': 'xml',
};

/**
 * 递归归一化元素名 / 属性名上的前缀。
 * 只在「声明了已知命名空间、且前缀不是规范前缀」时才改名，正常 docx 是零开销的。
 */
function normalizeNamespaces(node, inherited) {
  const ns = inherited ? { ...inherited } : {};
  for (const key of Object.keys(node.attrs)) {
    if (key === 'xmlns') {
      const canon = NS_CANON[node.attrs[key]];
      if (canon) ns[''] = canon;
    } else if (key.startsWith('xmlns:')) {
      const canon = NS_CANON[node.attrs[key]];
      if (canon) ns[key.slice(6)] = canon;
    }
  }

  const name = node.name;
  if (name && name[0] !== '#') {
    const idx = name.indexOf(':');
    if (idx < 0) {
      if (ns['']) node.name = `${ns['']}:${name}`;
    } else {
      const prefix = name.slice(0, idx);
      const canon = ns[prefix];
      if (canon && canon !== prefix) node.name = canon + name.slice(idx);
    }
  }

  let renamed = null;
  for (const key of Object.keys(node.attrs)) {
    if (key.startsWith('xmlns')) continue;
    const idx = key.indexOf(':');
    if (idx < 0) continue;
    const prefix = key.slice(0, idx);
    const canon = ns[prefix];
    if (canon && canon !== prefix) {
      if (!renamed) renamed = {};
      renamed[canon + key.slice(idx)] = node.attrs[key];
    }
  }
  if (renamed) {
    for (const key of Object.keys(node.attrs)) if (!key.startsWith('xmlns')) delete node.attrs[key];
    Object.assign(node.attrs, renamed);
    // xmlns:* 声明已经用完了，删掉避免污染
    for (const key of Object.keys(node.attrs)) if (key.startsWith('xmlns')) delete node.attrs[key];
  }

  for (const child of node.children) {
    if (typeof child !== 'string') normalizeNamespaces(child, ns);
  }
}

/* ============================================================================
 * 4. 树查询小工具
 * ========================================================================== */

function localName(name) {
  const idx = name.indexOf(':');
  return idx < 0 ? name : name.slice(idx + 1);
}

function attr(node, name) {
  if (!node || !node.attrs) return null;
  const v = node.attrs[name];
  return v === undefined ? null : v;
}

function findChild(node, name) {
  if (!node) return null;
  for (const child of node.children) {
    if (typeof child !== 'string' && child.name === name) return child;
  }
  return null;
}

function findChildren(node, name) {
  const out = [];
  if (!node) return out;
  for (const child of node.children) {
    if (typeof child !== 'string' && child.name === name) out.push(child);
  }
  return out;
}

function findChildLoose(node, local) {
  if (!node) return null;
  for (const child of node.children) {
    if (typeof child !== 'string' && localName(child.name) === local) return child;
  }
  return null;
}

function findDescendant(node, name) {
  if (!node) return null;
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (child.name === name) return child;
    const found = findDescendant(child, name);
    if (found) return found;
  }
  return null;
}

function findDescendantLoose(node, local) {
  if (!node) return null;
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (localName(child.name) === local) return child;
    const found = findDescendantLoose(child, local);
    if (found) return found;
  }
  return null;
}

function textContent(node) {
  if (!node) return '';
  let out = '';
  for (const child of node.children) if (typeof child === 'string') out += child;
  return out;
}

/** parseXml 返回的是 #document 包装节点，取它下面的第一个元素当根 */
function rootElement(node) {
  if (!node || node.name !== '#document') return node;
  for (const child of node.children) if (typeof child !== 'string') return child;
  return node;
}

/** w:b / w:i / w:u / w:strike 这类开关属性：w:val="0" 是关闭 */
function isOn(node) {
  if (!node) return false;
  const v = attr(node, 'w:val');
  if (v == null) return true;
  const s = String(v).toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off' || s === 'none');
}

function readUnderline(node) {
  const v = attr(node, 'w:val');
  if (v == null) return true;
  const s = String(v).toLowerCase();
  return !(s === 'none' || s === '0' || s === 'false');
}

/** 读取 w:rPr 里的字符样式（三态：true / false / undefined=继承） */
function readRunProps(rPr) {
  const out = {};
  const b = findChild(rPr, 'w:b');
  if (b) out.b = isOn(b);
  const i = findChild(rPr, 'w:i');
  if (i) out.i = isOn(i);
  const u = findChild(rPr, 'w:u');
  if (u) out.u = readUnderline(u);
  const strike = findChild(rPr, 'w:strike');
  if (strike) out.s = isOn(strike);
  if (out.s === undefined) {
    const dstrike = findChild(rPr, 'w:dstrike');
    if (dstrike) out.s = isOn(dstrike);
  }
  return out;
}

/** 读取 w:pPr 里的段落属性 */
function readParaProps(pPr) {
  const out = {};
  const outline = findChild(pPr, 'w:outlineLvl');
  if (outline) {
    const v = parseInt(attr(outline, 'w:val'), 10);
    if (Number.isFinite(v)) out.outlineLvl = v;
  }
  const numPr = findChild(pPr, 'w:numPr');
  if (numPr) {
    const numIdNode = findChild(numPr, 'w:numId');
    const ilvlNode = findChild(numPr, 'w:ilvl');
    if (numIdNode) {
      const v = attr(numIdNode, 'w:val');
      if (v != null) out.numId = String(v);
    }
    if (ilvlNode) {
      const v = parseInt(attr(ilvlNode, 'w:val'), 10);
      out.ilvl = Number.isFinite(v) ? v : 0;
    }
  }
  const jc = findChild(pPr, 'w:jc');
  if (jc) {
    const v = attr(jc, 'w:val');
    if (v) out.jc = String(v);
  }
  return out;
}

/* ============================================================================
 * 5. styles.xml / numbering.xml / rels 解析
 * ========================================================================== */

function buildStyles(root) {
  const styles = new Map();
  const defaults = { rPr: {}, pPr: {} };

  const docDefaults = findChild(root, 'w:docDefaults');
  if (docDefaults) {
    const rPrDefault = findChild(docDefaults, 'w:rPrDefault');
    if (rPrDefault) {
      const rPr = findChild(rPrDefault, 'w:rPr');
      if (rPr) defaults.rPr = readRunProps(rPr);
    }
    const pPrDefault = findChild(docDefaults, 'w:pPrDefault');
    if (pPrDefault) {
      const pPr = findChild(pPrDefault, 'w:pPr');
      if (pPr) defaults.pPr = readParaProps(pPr);
    }
  }

  for (const styleNode of findChildren(root, 'w:style')) {
    const id = attr(styleNode, 'w:styleId');
    if (!id) continue;
    const nameNode = findChild(styleNode, 'w:name');
    const basedOnNode = findChild(styleNode, 'w:basedOn');
    const pPrNode = findChild(styleNode, 'w:pPr');
    const rPrNode = findChild(styleNode, 'w:rPr');
    styles.set(id, {
      id,
      type: attr(styleNode, 'w:type') || 'paragraph',
      name: nameNode ? attr(nameNode, 'w:val') || '' : '',
      basedOn: basedOnNode ? attr(basedOnNode, 'w:val') || null : null,
      pPr: pPrNode ? readParaProps(pPrNode) : {},
      rPr: rPrNode ? readRunProps(rPrNode) : {},
    });
  }

  return { styles, defaults };
}

function buildNumbering(root) {
  const abstract = new Map(); // abstractNumId -> Map<ilvl, numFmt>
  const nums = new Map(); // numId -> { abstractId, overrides: Map<ilvl, numFmt> }

  for (const an of findChildren(root, 'w:abstractNum')) {
    const id = attr(an, 'w:abstractNumId');
    if (id == null) continue;
    const levels = new Map();
    for (const lvl of findChildren(an, 'w:lvl')) {
      const ilvl = parseInt(attr(lvl, 'w:ilvl'), 10) || 0;
      const fmtNode = findChild(lvl, 'w:numFmt');
      const fmt = fmtNode ? attr(fmtNode, 'w:val') : null;
      if (fmt) levels.set(ilvl, fmt);
    }
    abstract.set(String(id), levels);
  }

  for (const num of findChildren(root, 'w:num')) {
    const id = attr(num, 'w:numId');
    if (id == null) continue;
    const absNode = findChild(num, 'w:abstractNumId');
    const overrides = new Map();
    for (const ov of findChildren(num, 'w:lvlOverride')) {
      const ilvl = parseInt(attr(ov, 'w:ilvl'), 10) || 0;
      const lvl = findChild(ov, 'w:lvl');
      if (!lvl) continue;
      const fmtNode = findChild(lvl, 'w:numFmt');
      const fmt = fmtNode ? attr(fmtNode, 'w:val') : null;
      if (fmt) overrides.set(ilvl, fmt);
    }
    nums.set(String(id), { abstractId: absNode ? String(attr(absNode, 'w:val') ?? '') : '', overrides });
  }

  return { abstract, nums };
}

function buildRels(root) {
  const map = new Map();
  const visit = (node) => {
    for (const child of node.children) {
      if (typeof child === 'string') continue;
      if (localName(child.name) === 'Relationship') {
        const id = attr(child, 'Id') || attr(child, 'id');
        if (!id) continue;
        map.set(id, {
          id,
          type: attr(child, 'Type') || '',
          target: attr(child, 'Target') || '',
          mode: attr(child, 'TargetMode') || '',
        });
      } else {
        visit(child);
      }
    }
  };
  visit(root);
  return map;
}

/** 编号类型 → 列表标签：bullet → ul，其它 → ol（契约规定） */
function listTagFor(numbering, numId, ilvl) {
  const num = numbering.nums.get(String(numId));
  let fmt = null;
  if (num) {
    if (num.overrides.has(ilvl)) fmt = num.overrides.get(ilvl);
    else {
      const levels = numbering.abstract.get(num.abstractId);
      if (levels && levels.has(ilvl)) fmt = levels.get(ilvl);
    }
  }
  return fmt === 'bullet' ? 'ul' : 'ol';
}

/* ============================================================================
 * 6. 标题识别
 * ========================================================================== */

function normalizeStyleKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s_\-]+/g, '');
}

/** 样式 id 形如 Heading1 / heading 1 / 标题 1 / 标题1 */
function headingLevelFromStyleKey(value) {
  const key = normalizeStyleKey(value);
  if (!key) return 0;
  let m = /^heading([1-9])$/.exec(key);
  if (m) return clampHeading(parseInt(m[1], 10));
  m = /^标题([1-9])$/.exec(key);
  if (m) return clampHeading(parseInt(m[1], 10));
  return 0;
}

/* ============================================================================
 * 7. 图片 MIME
 * ========================================================================== */

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

/** 只允许安全协议，挡掉 javascript:/vbscript:/data: 这类 XSS 向量 */
function safeHref(href) {
  if (!href) return null;
  const probe = String(href).replace(/[\u0000-\u0020\u007f]+/g, '');
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(probe);
  if (!m) return href; // 相对路径
  const scheme = m[1].toLowerCase();
  if (scheme === 'javascript' || scheme === 'vbscript' || scheme === 'data') return null;
  return href;
}

function cssLengthToPx(num, unit) {
  const v = parseFloat(num);
  if (!Number.isFinite(v)) return 0;
  switch (String(unit || '').toLowerCase()) {
    case 'px': return v;
    case 'pt': return (v * 96) / 72;
    case 'in': return v * 96;
    case 'cm': return (v * 96) / 2.54;
    case 'mm': return (v * 96) / 25.4;
    case 'pc': return v * 16;
    default: return 0;
  }
}

/* ============================================================================
 * 8. 转换器
 * ========================================================================== */

class DocxConverter {
  constructor(buf, entries) {
    this.buf = buf;
    this.entries = entries;
    this.entriesLower = new Map();
    for (const [key, value] of entries) this.entriesLower.set(key.toLowerCase(), value);

    this.warnings = [];
    this.warnSet = new Set();

    this.styles = new Map();
    this.defaults = { rPr: {}, pPr: {} };
    this.numbering = { abstract: new Map(), nums: new Map() };
    this.rels = new Map();

    this.styleCache = new Map();
    this.mediaCache = new Map();

    this.stylesMissing = false;
    this.stylesWarned = false;
    this.numberingMissing = false;
    this.numberingWarned = false;
    this.relsMissing = false;
    this.relsWarned = false;

    this.firstHeadingText = '';
    this.counters = { charts: 0, footnotes: 0, altChunks: 0 };
  }

  /* ---------- 基础 ---------- */

  warn(message) {
    if (this.warnSet.has(message)) return;
    if (this.warnings.length >= MAX_WARNINGS) return;
    this.warnSet.add(message);
    this.warnings.push(message);
  }

  findEntry(path) {
    if (!path) return null;
    return this.entries.get(path) || this.entriesLower.get(String(path).toLowerCase()) || null;
  }

  readText(path) {
    const entry = this.findEntry(path);
    if (!entry) return null;
    try {
      return readZipEntry(this.buf, entry).toString('utf8').replace(/^\uFEFF/, '');
    } catch (e) {
      this.warn(`无法读取 ${path}：${e && e.message ? e.message : e}`);
      return null;
    }
  }

  parsePart(xmlText) {
    const root = parseXml(xmlText);
    normalizeNamespaces(root, null);
    return root;
  }

  /* ---------- 样式 ---------- */

  resolveStyle(styleId) {
    if (!styleId) return { rPr: {}, pPr: {}, name: '' };
    const cached = this.styleCache.get(styleId);
    if (cached) return cached;

    const chain = [];
    const seen = new Set();
    let cursor = styleId;
    while (cursor && this.styles.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(this.styles.get(cursor));
      cursor = this.styles.get(cursor).basedOn;
    }

    const merged = { rPr: {}, pPr: {}, name: '' };
    for (let i = chain.length - 1; i >= 0; i--) {
      const style = chain[i];
      if (style.name) merged.name = style.name;
      Object.assign(merged.rPr, style.rPr);
      Object.assign(merged.pPr, style.pPr);
    }

    if (!chain.length && this.stylesMissing && !this.stylesWarned) {
      this.stylesWarned = true;
      this.warn('未找到 word/styles.xml，段落样式已忽略（标题仍按样式名推断）。');
    }

    this.styleCache.set(styleId, merged);
    return merged;
  }

  /** 段落最终属性：样式链 + 段落直接格式 */
  stylePropsFor(pPr) {
    const pStyleNode = pPr ? findChild(pPr, 'w:pStyle') : null;
    const styleId = pStyleNode ? attr(pStyleNode, 'w:val') : null;
    const base = styleId ? this.resolveStyle(styleId) : { rPr: {}, pPr: {}, name: '' };
    const direct = pPr ? readParaProps(pPr) : {};
    return {
      styleId: styleId || null,
      name: base.name,
      rPr: base.rPr,
      pPr: { ...base.pPr, ...direct },
    };
  }

  /** 字符格式：docDefaults → 样式链 → 直接格式 */
  runFmtFor(styleProps) {
    return { b: false, i: false, u: false, s: false, ...this.defaults.rPr, ...styleProps.rPr };
  }

  headingLevelFor(styleProps) {
    let level = headingLevelFromStyleKey(styleProps.styleId);
    if (!level) level = headingLevelFromStyleKey(styleProps.name);
    if (!level) {
      const outline = styleProps.pPr.outlineLvl;
      if (outline != null && Number.isFinite(outline) && outline >= 0 && outline <= 8) {
        level = clampHeading(outline + 1);
      }
    }
    return level;
  }

  /* ---------- 列表 ---------- */

  listInfoFor(p) {
    const pPr = findChild(p, 'w:pPr');
    const styleProps = this.stylePropsFor(pPr);

    let numId = null;
    let ilvl = 0;
    const numPr = pPr ? findChild(pPr, 'w:numPr') : null;
    if (numPr) {
      const numIdNode = findChild(numPr, 'w:numId');
      const ilvlNode = findChild(numPr, 'w:ilvl');
      if (numIdNode) {
        const v = attr(numIdNode, 'w:val');
        if (v != null) numId = String(v);
      }
      if (ilvlNode) {
        const v = parseInt(attr(ilvlNode, 'w:val'), 10);
        if (Number.isFinite(v)) ilvl = v;
      }
    }
    if (numId == null && styleProps.pPr.numId != null) {
      numId = String(styleProps.pPr.numId);
      ilvl = styleProps.pPr.ilvl || 0;
    }
    if (numId == null || numId === '0') return null;

    if (this.numberingMissing && !this.numberingWarned) {
      this.numberingWarned = true;
      this.warn('未找到 word/numbering.xml，列表将按默认编号（无序/有序）渲染。');
    }

    return { numId, ilvl: Math.max(0, ilvl), tag: listTagFor(this.numbering, numId, Math.max(0, ilvl)) };
  }

  renderListItem(p) {
    const pPr = findChild(p, 'w:pPr');
    const styleProps = this.stylePropsFor(pPr);
    const fmt = this.runFmtFor(styleProps);
    return this.renderInline(p.children, fmt).split(PAGEBREAK).join('');
  }

  /** items: [{ level, tag, html }] → 嵌套好的 ul/ol */
  renderList(items) {
    if (!items.length) return '';
    const root = { level: -1, node: { children: [] } };
    const stack = [{ level: -1, node: root.node }];
    for (const item of items) {
      const level = Math.max(0, item.level | 0);
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const node = { level, html: item.html, tag: item.tag, children: [] };
      stack[stack.length - 1].node.children.push(node);
      stack.push({ level, node });
    }
    return this.renderListNodes(root.node.children);
  }

  renderListNodes(nodes) {
    if (!nodes.length) return '';
    const tag = nodes[0].tag === 'ol' ? 'ol' : 'ul';
    let out = `<${tag}>`;
    for (const node of nodes) {
      out += `<li>${node.html}`;
      if (node.children.length) out += this.renderListNodes(node.children);
      out += '</li>';
    }
    return `${out}</${tag}>`;
  }

  /* ---------- 块级 ---------- */

  renderBlocks(nodes) {
    let out = '';
    let i = 0;
    while (i < nodes.length) {
      const node = nodes[i];
      if (typeof node === 'string') {
        i++;
        continue;
      }

      switch (node.name) {
        case 'w:p': {
          const listInfo = this.listInfoFor(node);
          if (listInfo) {
            const items = [];
            let j = i;
            while (j < nodes.length) {
              const candidate = nodes[j];
              // 元素之间的空白文本节点直接跳过，不能打断列表分组
              if (typeof candidate === 'string') {
                j++;
                continue;
              }
              if (candidate.name !== 'w:p') break;
              const info = this.listInfoFor(candidate);
              if (!info || info.numId !== listInfo.numId) break;
              items.push({ level: info.ilvl, tag: info.tag, html: this.renderListItem(candidate) });
              j++;
            }
            out += this.renderList(items);
            i = j;
            continue;
          }
          out += this.renderParagraph(node);
          i++;
          break;
        }
        case 'w:tbl':
          out += this.renderTable(node);
          i++;
          break;
        case 'w:sdt': {
          const content = findChild(node, 'w:sdtContent');
          out += this.renderBlocks(content ? content.children : node.children);
          i++;
          break;
        }
        case 'w:customXml':
        case 'w:ins':
        case 'w:moveTo':
        case 'w:dir':
        case 'w:bdo':
          out += this.renderBlocks(node.children);
          i++;
          break;
        case 'mc:AlternateContent': {
          const choice = findChild(node, 'mc:Choice');
          const target = choice || findChild(node, 'mc:Fallback');
          if (target) out += this.renderBlocks(target.children);
          i++;
          break;
        }
        case 'w:altChunk':
          this.counters.altChunks++;
          i++;
          break;
        case 'w:del':
        case 'w:moveFrom':
        case 'w:sectPr':
        case 'w:bookmarkStart':
        case 'w:bookmarkEnd':
        case 'w:proofErr':
        case 'w:commentRangeStart':
        case 'w:commentRangeEnd':
        default:
          i++;
          break;
      }
    }
    return out;
  }

  renderParagraph(p) {
    const pPr = findChild(p, 'w:pPr');
    const styleProps = this.stylePropsFor(pPr);
    const fmt = this.runFmtFor(styleProps);
    const inline = this.renderInline(p.children, fmt);
    const level = this.headingLevelFor(styleProps);
    const align = this.alignClassFor(pPr, styleProps);
    const pageBreakBefore = pPr ? isOn(findChild(pPr, 'w:pageBreakBefore')) : false;

    let out = pageBreakBefore ? '<hr class="dm-docx-pagebreak">' : '';

    if (level > 0) {
      // 标题里若夹了分页符：去掉占位符，标题后面补一个 <hr>
      const segments = inline.split(PAGEBREAK);
      const headingInline = segments.filter(Boolean).join(' ').trim();
      if (!headingInline) return out;
      const tag = `h${level}`;
      const text = htmlToText(headingInline);
      if (text && !this.firstHeadingText) this.firstHeadingText = text;
      out += `<${tag}${align}>${headingInline}</${tag}>`;
      if (segments.length > 1) out += '<hr class="dm-docx-pagebreak">';
      return out;
    }

    if (!inline) return out;

    const parts = inline.split(PAGEBREAK);
    if (parts.length === 1) {
      if (!inline.trim()) return out;
      return `${out}<p${align}>${inline}</p>`;
    }
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      if (seg.trim()) out += `<p${align}>${seg}</p>`;
      if (i < parts.length - 1) out += '<hr class="dm-docx-pagebreak">';
    }
    return out;
  }

  alignClassFor(pPr, styleProps) {
    let jc = null;
    const jcNode = pPr ? findChild(pPr, 'w:jc') : null;
    if (jcNode) jc = attr(jcNode, 'w:val');
    if (!jc) jc = styleProps.pPr.jc || null;
    if (!jc) return '';
    const map = {
      center: 'center',
      right: 'right',
      end: 'right',
      both: 'justify',
      distribute: 'justify',
      start: 'left',
      left: 'left',
    };
    const value = map[String(jc).toLowerCase()];
    if (!value || value === 'left') return '';
    return ` class="dm-docx-align-${value}"`;
  }

  /* ---------- 行内 ---------- */

  renderInline(nodes, fmt) {
    let out = '';
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      switch (node.name) {
        case 'w:r':
          out += this.renderRun(node, fmt);
          break;
        case 'w:hyperlink':
          out += this.renderHyperlink(node, fmt);
          break;
        case 'w:ins':
        case 'w:moveTo':
        case 'w:smartTag':
        case 'w:customXml':
        case 'w:dir':
        case 'w:bdo':
        case 'w:fldSimple':
          out += this.renderInline(node.children, fmt);
          break;
        case 'w:sdt': {
          const content = findChild(node, 'w:sdtContent');
          out += this.renderInline(content ? content.children : node.children, fmt);
          break;
        }
        case 'mc:AlternateContent': {
          const choice = findChild(node, 'mc:Choice');
          const target = choice || findChild(node, 'mc:Fallback');
          if (target) out += this.renderInline(target.children, fmt);
          break;
        }
        default:
          break;
      }
    }
    return out;
  }

  renderRun(run, inheritedFmt) {
    const rPr = findChild(run, 'w:rPr');
    const fmt = rPr ? { ...inheritedFmt, ...readRunProps(rPr) } : inheritedFmt;
    return this.wrapFmt(this.renderRunChildren(run.children, fmt), fmt);
  }

  renderRunChildren(children, fmt) {
    let content = '';
    for (const node of children) {
      if (typeof node === 'string') continue;
      switch (node.name) {
        case 'w:t':
          content += escapeHtml(textContent(node));
          break;
        case 'w:tab':
        case 'w:ptab':
          content += '\t';
          break;
        case 'w:br':
          content += attr(node, 'w:type') === 'page' ? PAGEBREAK : '<br>';
          break;
        case 'w:cr':
          content += '<br>';
          break;
        case 'w:noBreakHyphen':
          content += '\u2011';
          break;
        case 'w:softHyphen':
          content += '\u00ad';
          break;
        case 'w:drawing':
          content += this.renderDrawing(node);
          break;
        case 'w:pict':
          content += this.renderPict(node);
          break;
        case 'w:object':
          this.warn('文档包含嵌入式 OLE 对象，已跳过。');
          break;
        case 'w:sym':
          content += this.renderSymbol(node);
          break;
        case 'w:footnoteReference':
        case 'w:endnoteReference':
          this.counters.footnotes++;
          break;
        case 'mc:AlternateContent': {
          const choice = findChild(node, 'mc:Choice');
          const target = choice || findChild(node, 'mc:Fallback');
          if (target) content += this.renderRunChildren(target.children, fmt);
          break;
        }
        default:
          break;
      }
    }
    return content;
  }

  /** 加粗/斜体/下划线/删除线包装；分页标记必须留在标签外面 */
  wrapFmt(content, fmt) {
    if (!content) return content;
    if (content.indexOf(PAGEBREAK) !== -1) {
      return content
        .split(PAGEBREAK)
        .map((seg) => (seg ? this.wrapPlain(seg, fmt) : ''))
        .join(PAGEBREAK);
    }
    return this.wrapPlain(content, fmt);
  }

  wrapPlain(content, fmt) {
    let out = content;
    if (fmt.s) out = `<s>${out}</s>`;
    if (fmt.u) out = `<u>${out}</u>`;
    if (fmt.i) out = `<em>${out}</em>`;
    if (fmt.b) out = `<strong>${out}</strong>`;
    return out;
  }

  renderSymbol(node) {
    const ch = attr(node, 'w:char');
    if (!ch) return '';
    const code = parseInt(ch, 16);
    if (!Number.isFinite(code) || code <= 0) return '';
    // 私有区（Wingdings 等符号字体）在浏览器里是豆腐块，跳过
    if (code >= 0xe000 && code <= 0xf8ff) return '';
    try {
      return escapeHtml(String.fromCodePoint(code));
    } catch {
      return '';
    }
  }

  renderHyperlink(node, fmt) {
    const inner = this.renderInline(node.children, fmt);
    if (!inner) return '';
    const rid = attr(node, 'r:id');
    let href = null;
    if (rid) {
      const rel = this.rels.get(rid);
      if (!rel && !this.rels.size) this.warnMissingRels();
      if (rel && rel.target && rel.mode === 'External') href = safeHref(rel.target);
      else if (rel && rel.target && /^(https?|mailto|tel|ftp):/i.test(rel.target)) href = safeHref(rel.target);
    }
    if (!href) return inner; // 内部书签链接：只保留文本
    return `<a class="dm-docx-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${inner}</a>`;
  }

  warnMissingRels() {
    if (this.relsWarned) return;
    this.relsWarned = true;
    this.warn('未找到 word/_rels/document.xml.rels，超链接与图片可能无法解析。');
  }

  /* ---------- 图片 ---------- */

  resolveImage(relId) {
    const rel = this.rels.get(relId);
    if (!rel) {
      if (!this.rels.size) this.warnMissingRels();
      this.warn(`图片关系 ${relId} 不存在，已跳过一张图片。`);
      return '';
    }

    let target = rel.target || '';
    try {
      target = decodeURIComponent(target);
    } catch {
      /* 保留原样 */
    }
    const path = resolveZipPath('word', target);
    if (!path) {
      this.warn(`图片关系 ${relId} 没有目标路径，已跳过。`);
      return '';
    }

    const cached = this.mediaCache.get(path);
    if (cached !== undefined) return cached;

    const entry = this.findEntry(path);
    if (!entry) {
      this.warn(`找不到图片文件 ${path}，已跳过。`);
      this.mediaCache.set(path, '');
      return '';
    }

    const ext = (path.split('.').pop() || '').toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      this.warn(`不支持的图片格式 .${ext}（${path}），已跳过。`);
      this.mediaCache.set(path, '');
      return '';
    }

    let data;
    try {
      data = readZipEntry(this.buf, entry);
    } catch {
      this.warn(`图片 ${path} 解压失败，已跳过。`);
      this.mediaCache.set(path, '');
      return '';
    }

    const dataUrl = `data:${mime};base64,${data.toString('base64')}`;
    this.mediaCache.set(path, dataUrl);
    return dataUrl;
  }

  renderImage(relId, size, alt) {
    const src = this.resolveImage(relId);
    if (!src) return '';
    const w = size && size.width > 0 ? ` width="${size.width}"` : '';
    const h = size && size.height > 0 ? ` height="${size.height}"` : '';
    return `<img class="dm-docx-img" src="${src}" alt="${escapeHtml(alt || '')}"${w}${h} loading="lazy">`;
  }

  readExtent(node) {
    const extent = findDescendant(node, 'wp:extent') || findDescendant(node, 'a:ext');
    if (!extent) return null;
    const cx = parseFloat(attr(extent, 'cx'));
    const cy = parseFloat(attr(extent, 'cy'));
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx <= 0 || cy <= 0) return null;
    return {
      width: Math.max(1, Math.round(cx / EMU_PER_PX)),
      height: Math.max(1, Math.round(cy / EMU_PER_PX)),
    };
  }

  readAltText(node) {
    const docPr = findDescendant(node, 'wp:docPr');
    if (docPr) {
      const descr = attr(docPr, 'descr');
      if (descr) return descr;
      const name = attr(docPr, 'name');
      if (name) return name;
    }
    return '';
  }

  renderDrawing(node) {
    let out = '';

    const textbox = findDescendant(node, 'w:txbxContent');
    if (textbox) out += this.renderTextbox(textbox);

    const blip = findDescendant(node, 'a:blip');
    if (blip) {
      const rid = attr(blip, 'r:embed') || attr(blip, 'r:link');
      if (rid) out += this.renderImage(rid, this.readExtent(node), this.readAltText(node));
    }

    if (findDescendant(node, 'c:chart') || findDescendant(node, 'dgm:relIds')) {
      this.counters.charts++;
    }
    return out;
  }

  renderPict(node) {
    let out = '';

    const textbox = findDescendant(node, 'w:txbxContent');
    if (textbox) out += this.renderTextbox(textbox);

    const imagedata = findDescendant(node, 'v:imagedata');
    if (imagedata) {
      const rid = attr(imagedata, 'r:id') || attr(imagedata, 'o:relid');
      if (rid) {
        out += this.renderImage(rid, this.readVmlSize(node), attr(imagedata, 'o:title') || '');
      }
    }
    return out;
  }

  readVmlSize(node) {
    const shape =
      findDescendant(node, 'v:shape') || findDescendant(node, 'v:rect') || findDescendant(node, 'v:image');
    const style = shape ? attr(shape, 'style') : null;
    if (!style) return null;
    const wm = /(?:^|;)\s*width\s*:\s*([0-9.]+)\s*(px|pt|in|cm|mm|pc)/i.exec(style);
    const hm = /(?:^|;)\s*height\s*:\s*([0-9.]+)\s*(px|pt|in|cm|mm|pc)/i.exec(style);
    if (!wm || !hm) return null;
    const width = Math.round(cssLengthToPx(wm[1], wm[2]));
    const height = Math.round(cssLengthToPx(hm[1], hm[2]));
    if (!(width > 0) || !(height > 0)) return null;
    return { width, height };
  }

  /** 文本框降级成行内 span（避免在 <p> 里塞块级元素） */
  renderTextbox(txbxContent) {
    const parts = [];
    for (const node of txbxContent.children) {
      if (typeof node === 'string') continue;
      if (node.name !== 'w:p') continue;
      const pPr = findChild(node, 'w:pPr');
      const styleProps = this.stylePropsFor(pPr);
      const fmt = this.runFmtFor(styleProps);
      const html = this.renderInline(node.children, fmt).split(PAGEBREAK).join(' ');
      if (html.trim()) parts.push(html);
    }
    if (!parts.length) return '';
    return `<span class="dm-docx-textbox">${parts.join('<br>')}</span>`;
  }

  /* ---------- 表格 ---------- */

  renderTable(tbl) {
    const rows = [];
    for (const node of tbl.children) {
      if (typeof node === 'string') continue;
      if (node.name === 'w:tr') {
        rows.push(this.readRow(node));
      } else if (node.name === 'w:sdt' || node.name === 'w:customXml') {
        const content = findChild(node, 'w:sdtContent') || node;
        for (const child of content.children) {
          if (typeof child !== 'string' && child.name === 'w:tr') rows.push(this.readRow(child));
        }
      }
    }
    if (!rows.length) return '';

    const grid = this.computeRowspans(rows);
    let body = '';
    for (const row of grid) {
      let tr = '';
      for (const cell of row) {
        if (cell.skip) continue;
        const colspan = cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '';
        const rowspan = cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : '';
        tr += `<td${colspan}${rowspan}>${cell.html}</td>`;
      }
      if (tr) body += `<tr>${tr}</tr>`;
    }
    if (!body) return '';
    return `<table class="dm-docx-table"><tbody>${body}</tbody></table>`;
  }

  readRow(tr) {
    const cells = [];
    for (const node of tr.children) {
      if (typeof node === 'string') continue;
      if (node.name === 'w:tc') {
        cells.push(this.readCell(node));
      } else if (node.name === 'w:sdt' || node.name === 'w:customXml') {
        const content = findChild(node, 'w:sdtContent') || node;
        for (const child of content.children) {
          if (typeof child !== 'string' && child.name === 'w:tc') cells.push(this.readCell(child));
        }
      }
    }
    return cells;
  }

  readCell(tc) {
    const tcPr = findChild(tc, 'w:tcPr');
    let colspan = 1;
    let vmerge = null;
    if (tcPr) {
      const gridSpan = findChild(tcPr, 'w:gridSpan');
      if (gridSpan) {
        const v = parseInt(attr(gridSpan, 'w:val'), 10);
        if (Number.isFinite(v) && v > 1) colspan = v;
      }
      const vMerge = findChild(tcPr, 'w:vMerge');
      if (vMerge) vmerge = attr(vMerge, 'w:val') === 'restart' ? 'restart' : 'continue';
    }
    return { colspan, vmerge, html: this.renderCellContent(tc) };
  }

  renderCellContent(tc) {
    const blocks = [];
    for (const node of tc.children) {
      if (typeof node === 'string') continue;
      if (node.name === 'w:tcPr') continue;
      blocks.push(node);
    }

    // 单元格里只有一个普通段落时直接内联，避免 <td><p> 多一层
    const meaningful = blocks.filter(
      (node) =>
        node.name !== 'w:bookmarkStart' &&
        node.name !== 'w:bookmarkEnd' &&
        node.name !== 'w:proofErr' &&
        node.name !== 'w:commentRangeStart' &&
        node.name !== 'w:commentRangeEnd',
    );
    if (meaningful.length === 1 && meaningful[0].name === 'w:p') {
      const p = meaningful[0];
      const pPr = findChild(p, 'w:pPr');
      const styleProps = this.stylePropsFor(pPr);
      const isList = !!this.listInfoFor(p);
      const isHeading = this.headingLevelFor(styleProps) > 0;
      if (!isList && !isHeading) {
        const fmt = this.runFmtFor(styleProps);
        return this.renderInline(p.children, fmt).split(PAGEBREAK).join(' ');
      }
    }

    return this.renderBlocks(blocks);
  }

  /** 把 vMerge 的延续单元格折算成起始单元格的 rowspan */
  computeRowspans(rows) {
    const out = rows.map(() => []);
    const open = new Map(); // 列号 -> { cell }

    for (let r = 0; r < rows.length; r++) {
      const bumped = new Set();
      let col = 0;
      for (const cell of rows[r]) {
        const span = cell.colspan > 0 ? cell.colspan : 1;
        if (cell.vmerge === 'continue') {
          const start = open.get(col);
          if (start) {
            if (!bumped.has(start.cell)) {
              start.cell.rowspan += 1;
              bumped.add(start.cell);
            }
            out[r].push({ skip: true });
          } else {
            // 孤立的延续单元格：留一个空格子保持列对齐
            out[r].push({ skip: false, html: '', colspan: 1, rowspan: 1 });
          }
          col += span;
          continue;
        }

        const record = { skip: false, html: cell.html, colspan: span, rowspan: 1 };
        out[r].push(record);
        if (cell.vmerge === 'restart') {
          for (let c = col; c < col + span; c++) open.set(c, { cell: record });
        } else {
          for (let c = col; c < col + span; c++) open.delete(c);
        }
        col += span;
      }
    }
    return out;
  }

  /* ---------- 主流程 ---------- */

  convert() {
    const docEntry = this.findEntry('word/document.xml');
    if (!docEntry) {
      throw new DocxError(
        '不是有效的 .docx：压缩包里没有 word/document.xml（可能是旧版 .doc，或设置了打开密码的文档）。',
      );
    }

    let documentXml;
    try {
      documentXml = readZipEntry(this.buf, docEntry).toString('utf8').replace(/^\uFEFF/, '');
    } catch (e) {
      throw new DocxError(`无法读取 word/document.xml：${e && e.message ? e.message : e}`);
    }

    // styles.xml
    const stylesXml = this.readText('word/styles.xml');
    if (stylesXml) {
      const root = rootElement(this.parsePart(stylesXml));
      const built = buildStyles(root);
      this.styles = built.styles;
      this.defaults = built.defaults;
    } else {
      this.stylesMissing = true;
    }

    // numbering.xml
    const numberingXml = this.readText('word/numbering.xml');
    if (numberingXml) {
      this.numbering = buildNumbering(rootElement(this.parsePart(numberingXml)));
    } else {
      this.numberingMissing = true;
    }

    // rels
    const relsXml = this.readText('word/_rels/document.xml.rels');
    if (relsXml) {
      this.rels = buildRels(rootElement(this.parsePart(relsXml)));
    } else {
      this.relsMissing = true;
    }

    // 正文
    let html = '';
    try {
      const docRoot = this.parsePart(documentXml);
      const body = findDescendant(docRoot, 'w:body') || docRoot;
      html = this.renderBlocks(body.children);
    } catch (e) {
      this.warn(`解析 word/document.xml 时出错，正文可能不完整：${e && e.message ? e.message : e}`);
    }

    // 标题
    let title = '';
    const coreXml = this.readText('docProps/core.xml');
    if (coreXml) {
      try {
        const coreRoot = this.parsePart(coreXml);
        const titleNode = findDescendantLoose(coreRoot, 'title');
        if (titleNode) title = textContent(titleNode).trim();
      } catch {
        /* 忽略：title 只是锦上添花 */
      }
    }
    if (!title) title = this.firstHeadingText;

    // 未渲染内容的提示
    if (this.counters.charts > 0) {
      this.warn(`文档包含 ${this.counters.charts} 个图表/图形对象，当前版本未渲染。`);
    }
    if (this.counters.footnotes > 0) {
      this.warn(`文档包含 ${this.counters.footnotes} 处脚注/尾注引用，脚注内容未渲染。`);
    }
    if (this.counters.altChunks > 0) {
      this.warn(`文档包含 ${this.counters.altChunks} 个嵌入的外部文档（altChunk），已跳过。`);
    }
    const hasHeaderFooter = [...this.entries.keys()].some((name) =>
      /^word\/(header|footer)[^/]*\.xml$/i.test(name),
    );
    if (hasHeaderFooter) this.warn('文档包含页眉/页脚，当前版本未渲染。');

    const fragment = `<div class="dm-docx-doc">${html}</div>`;
    return { html: fragment, title, warnings: this.warnings.slice() };
  }
}

/* ============================================================================
 * 9. 对外入口
 * ========================================================================== */

/**
 * 把 .docx 字节转换成可读、可选中、语义化的 HTML 片段。
 *
 * @param {Uint8Array|Buffer|ArrayBuffer} bytes .docx 文件字节
 * @returns {{ html: string, title: string, warnings: string[] }}
 * @throws {DocxError} 只在「不是 ZIP」或「压缩包里没有 word/document.xml」时抛出（错误信息为中文）
 */
export function convertDocxToHtml(bytes) {
  const buf = toBuffer(bytes);
  if (!buf || buf.length < 22) {
    throw new DocxError('文件太小，不是有效的 .docx（ZIP）文件。');
  }
  // OLE 复合文档：旧版 .doc，或加了打开密码的 .docx
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    throw new DocxError('这是旧版 .doc 或设置了打开密码的文档（OLE 复合文档），不是 .docx。请先用 Word 另存为 .docx。');
  }

  let entries;
  try {
    entries = readZipEntries(buf);
  } catch (e) {
    if (e instanceof DocxError) throw e;
    throw new DocxError(`解析 .docx（ZIP）失败：${e && e.message ? e.message : e}`);
  }

  return new DocxConverter(buf, entries).convert();
}

export default convertDocxToHtml;

/* ============================================================================
 * 特性清单（实现范围）
 * ----------------------------------------------------------------------------
 * ✅ 块级：w:p / w:tbl / w:sdt / w:customXml / w:ins / w:del（跳过） / mc:AlternateContent
 * ✅ 标题：w:pStyle 形如 Heading1 / heading 1 / 标题 1，兜底 w:outlineLvl
 * ✅ 行内：w:r、w:t（xml:space 空格原样保留）、w:tab → \t、w:br → <br>、
 *          w:cr、w:noBreakHyphen、w:softHyphen、w:sym（跳过私有区）
 * ✅ 字符格式：w:b / w:i / w:u / w:strike / w:dstrike（w:val="0" 视为关闭）
 * ✅ 列表：w:numPr(numId+ilvl) → 嵌套 ul/ol/li，编号类型查 numbering.xml（bullet → ul，其它 → ol）
 * ✅ 表格：w:tbl/tr/tc，w:gridSpan → colspan，w:vMerge → rowspan，单元格内可嵌套表格
 * ✅ 图片：w:drawing / a:blip(r:embed) 与 VML w:pict/v:imagedata → data:<mime>;base64
 * ✅ 超链接：w:hyperlink r:id → rels Target（仅 TargetMode=External 输出 href；内部书签只留文本）
 * ✅ 分页：w:br w:type="page" 与 w:pageBreakBefore → <hr class="dm-docx-pagebreak">
 * ✅ 文本框：w:txbxContent 降级成行内 <span class="dm-docx-textbox">
 * ✅ 对齐：w:jc → dm-docx-align-center/right/justify
 * ✅ 样式继承：styles.xml 的 basedOn 链 + docDefaults
 * ✅ 命名空间归一化：默认命名空间 / 非规范前缀也能解析
 * ✅ 健壮性：缺 styles/numbering/rels/media 全部降级并记 warning；坏图跳过
 *
 * ⚠️ 已知限制（未实现）：
 *   - 页眉 / 页脚（word/header*.xml、footer*.xml）不渲染，仅给 warning
 *   - 脚注 / 尾注正文（word/footnotes.xml、endnotes.xml）不渲染，仅给 warning
 *   - 图表（chart）、SmartArt、嵌入式 OLE 对象、altChunk 不渲染，仅给 warning
 *   - 浮动图片（wp:anchor）按行内图片输出，丢失环绕/定位
 *   - 主题色 / 字号 / 字体 / 高亮 / 底纹 / 页边距不输出（只保留语义结构）
 *   - 修订标记：接受 w:ins 内容，忽略 w:del 内容（不显示删除线痕迹）
 *   - 表格列宽（tblGrid）不输出 colgroup，交给调用方 CSS
 *   - 公式（OMML）不渲染
 * ========================================================================== */
