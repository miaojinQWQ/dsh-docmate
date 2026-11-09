/**
 * DocMate — Host half (immersive research desk).
 *
 * The panel is not a file browser. The user drags the documents they want to study into it,
 * and this half owns the resulting research workspace:
 *
 *   <DSH_HOME>/docmate/
 *     index.json               — the ordered list of documents
 *     docs/<id>/source.<ext>   — the bytes exactly as dropped
 *     docs/<id>/text.md        — normalised full text (what the agent reads)
 *     docs/<id>/memory.md      — the durable research memory for this document
 *
 * Four responsibilities:
 *
 *   1. `/api/docmate/*` — a small read/write HTTP surface for the panel. Every request
 *      re-applies the Harness connection's own Host/Origin + browser-credential check via
 *      `connection.requestRejection()`, so these routes are as protected as the shipped
 *      `/api` surface even though they are mounted on the Web carrier directly.
 *   2. Ingestion — turning a dropped file into `source` + `text.md`. docx goes through the
 *      bundled OOXML converter; PDF text is extracted in the browser by pdf.js and posted
 *      back, because only the browser has a PDF text engine.
 *   3. One ordinary Harness Session per document, plus the **full-text sync**: on first
 *      open the whole document (and the current memory) is injected into that session, so
 *      the agent is not guessing from a selection.
 *   4. Two model-facing tools — `docmate_read` and `docmate_memory` — so the agent can
 *      re-read any part of any document and keep durable notes. They are only visible in
 *      sessions that belong to this workspace.
 */
import { readFile, writeFile, readdir, stat, mkdir, rm, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* One asset root for every vendored runtime: `pdfjs/*` and `katex/*` are served under
 * `/api/docmate/asset/<sub>/…`, so adding a library never needs a new route. */
const ASSET_DIR = path.join(HERE, 'assets');
const API_PREFIX = '/api/docmate';

const DSH_HOME =
  typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh');
const DATA_DIR = path.join(DSH_HOME, 'docmate');
const DOCS_DIR = path.join(DATA_DIR, 'docs');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

/** How much of a document is pasted straight into the session on first open. */
const INLINE_TEXT_LIMIT = 24000;
/** 注入内容的版本。改了 `contextMessage` 就 +1，老文档会在下次打开时重新注入。 */
const CONTEXT_VERSION = 2;
/** Tool-side read window. */
const DEFAULT_READ_LIMIT = 12000;
const MAX_READ_LIMIT = 40000;
const MAX_UPLOAD_BYTES = 96 * 1024 * 1024;

/** Extensions the reader accepts. */
const DOC_EXTENSIONS = new Set([
  '.md', '.markdown',
  '.txt',
  '.docx',
  '.pdf',
  '.json', '.csv', '.tsv', '.yaml', '.yml',
  '.html', '.htm',
]);

const MIME = {
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export const name = 'dsh-docmate';
export const inject = ['webServer', 'connection'];

/* ── tiny helpers ──────────────────────────────────────────────────────── */

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function ok(body) {
  return json(200, { ok: true, ...body });
}

function fail(status, code, message) {
  return json(status, { ok: false, error: { code, message } });
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function extOf(file) {
  return path.extname(String(file || '')).toLowerCase();
}

function service(ctx, key) {
  try {
    return ctx.get(key) || null;
  } catch (error) {
    return null;
  }
}

/** A display name that cannot escape its directory and cannot be empty. */
function safeName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  return cleaned === '' ? 'untitled' : cleaned.slice(0, 180);
}

/* ── the research workspace on disk ────────────────────────────────────── */

let indexCache = null;
let writeChain = Promise.resolve();

async function loadIndex() {
  if (indexCache) return indexCache;
  const primary = await readIndexFile(INDEX_FILE);
  if (primary) {
    indexCache = primary;
    return indexCache;
  }
  // 主文件读到了但解析不了（断电半截写、用户手改、从坏备份恢复）：退回上一代 `.bak`。
  // 不这么做的话，`index.json` 一坏，`/api/docmate/*` 全线 500，面板连文档列表都打不开。
  const backup = await readIndexFile(INDEX_FILE + '.bak');
  if (backup) {
    indexCache = backup;
    return indexCache;
  }
  indexCache = { version: 1, docs: [] };
  return indexCache;
}

/** 读一份索引；文件不存在或内容坏了都返回 null，只有真正的 I/O 故障才抛。 */
async function readIndexFile(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    // A transient read failure must NOT be cached as "the research area is empty": the next
    // save would then overwrite a perfectly good index with nothing.
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return { version: 1, docs: Array.isArray(parsed && parsed.docs) ? parsed.docs : [] };
  } catch (error) {
    return null;
  }
}

function saveIndex() {
  if (!indexCache) return Promise.resolve();
  const snapshot = JSON.stringify(indexCache, null, 2);
  writeChain = writeChain
    .then(async () => {
      await mkdir(DATA_DIR, { recursive: true });
      const temporary = INDEX_FILE + '.tmp';
      await writeFile(temporary, snapshot, 'utf8');
      // Keep the previous generation so a bad write is recoverable by hand.
      try {
        await rename(INDEX_FILE, INDEX_FILE + '.bak');
      } catch (error) {
        /* first write: there is nothing to back up */
      }
      await rename(temporary, INDEX_FILE);
    })
    .catch(() => {
      /* a failed index write must not take the request down; the next one retries */
    });
  return writeChain;
}

function docDir(id) {
  return path.join(DOCS_DIR, id);
}

function sourcePath(doc) {
  return path.join(docDir(doc.id), 'source.' + doc.ext);
}

function textPath(id) {
  return path.join(docDir(id), 'text.md');
}

function memoryPath(id) {
  return path.join(docDir(id), 'memory.md');
}

function highlightsPath(id) {
  return path.join(docDir(id), 'highlights.json');
}

/** At most this many marks per document; the oldest are dropped first. */
const MAX_HIGHLIGHTS = 2000;

async function readHighlightsOf(id) {
  try {
    const parsed = JSON.parse(await readFile(highlightsPath(id), 'utf8'));
    if (!Array.isArray(parsed && parsed.items)) return [];
    // 读出来再过一遍校验：`highlights.json` 被手改、从旧版本升级、或写到一半断电时，
    // 一条缺 `text`/`anchor` 的坏数据就能让注入全文和 `docmate_highlights` 一起抛异常。
    const items = [];
    for (const raw of parsed.items) {
      const item = normaliseHighlight(raw);
      if (item) items.push(item);
    }
    return items;
  } catch (error) {
    return [];
  }
}

async function writeHighlightsOf(id, items) {
  const trimmed = items.slice(-MAX_HIGHLIGHTS);
  await writeFile(highlightsPath(id), JSON.stringify({ version: 1, items: trimmed }, null, 2), 'utf8');
  return trimmed;
}

/* ── the research journal (automatic memory) ───────────────────────────── */

/** Auto entries are capped so a long research session cannot flood the injected context. */
const JOURNAL_MAX_LINES = 30;
const JOURNAL_MARK = '（自动）';

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function oneLine(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

/**
 * 同一篇文档的 `memory.md` 写入串行化。
 *
 * 自动流水是「读 → 改 → 整份写回」，面板的「保存」是一次整份覆盖。两边并发时后写
 * 会把先写冲掉——用户刚手存的记忆被一条自动流水顶掉的概率并不低。所有写入口都走这把锁。
 */
const memoryChains = new Map();

function withMemoryLock(docId, job) {
  const previous = memoryChains.get(docId) || Promise.resolve();
  const next = previous.then(job, job).catch(() => {});
  memoryChains.set(docId, next);
  next.then(() => {
    if (memoryChains.get(docId) === next) memoryChains.delete(docId);
  });
  return next;
}

/**
 * Append one compact record of a finished turn to the document's memory.
 *
 * This is the "automatic" half of memory: the agent curates `docmate_memory`, and this
 * keeps a bounded journal of what was actually asked and answered, so reopening a document
 * a week later still shows where the research went. Old auto lines are trimmed first.
 */
async function appendJournal(doc, question, answer) {
  const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ');
  const line = '- [' + stamp + '] ' + JOURNAL_MARK + '问：' + oneLine(question, 80) + ' ｜ 答：' + oneLine(answer, 160);
  await withMemoryLock(doc.id, async () => {
    const memory = await readMemoryOf(doc.id);
    const lines = memory === '' ? [] : memory.split('\n');
    const autoIndexes = [];
    lines.forEach((entry, index) => {
      if (entry.indexOf(JOURNAL_MARK) >= 0) autoIndexes.push(index);
    });
    while (autoIndexes.length >= JOURNAL_MAX_LINES) {
      lines.splice(autoIndexes.shift(), 1);
      for (let i = 0; i < autoIndexes.length; i += 1) autoIndexes[i] -= 1;
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(line);
    let next = lines.join('\n') + '\n';
    if (next.length > 24000) next = next.slice(next.length - 24000);
    await writeFile(memoryPath(doc.id), next, 'utf8');
  });
}

/**
 * Watch committed session events for a finished turn and journal it.
 *
 * `turn/end` is a durable Session event, so this fires exactly once per turn and survives
 * even when the panel is closed. The injected context message is skipped: it is our own
 * document dump, not something the user asked.
 */
function registerJournal(ctx) {
  if (typeof ctx.on !== 'function') return;
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        if (!event || event.type !== 'turn/end' || !session || !session.id) return;
        void (async () => {
          try {
            const doc = await docOfSession(session.id);
            if (!doc) return;
            const events = typeof session.ownEvents === 'function' ? session.ownEvents() : [];
            let question = '';
            let answer = '';
            for (let index = events.length - 1; index >= 0; index -= 1) {
              const entry = events[index];
              if (!answer && entry.type === 'assistant/message') {
                answer = messageText(entry.data && entry.data.message);
              }
              if (!question && entry.type === 'user/message') {
                const text = messageText(entry.data);
                if (text.indexOf('【研究区 · 文档已载入】') !== 0) question = text;
              }
              if (question && answer) break;
            }
            if (question === '' || answer.length < 120) return;
            await appendJournal(doc, question, answer);
          } catch (error) {
            /* journaling is a convenience: never let it disturb the session */
          }
        })();
      }),
    'docmate: turn journal',
  );
}

/** Keep only the fields we own; never persist whatever the browser happened to send. */function normaliseHighlight(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim().slice(0, 64) : '';
  if (id === '') return null;
  const text = typeof raw.text === 'string' ? raw.text.slice(0, 8000) : '';
  if (text.trim() === '') return null;
  const color = raw.color === 'key' || raw.color === 'question' || raw.color === 'review' ? raw.color : 'key';
  const anchor = raw.anchor && typeof raw.anchor === 'object' ? raw.anchor : {};
  const scope = anchor.scope === 'page' ? 'page' : 'doc';
  const page = scope === 'page' && Number.isFinite(anchor.page) ? Math.max(1, Math.floor(anchor.page)) : null;
  const start = Number.isFinite(anchor.start) ? Math.max(0, Math.floor(anchor.start)) : -1;
  const end = Number.isFinite(anchor.end) ? Math.max(0, Math.floor(anchor.end)) : -1;
  if (start < 0 || end <= start) return null;
  return {
    id,
    color,
    text,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 4000) : '',
    anchor: { scope, page, start, end },
    kind: raw.kind === 'quote' ? 'quote' : 'mark',
    createdAt: Number.isFinite(raw.createdAt) ? Math.floor(raw.createdAt) : Date.now(),
  };
}

async function readTextOf(id) {
  try {
    return await readFile(textPath(id), 'utf8');
  } catch (error) {
    return '';
  }
}

async function readMemoryOf(id) {
  try {
    return await readFile(memoryPath(id), 'utf8');
  } catch (error) {
    return '';
  }
}

async function findDoc(id) {
  const index = await loadIndex();
  return index.docs.find((entry) => entry.id === id) || null;
}

async function docOfSession(sessionId) {
  if (!sessionId) return null;
  const index = await loadIndex();
  return index.docs.find((entry) => entry.sessionId === sessionId) || null;
}

/* ── text normalisation ────────────────────────────────────────────────── */

function unescapeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(text) {
  return unescapeEntities(String(text || '').replace(/<[^>]+>/g, ''));
}

/**
 * HTML → light Markdown. The agent reads this, so keeping headings, list items and table
 * cells as structure is worth far more than a flat text dump.
 */
function htmlToMarkdown(html) {
  let text = String(html || '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (match, level, inner) => {
    return '\n\n' + '#'.repeat(Number(level)) + ' ' + stripTags(inner).trim() + '\n\n';
  });
  text = text.replace(/<li[^>]*>/gi, '\n- ');
  text = text.replace(/<\/(td|th)>/gi, ' | ');
  text = text.replace(/<hr[^>]*>/gi, '\n\n---\n\n');
  text = text.replace(/<\/(p|div|tr|blockquote|pre|ul|ol|table|h[1-6])>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = stripTags(text);
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ \| \n/g, ' |\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalisePlain(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let docxConverter;

async function loadDocxConverter() {
  if (docxConverter !== undefined) return docxConverter;
  try {
    const module = await import('./src/host/docx.js');
    docxConverter = typeof module.convertDocxToHtml === 'function' ? module.convertDocxToHtml : null;
  } catch (error) {
    docxConverter = null;
  }
  return docxConverter;
}

/**
 * Produce `text.md` for a freshly uploaded document. PDF returns '' on purpose: only the
 * browser has a PDF text engine, so the panel posts the extracted text back afterwards.
 */
async function extractTextFor(ext, bytes) {
  if (ext === 'pdf') return '';
  if (ext === 'docx') {
    const convert = await loadDocxConverter();
    if (!convert) return '';
    const converted = await convert(new Uint8Array(bytes));
    return htmlToMarkdown(converted.html);
  }
  const decoded = new TextDecoder('utf-8').decode(bytes);
  if (ext === 'html' || ext === 'htm') return htmlToMarkdown(decoded);
  return normalisePlain(decoded);
}

/* ── ingestion ─────────────────────────────────────────────────────────── */

async function createDoc(rawName, bytes) {
  const name = safeName(rawName);
  const ext = extOf(name).slice(1);
  if (!DOC_EXTENSIONS.has('.' + ext)) {
    throw Object.assign(new Error('不支持的格式：.' + ext + '（支持 ' + [...DOC_EXTENSIONS].join(' ') + '）'), {
      code: 'unsupported',
    });
  }
  if (bytes.length === 0) throw Object.assign(new Error('文件是空的'), { code: 'empty' });
  if (bytes.length > MAX_UPLOAD_BYTES) throw Object.assign(new Error('文件太大（上限 96MB）'), { code: 'too-large' });

  const id = 'd' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8);
  const doc = {
    id,
    name,
    ext,
    size: bytes.length,
    addedAt: Date.now(),
    title: '',
    chars: 0,
    hasText: false,
    sessionId: null,
    contextInjected: false,
  };

  await mkdir(docDir(id), { recursive: true });
  await writeFile(sourcePath(doc), bytes);

  let text = '';
  try {
    text = await extractTextFor(ext, bytes);
  } catch (error) {
    // A converter failure must not lose the upload: the file is stored, the panel can
    // still render it, and the agent simply has no text until the user asks again.
    doc.textError = messageOf(error);
  }
  if (text) {
    await writeFile(textPath(id), text, 'utf8');
    doc.chars = text.length;
    doc.hasText = true;
  }

  const index = await loadIndex();
  index.docs.unshift(doc);
  await saveIndex();
  return doc;
}

async function removeDoc(id) {
  // `id` 必须是我们自己生成的形状：索引被手改或从坏备份恢复时，
  // 一个 `..` 就能让 `rm(recursive)` 删到 `docs/` 外面去。
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return false;
  const index = await loadIndex();
  const position = index.docs.findIndex((entry) => entry.id === id);
  if (position < 0) return false;
  const target = docDir(id);
  const relation = path.relative(DOCS_DIR, target);
  if (relation === '' || relation.startsWith('..') || path.isAbsolute(relation)) return false;
  index.docs.splice(position, 1);
  await saveIndex();
  try {
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    /* the row is already gone from the user's list; a stale directory is harmless */
  }
  return true;
}

/* ── sessions: one per document, plus the full-text sync ───────────────── */

const SESSION_TITLE_PREFIX = '研究 · ';

async function resolveAgentObject(ctx, sessionId) {
  const controller = service(ctx, 'sessionController');
  if (!controller) return null;
  if (typeof controller.resolveAgent === 'function') {
    const resolved = await controller.resolveAgent(sessionId);
    if (resolved && resolved.error) return null;
  }
  const agents = service(ctx, 'agents');
  if (agents && typeof agents.get === 'function') return agents.get(sessionId) || null;
  return null;
}

async function createSessionForDoc(ctx, doc) {
  const controller = service(ctx, 'sessionController');
  let firstFailure = null;

  if (controller && typeof controller.create === 'function') {
    try {
      // `cwd` is the document's own folder: `text.md`, `memory.md` and `source.<ext>` all
      // live there, so the agent can also read them with ordinary tools.
      const created = await controller.create({ cwd: docDir(doc.id) });
      const sessionId = created && created.sessionId;
      if (sessionId) {
        try {
          if (typeof controller.rename === 'function') {
            await controller.rename({ sessionId, title: SESSION_TITLE_PREFIX + doc.name });
          }
        } catch (error) {
          /* a missing title service is not fatal */
        }
        return String(sessionId);
      }
      firstFailure = new Error('会话创建失败：Host 没有返回 sessionId');
    } catch (error) {
      firstFailure = error;
    }
  } else {
    firstFailure = new Error('这个 Host 没有会话服务（sessionController），伴随聊天不可用');
  }

  /*
   * Fallback for a Host whose session controller refuses a programmatic create: build the
   * agent directly. It only works when a deployment default model is known, because an
   * agent created without provider/model answers its first request with
   * "has no provider/model" — a session that looks fine and then fails is worse than a
   * clear error here.
   */
  const agents = service(ctx, 'agents');
  const defaults = service(ctx, 'agentDefaultModel');
  if (agents && typeof agents.create === 'function' && defaults && typeof defaults.currentSelection === 'function') {
    let selection = null;
    try {
      selection = defaults.currentSelection();
    } catch (error) {
      selection = null;
    }
    const provider = selection && typeof selection.provider === 'string' ? selection.provider.trim() : '';
    const model = selection && typeof selection.model === 'string' ? selection.model.trim() : '';
    if (provider !== '' && model !== '') {
      const sessionId = 'docmate-' + randomUUID();
      const agentOptions = { provider, model };
      if (selection.reasoningEffort) agentOptions.reasoningEffort = selection.reasoningEffort;
      await agents.create({ sessionId, meta: { cwd: docDir(doc.id) }, agentOptions });
      return sessionId;
    }
  }

  throw firstFailure || new Error('建不出伴随会话');
}

function contextMessage(doc, text, memory, highlights) {
  const lines = [];
  lines.push('【研究区 · 文档已载入】');
  lines.push('用户刚把《' + doc.name + '》拖进了伴随研究区。从这一刻起，这篇文档就是你们共同研究的对象。');
  lines.push('格式：' + doc.ext + ' · 全文 ' + (doc.chars || text.length) + ' 字');
  lines.push('');
  lines.push('## 已有的研究记忆');
  if (memory.trim() !== '') {
    lines.push(memory.trim());
  } else {
    lines.push('（还是空的。值得长期记住的结论请用 docmate_memory 追加。）');
  }
  lines.push('');
  if (highlights.length > 0) {
    const labels = { key: '重点', question: '疑问', review: '待复习' };
    lines.push('## 用户已经划下的线（' + highlights.length + ' 条，按时间排序）');
    for (const item of highlights.slice(-40)) {
      const where = item.anchor && item.anchor.scope === 'page' && item.anchor.page ? '（第 ' + item.anchor.page + ' 页）' : '';
      lines.push('- [' + (labels[item.color] || '重点') + ']' + where + ' ' + item.text.replace(/\s+/g, ' ').slice(0, 200));
    }
    if (highlights.length > 40) lines.push('- …（还有 ' + (highlights.length - 40) + ' 条）');
    lines.push('');
  }
  lines.push('## 全文');
  if (text === '') {
    lines.push('（这篇文档还没有抽取出正文——可能是扫描版 PDF。请让用户划选关键段落来提问。）');
  } else if (text.length <= INLINE_TEXT_LIMIT) {
    lines.push(text);
  } else {
    lines.push(text.slice(0, INLINE_TEXT_LIMIT));
    lines.push('');
    lines.push(
      '（全文共 ' + text.length + ' 字，上面是前 ' + INLINE_TEXT_LIMIT + ' 字。剩下的用 docmate_read 传 offset 继续读。）',
    );
  }
  lines.push('');
  // 回答风格放在「工作方式」前面，而且写得短：这是注入到每一篇文档会话里的**长期指令**，
  // 多一个字就多一次输入成本。用户明确要的是「沉浸式、快反馈」，不是长篇讲义。
  lines.push('## 回答风格（优先于其它习惯）');
  lines.push('- 默认精简：先一句话结论，再最多 3 条要点，正文控制在 150 字以内。');
  lines.push('- 只有用户说「展开」「详细讲」「逐句」时才写长文。');
  lines.push('- 不复述原文，不写过程说明（「我按你的要求没有…」这类一律不要）。');
  lines.push('');
  lines.push('## 工作方式');
  lines.push('- 用户划选一段再提问时，消息里带 `> 引用` 和「来自《文档》第 N 页」；回答贴着那段讲。');
  lines.push('- 要重读某段或看全文，用 docmate_read（可传 doc / offset / limit）。');
  lines.push('- 值得长期记住的东西（关键定义、用户的判断、未解决的问题），用 docmate_memory 追加一条。');
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: lines.join('\n') }],
    source: { kind: 'user' },
  };
}

/**
 * Push the whole document into the session once. `agent.inject()` enters the next admitted
 * step without waking the agent, which is exactly right: the context is ready before the
 * user's first question, and an idle session is not charged for it.
 *
 * `CONTEXT_VERSION` 是给「注入内容改版」用的：老文档的会话里躺着旧版指令，
 * 光改代码它们不会更新。版本号一变就重新注入一次（旧的那条留在历史里，无害）。
 */
async function syncContext(ctx, doc) {
  if (doc.contextInjected && doc.contextVersion === CONTEXT_VERSION) return false;
  const agent = await resolveAgentObject(ctx, doc.sessionId);
  if (!agent || typeof agent.inject !== 'function') return false;
  const text = await readTextOf(doc.id);
  const memory = await readMemoryOf(doc.id);
  const highlights = await readHighlightsOf(doc.id);
  agent.inject(contextMessage(doc, text, memory, highlights));
  doc.contextInjected = true;
  doc.contextVersion = CONTEXT_VERSION;
  await saveIndex();
  return true;
}

/**
 * 同一篇文档同时只允许一个「确保会话」在跑。
 * 面板切文档很快，A→B→A 会并发两次 `/doc/session`；没有这层锁时会建出两条会话，
 * 后写的覆盖 `doc.sessionId`，前一条连同注入的全文一起变成孤儿。
 */
const sessionLocks = new Map();

async function ensureDocSession(ctx, doc) {
  const pending = sessionLocks.get(doc.id);
  if (pending) return pending;
  const task = ensureDocSessionUnlocked(ctx, doc);
  sessionLocks.set(doc.id, task);
  try {
    return await task;
  } finally {
    sessionLocks.delete(doc.id);
  }
}

async function ensureDocSessionUnlocked(ctx, doc) {
  let sessionId = doc.sessionId;
  let recreated = false;
  if (sessionId) {
    const agent = await resolveAgentObject(ctx, sessionId);
    if (!agent) {
      sessionId = null;
      recreated = true;
    }
  }
  if (!sessionId) {
    sessionId = await createSessionForDoc(ctx, doc);
    doc.sessionId = sessionId;
    doc.contextInjected = false;
    await saveIndex();
  }
  const injected = await syncContext(ctx, doc);
  return { sessionId, injected, recreated };
}

async function askSession(ctx, sessionId, text, image, docId) {
  const controller = service(ctx, 'sessionController');
  if (!controller || typeof controller.prompt !== 'function') {
    throw new Error('这个 Host 没有会话服务（sessionController），发不出消息');
  }
  if (typeof controller.resolveAgent === 'function') {
    const resolved = await controller.resolveAgent(sessionId);
    if (resolved && resolved.error) throw new Error('这条会话打不开：' + (resolved.error.code || 'unknown'));
  }
  const content = [{ type: 'text', text }];
  if (image) {
    content.push({
      type: 'image',
      mediaType: image.mediaType,
      data: image.data,
      name: image.name || 'selection.png',
    });
  }
  // requestId 只生成一次：它既是 prompt 的去重键，也是宿主写进 message.source.rpcId 的值，
  // 快速识图的守卫就靠它把「这一轮」认出来。所以必须在 prompt 之前登记。
  const requestId = randomUUID();
  const vision = image ? visionBegin(requestId, sessionId, docId) : null;
  // 这个 120 秒只覆盖「消息接纳」这一次调用，不是整轮预算——真正的刹车在 registerVisionGuard。
  const cancellation = new AbortController();
  const timer = setTimeout(() => cancellation.abort(), 120000);
  try {
    await controller.prompt(
      { requestId, sessionId, mode: 'queue', content },
      cancellation.signal,
    );
  } catch (error) {
    if (vision) {
      vision.phase = 'failed';
      vision.reason = 'prompt-failed';
      vision.endedAt = Date.now();
      visionPending.delete(requestId);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return requestId;
}

/* ── 框选截图：校验 + 落盘 ─────────────────────────────────────────────── */

const SHOT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const SHOT_MAX_BASE64 = 11 * 1024 * 1024;

/**
 * 把客户端传来的 `{ mediaType, data }` 规整成可以直接塞进 prompt 的图片片段。
 * `data` 允许带 `data:image/png;base64,` 前缀（客户端用 canvas.toDataURL 拿到的就是它）。
 * 任何一条不合规就返回 null——宁可发一条纯文字，也不要让整条消息 500。
 */
function normaliseImage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let mediaType = typeof raw.mediaType === 'string' ? raw.mediaType.trim().toLowerCase() : 'image/png';
  if (SHOT_TYPES.indexOf(mediaType) < 0) mediaType = 'image/png';
  let data = typeof raw.data === 'string' ? raw.data.trim() : '';
  const comma = data.indexOf('base64,');
  if (data.slice(0, 5) === 'data:' && comma >= 0) data = data.slice(comma + 7);
  data = data.replace(/\s+/g, '');
  if (!data || data.length > SHOT_MAX_BASE64) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 64))) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : '';
  return { mediaType, data, name };
}

/** 截图存到这篇文档自己的目录下（`docs/<id>/shots/`），返回绝对路径；失败不挡消息。 */
async function saveShot(docId, image) {
  const id = typeof docId === 'string' ? docId.trim() : '';
  if (!id || !/^[\w-]+$/.test(id)) return '';
  const ext = image.mediaType === 'image/jpeg' ? 'jpg' : image.mediaType === 'image/webp' ? 'webp' : 'png';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    const dir = path.join(docDir(id), 'shots');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'shot-' + stamp + '.' + ext);
    await writeFile(file, Buffer.from(image.data, 'base64'));
    return file;
  } catch (error) {
    return '';
  }
}

/* ── 快速识图轮次：刹车 ────────────────────────────────────────────────────
 *
 * 框选一张扫描件问 AI 时，模型看到「缺图」的题会自作主张去画图、建文件、跑脚本，
 * 实测一次 882K token / 16 步。提示词拦不住它，所以这里用宿主**真实的**三个
 * waterfall 给「这一轮」装上硬限制：
 *
 *   agent/pre-step     绑定轮次（靠 message.source.rpcId 认出我们发的那条消息），
 *                      第 3 步起、或整轮 token 超预算时返回 { kind: 'reject' }
 *   agent/request      只给这一轮把单次输出上限压到 1000（返回新对象，不改持久配置）
 *   tools/pre-execute  只给这一轮拒掉所有工具调用（{ kind: 'deny', reason }）
 *   session/event      从 assistant/message 的 usage 累计，turn/end 收尾
 *
 * 作用域全部靠「这一轮的 AbortSignal」：宿主每个 turn 新建一个 AbortController，
 * 同一 turn 内所有 step 共用同一个 signal，所以 WeakMap<AbortSignal, 状态> 是
 * 精确到轮次的，不会误伤同一会话里的其它轮次，更不会全局禁用工具。
 * 认不出轮次时一律放行——宁可漏拦，也不能把别人的工具关掉。
 */

const VISION = {
  /** 最多 2 步：第 1 步读图回答，第 2 步是被拒工具后重答；第 3 步开始一律拒绝。 */
  maxSteps: 2,
  /** 单次模型请求的输出上限，只作用于快速识图轮次。
   *  这个数是「思考 + 正文」的总闸。用户要的是快反馈，所以正文靠提示词压到 150 字以内，
   *  这里只留够思考的余量：实测 4000 足够「想清楚 + 说三句」；再大只会纵容它写长文。
   *  真被截断时面板会说明原因，不会静默。 */
  maxOutputTokens: 4000,
  /**
   * 整轮预算上限。**口径是「新增 token」= 未缓存输入 + 输出**，不是计费总额。
   *
   * 为什么不用 billed：这个 profile 装了 50 多个工具，光 schema 就让第一次请求的
   * 输入稳定在 24K 左右，再加上下文缓存读 13K，billed 一上来就 38K——按 billed 卡 30K
   * 等于第一步就断路，模型连回答的机会都没有。而插件没有任何接口能缩减工具目录
   * （见 registerVisionGuard 里的说明），所以这部分基线不是「跑飞」。
   * 真正会随跑飞线性增长的是「未缓存输入 + 输出」，用它当预算才拦得住 16 步那种事。
   * billed 仍然单独记录，面板照实显示。
   */
  maxTurnTokens: 30000,
  /** 整轮墙钟上限；到点取消**真实运行中**的 turn，而不只是取消 prompt 入队。 */
  timeoutMs: 45000,
  /** 记录保留多久，供面板轮询读结果。 */
  logTtlMs: 5 * 60 * 1000,
  /** 一直没被认领 / 一直没收尾的轮次，超过这个时间直接从两个 map 里清掉。 */
  staleMs: 10 * 60 * 1000,
};

/** requestId → 已登记、还没被 pre-step 认领的请求。 */
const visionPending = new Map();
/** 这一轮的 AbortSignal → 轮次状态。 */
const visionTurns = new WeakMap();
/** `${sessionId}#${turn}` → 轮次状态（`session/event` 里拿不到 signal）。 */
const visionByTurn = new Map();
/** requestId → 对外可读的记录（含已结束的，供面板轮询）。 */
const visionLog = new Map();

function visionClearTimer(entry) {
  if (entry && entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

/** 记一次「刹车踩下」。reason 一旦写下就不再改，后面只做收尾。 */
function visionMarkTripped(entry, reason) {
  if (!entry || entry.reason) return;
  entry.reason = reason;
  entry.phase = 'tripped';
  entry.endedAt = Date.now();
  visionClearTimer(entry);
}

/**
 * 45 秒到点：取消真实运行中的 turn。
 * `keepInbox: true` 是为了不连带清掉用户在这期间排队的别的消息——只掐这一轮。
 */
function visionTripTimeout(entry) {
  if (!entry || entry.phase !== 'running' || entry.reason) return;
  visionMarkTripped(entry, 'timeout');
  const agent = entry.agent;
  if (!agent || typeof agent.cancel !== 'function') return;
  try {
    agent.cancel({ kind: 'hook', reason: 'docmate:vision-timeout' }, { keepInbox: true });
  } catch (error) {
    /* 取消失败也不能把异常抛回宿主循环 */
  }
}

/** 把一次请求绑定到它真正开始跑的那个 turn 上。 */
function visionBind(entry, agent, signal, turn) {
  entry.phase = 'running';
  entry.turn = turn;
  entry.agent = agent || null;
  entry.signal = signal;
  entry.startedAt = Date.now();
  visionPending.delete(entry.requestId);
  visionTurns.set(signal, entry);
  if (agent && agent.session && agent.session.id) visionByTurn.set(agent.session.id + '#' + turn, entry);
  visionClearTimer(entry);
  entry.timer = setTimeout(() => visionTripTimeout(entry), VISION.timeoutMs);
  if (typeof entry.timer.unref === 'function') entry.timer.unref();
  return entry;
}

/**
 * 认出「这一轮是不是快速识图」。
 * 先查 signal（同一 turn 的后续 step 走这条快路），再查消息上的 `source.rpcId`
 * ——那是 `sessionController.prompt({ requestId })` 写进去的，也是唯一可靠的关联。
 */
function visionClaim(payload) {
  if (!payload || !payload.signal) return null;
  const cached = visionTurns.get(payload.signal);
  if (cached) return cached;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    const source = message && message.source;
    if (!source || source.kind !== 'user') continue;
    const rpcId = typeof source.rpcId === 'string' ? source.rpcId : '';
    if (rpcId === '') continue;
    const entry = visionPending.get(rpcId);
    if (entry) return visionBind(entry, payload.agent, payload.signal, payload.turn || 0);
  }
  return null;
}

/** 这一步能不能开始。返回 null 表示放行。 */
function visionGate(entry, step) {
  if (!entry) return null;
  if (entry.reason) return entry.reason;
  if (step > VISION.maxSteps) return 'steps';
  if (entry.usage.fresh >= VISION.maxTurnTokens) return 'tokens';
  return null;
}

/**
 * 累计用量。宿主的 `TokenUsage` 是**互斥**计数：`inputTokens` 只是未缓存输入，
 * 缓存命中/写入单列。所以这里同时记两个口径：
 *   billed = 未缓存输入 + 缓存读 + 缓存写 + 输出（真实花费，面板显示用）
 *   fresh  = 未缓存输入 + 输出（会随跑飞线性增长的部分，预算闸用）
 */
function visionAddUsage(entry, usage) {
  if (!usage || typeof usage !== 'object') return;
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  entry.usage.input += num(usage.inputTokens);
  entry.usage.output += num(usage.outputTokens);
  entry.usage.cacheRead += num(usage.cacheReadTokens);
  entry.usage.cacheWrite += num(usage.cacheWriteTokens);
  entry.usage.reported += num(usage.totalTokens);
  entry.usage.billed = entry.usage.input + entry.usage.output + entry.usage.cacheRead + entry.usage.cacheWrite;
  entry.usage.fresh = entry.usage.input + entry.usage.output;
}

function visionPrune() {
  const now = Date.now();
  for (const [id, entry] of visionLog) {
    const age = now - (entry.endedAt || entry.queuedAt);
    if (entry.phase === 'pending' || entry.phase === 'running') {
      // 一直没被 pre-step 认领的请求（会话忙、消息被丢弃）不能永久占着两个 map。
      if (age > VISION.staleMs) {
        visionClearTimer(entry);
        visionPending.delete(id);
        if (entry.sessionId && entry.turn) visionByTurn.delete(entry.sessionId + '#' + entry.turn);
        visionLog.delete(id);
      }
      continue;
    }
    if (age > VISION.logTtlMs) visionLog.delete(id);
  }
}

/** 登记一次快速识图请求。必须在 `controller.prompt` **之前**调用。 */
function visionBegin(requestId, sessionId, docId) {
  const entry = {
    requestId,
    sessionId: sessionId || '',
    docId: docId || '',
    phase: 'pending',
    reason: null,
    queuedAt: Date.now(),
    startedAt: 0,
    endedAt: 0,
    turn: 0,
    steps: 0,
    calls: 0,
    denied: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reported: 0, billed: 0, fresh: 0 },
    timer: null,
    agent: null,
    signal: null,
  };
  visionPending.set(requestId, entry);
  visionLog.set(requestId, entry);
  visionPrune();
  return entry;
}

/** 面板能读到的形状。`state` 是 pending / running / tripped / done / failed。 */
function visionPublic(entry) {
  if (!entry) return { state: 'unknown' };
  return {
    id: entry.requestId,
    state: entry.phase,
    reason: entry.reason,
    turn: entry.turn,
    steps: entry.steps,
    calls: entry.calls,
    denied: entry.denied,
    usage: { ...entry.usage },
    elapsedMs: (entry.endedAt || Date.now()) - (entry.startedAt || entry.queuedAt),
    limits: {
      maxSteps: VISION.maxSteps,
      maxOutputTokens: VISION.maxOutputTokens,
      maxTurnTokens: VISION.maxTurnTokens,
      timeoutMs: VISION.timeoutMs,
    },
  };
}

/**
 * 仅供测试：暴露内部状态与常量，好在 `test/host.test.mjs` 里断言刹车行为。
 * 尤其是 45 秒超时——真等 45 秒不现实，测试会临时把 `timeoutMs` 调小再恢复。
 * Cordis 只读 `name` / `inject` / `apply`，多导出一个对象不影响加载。
 */
export const visionInternals = {
  VISION,
  visionLog,
  visionPending,
  visionByTurn,
  visionGate,
  visionAddUsage,
  visionPublic,
  visionTripTimeout,
};

/**
 * 装上刹车。三个 waterfall 都只在 `visionClaim` 认出轮次时才动手；
 * 认不出就原样 `next()`，普通文字提问和其它会话完全不受影响。
 */
function registerVisionGuard(ctx) {
  if (typeof ctx.on !== 'function') return;

  const offStep = ctx.on('agent/pre-step', async (payload, next) => {
    let entry = null;
    try {
      entry = visionClaim(payload);
    } catch (error) {
      entry = null;
    }
    if (entry) {
      const step = payload && typeof payload.step === 'number' ? payload.step : 0;
      const blocked = visionGate(entry, step);
      if (blocked) {
        // 拒绝会让这一步被丢弃、turn 以 blocked 结束——不会自动再开一轮。
        visionMarkTripped(entry, blocked);
        return { kind: 'reject' };
      }
      entry.steps = Math.max(entry.steps, step);
    }
    return next();
  });

  const offRequest = ctx.on('agent/request', async (payload, next) => {
    const config = await next();
    try {
      const entry = payload && payload.signal ? visionTurns.get(payload.signal) : null;
      if (!entry) return config;
      const cap = VISION.maxOutputTokens;
      const current = config && typeof config.maxTokens === 'number' && config.maxTokens > 0 ? config.maxTokens : Infinity;
      if (current <= cap) return config;
      // 返回新对象：宿主给的 seedConfig 是 deepFreeze 的，改它会炸。
      return { ...config, maxTokens: cap };
    } catch (error) {
      return config;
    }
  });

  const offTool = ctx.on('tools/pre-execute', async (exec, next) => {
    let entry = null;
    try {
      entry = exec && exec.signal ? visionTurns.get(exec.signal) : null;
    } catch (error) {
      entry = null;
    }
    if (!entry) return next();
    entry.denied += 1;
    const name = exec && typeof exec.name === 'string' && exec.name ? exec.name : '这个工具';
    return {
      kind: 'deny',
      reason:
        '快速识图轮次是只读的：' +
        name +
        ' 被拦下了。请只依据截图回答；截图里缺什么就直接说缺什么，不要补画、不要创建文件、不要运行代码。',
    };
  });

  /* 尝试过但**做不到**的一层，留在这里免得下一个人重踩：
   * 想让「这一轮的请求里根本没有工具」，宿主没有可用的接口。
   *   · `system-prompt/assemble` 的入参是 `PromptPresentation`（sections/contexts/variables），
   *     没有 `tools`；官方契约原话是 "tool declarations remain provider-owned"。
   *   · `SystemPrompt.tools(provider)` 只能**追加**，不能过滤。
   *   · `tools.register(def, { when })` 的 when 是 agent 级，不是 turn 级。
   * 所以工具目录缩不掉（这个 profile 50 多个工具，光 schema 就占掉输入大头），
   * 工具限制只能落在 `tools/pre-execute` 的运行时拒绝上——那是**真的不执行**，
   * 但模型仍然看得见工具、仍可能先试一次。 */
  const offEvent = ctx.on('session/event', (session, event) => {
    if (!event || !session || !session.id) return;
    try {
      const data = event.data || {};
      if (event.type === 'assistant/message') {
        const entry = visionByTurn.get(session.id + '#' + data.turn);
        if (!entry) return;
        entry.calls += 1;
        visionAddUsage(entry, data.usage);
        return;
      }
      if (event.type !== 'turn/end') return;
      const key = session.id + '#' + data.turn;
      const entry = visionByTurn.get(key);
      if (!entry) return;
      visionByTurn.delete(key);
      visionClearTimer(entry);
      const kind = data.reason && data.reason.kind ? data.reason.kind : 'completed';
      if (!entry.reason) {
        if (kind === 'max-tokens') entry.reason = 'max-tokens';
        else if (kind === 'aborted') entry.reason = 'aborted';
        else if (kind === 'error') entry.reason = 'error';
      }
      entry.phase = entry.reason ? 'tripped' : 'done';
      entry.endedAt = Date.now();
      if (entry.signal) visionTurns.delete(entry.signal);
      entry.agent = null;
      entry.signal = null;
    } catch (error) {
      /* 观察者永远不能影响会话 */
    }
  });

  ctx.effect(
    () => () => {
      offStep();
      offRequest();
      offTool();
      offEvent();
      for (const entry of visionLog.values()) visionClearTimer(entry);
      visionPending.clear();
      visionByTurn.clear();
      visionLog.clear();
    },
    'docmate: vision guard',
  );
}

/* ── model-facing tools ────────────────────────────────────────────────── */

function toolRender(args, value) {
  const text = value && typeof value.text === 'string' ? value.text : '';
  return [{ type: 'text', text }];
}

function readTool(ctx) {
  return {
    name: 'docmate_read',
    description:
      '读取研究区里一篇文档的正文（默认当前文档）。可分段读：offset 是字符偏移，limit 是本次最多返回多少字。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        doc: { type: 'string', description: '文档名或 id；省略表示当前会话对应的那篇文档。' },
        offset: { type: 'integer', description: '起始字符偏移，默认 0。' },
        limit: { type: 'integer', description: '本次最多返回多少字，默认 12000，最大 40000。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'total', 'offset', 'eof'],
        properties: {
          text: { type: 'string' },
          total: { type: 'integer' },
          offset: { type: 'integer' },
          eof: { type: 'boolean' },
        },
      },
      render: toolRender,
    },
    async execute(args, run) {
      const input = args && typeof args === 'object' ? args : {};
      const index = await loadIndex();
      const sessionId = run && run.agent ? run.agent.id : null;
      let doc = null;
      if (typeof input.doc === 'string' && input.doc.trim() !== '') {
        const needle = input.doc.trim().toLowerCase();
        doc =
          index.docs.find((entry) => entry.id === needle) ||
          index.docs.find((entry) => entry.name.toLowerCase() === needle) ||
          index.docs.find((entry) => entry.name.toLowerCase().includes(needle)) ||
          null;
      } else {
        doc = index.docs.find((entry) => entry.sessionId === sessionId) || null;
      }
      if (!doc) {
        return { text: '研究区里没有这篇文档。可用的有：' + (index.docs.map((entry) => entry.name).join('、') || '（空）'), total: 0, offset: 0, eof: true };
      }
      const full = await readTextOf(doc.id);
      if (full === '') {
        return { text: '《' + doc.name + '》没有可读正文（可能是扫描版 PDF）。', total: 0, offset: 0, eof: true };
      }
      const offset = Number.isFinite(input.offset) ? Math.max(0, Math.floor(input.offset)) : 0;
      const limit = Number.isFinite(input.limit)
        ? Math.min(MAX_READ_LIMIT, Math.max(200, Math.floor(input.limit)))
        : DEFAULT_READ_LIMIT;
      const slice = full.slice(offset, offset + limit);
      const end = offset + slice.length;
      const head = offset > 0 ? '（从第 ' + offset + ' 字开始）\n' : '';
      const tail = end < full.length ? '\n\n（还有 ' + (full.length - end) + ' 字没读，用 offset=' + end + ' 继续）' : '';
      return {
        text: head + slice + tail,
        total: full.length,
        offset,
        eof: end >= full.length,
      };
    },
  };
}

function memoryTool() {
  return {
    name: 'docmate_memory',
    description:
      '读写当前文档的「研究记忆」。action=read 读取；action=append 追加一条（推荐，保留历史）；action=replace 整份替换。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['read', 'append', 'replace'], description: '要做的操作。' },
        text: { type: 'string', description: 'append / replace 时的正文；append 会自动加时间戳与分隔。' },
        doc: { type: 'string', description: '文档名或 id；省略表示当前会话对应的那篇。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'chars'],
        properties: { text: { type: 'string' }, chars: { type: 'integer' } },
      },
      render: toolRender,
    },
    async execute(args, run) {
      const input = args && typeof args === 'object' ? args : {};
      const index = await loadIndex();
      const sessionId = run && run.agent ? run.agent.id : null;
      let doc = null;
      if (typeof input.doc === 'string' && input.doc.trim() !== '') {
        const needle = input.doc.trim().toLowerCase();
        doc = index.docs.find((entry) => entry.id === needle || entry.name.toLowerCase().includes(needle)) || null;
      } else {
        doc = index.docs.find((entry) => entry.sessionId === sessionId) || null;
      }
      if (!doc) return { text: '研究区里没有这篇文档，记不了。', chars: 0 };

      const current = await readMemoryOf(doc.id);
      const action = String(input.action || 'read');
      if (action === 'read') {
        return { text: current.trim() === '' ? '（研究记忆还是空的）' : current, chars: current.length };
      }
      const body = typeof input.text === 'string' ? input.text.trim() : '';
      if (body === '') return { text: '没有给要记的内容。', chars: current.length };

      let next;
      if (action === 'replace') {
        next = body + '\n';
      } else {
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        next = (current.trim() === '' ? '' : current.trimEnd() + '\n\n') + '- [' + stamp + '] ' + body + '\n';
      }
      await writeFile(memoryPath(doc.id), next, 'utf8');
      return { text: '已写入《' + doc.name + '》的研究记忆（现在 ' + next.length + ' 字）。', chars: next.length };
    },
  };
}

function highlightsTool() {
  const LABEL = { key: '重点', question: '疑问', review: '待复习' };
  return {
    name: 'docmate_highlights',
    description: '读出研究区某篇文档里用户划的线（重点 / 疑问 / 待复习 / 提问时留下的引用），可按颜色筛选。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        doc: { type: 'string', description: '文档名或 id；省略表示当前会话对应的那篇。' },
        color: {
          type: 'string',
          enum: ['all', 'key', 'question', 'review', 'quote'],
          description: '只取某一类；默认 all。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'count'],
        properties: { text: { type: 'string' }, count: { type: 'integer' } },
      },
      render: toolRender,
    },
    async execute(args, run) {
      const input = args && typeof args === 'object' ? args : {};
      const index = await loadIndex();
      const sessionId = run && run.agent ? run.agent.id : null;
      let doc = null;
      if (typeof input.doc === 'string' && input.doc.trim() !== '') {
        const needle = input.doc.trim().toLowerCase();
        doc = index.docs.find((entry) => entry.id === needle || entry.name.toLowerCase().includes(needle)) || null;
      } else {
        doc = index.docs.find((entry) => entry.sessionId === sessionId) || null;
      }
      if (!doc) return { text: '研究区里没有这篇文档。', count: 0 };

      const all = await readHighlightsOf(doc.id);
      const wanted = typeof input.color === 'string' ? input.color : 'all';
      const items = wanted === 'all' ? all : all.filter((item) => (wanted === 'quote' ? item.kind === 'quote' : item.color === wanted && item.kind !== 'quote'));
      if (items.length === 0) {
        return { text: '《' + doc.name + '》里还没有符合条件的划线。', count: 0 };
      }
      const lines = items.slice(-80).map((item, position) => {
        const where = item.anchor && item.anchor.scope === 'page' && item.anchor.page ? '（第 ' + item.anchor.page + ' 页）' : '';
        const kind = item.kind === 'quote' ? '引用' : LABEL[item.color] || '重点';
        const note = item.note ? ' 〔备注：' + item.note + '〕' : '';
        return position + 1 + '. [' + kind + ']' + where + ' ' + item.text.replace(/\s+/g, ' ').slice(0, 300) + note;
      });
      return {
        text: '《' + doc.name + '》的划线（' + items.length + ' 条）：\n\n' + lines.join('\n'),
        count: items.length,
      };
    },
  };
}

function registerTools(ctx) {
  const tools = service(ctx, 'tools');
  if (!tools || typeof tools.register !== 'function') return;
  // Only visible in sessions that belong to this workspace, so other conversations in the
  // profile are not handed two tools they can do nothing with.
  const when = async (activation) => {
    try {
      const index = await loadIndex();
      const id = activation && activation.agent ? activation.agent.id : null;
      return index.docs.some((entry) => entry.sessionId === id);
    } catch (error) {
      return false;
    }
  };
  try {
    ctx.effect(() => tools.register(readTool(ctx), { when }), 'docmate: docmate_read');
    ctx.effect(() => tools.register(memoryTool(), { when }), 'docmate: docmate_memory');
    ctx.effect(() => tools.register(highlightsTool(), { when }), 'docmate: docmate_highlights');
  } catch (error) {
    /* a host without conditional registration simply loses the tools, not the panel */
  }
}

/* ── routing ───────────────────────────────────────────────────────────── */

function insideAssets(relative) {
  const cleaned = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned === '' || cleaned.includes('..')) throw new Error('资源名非法');
  const absolute = path.resolve(ASSET_DIR, cleaned);
  const relation = path.relative(ASSET_DIR, absolute);
  if (relation.startsWith('..') || path.isAbsolute(relation)) throw new Error('资源名非法');
  return absolute;
}

async function handleAsset(request) {
  const url = new URL(request.url);
  let name;
  try {
    name = decodeURIComponent(url.pathname.slice((API_PREFIX + '/asset/').length));
  } catch (error) {
    // 畸形 `%` 会让 decodeURIComponent 抛 URIError；那是 400，不是 500。
    const bad = new Error('资源名不是合法的 URL 编码');
    bad.code = 'bad-request';
    throw bad;
  }
  const absolute = insideAssets(name);
  const bytes = await readFile(absolute);
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': MIME[extOf(absolute)] || 'application/octet-stream',
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function route(ctx, request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (pathname.startsWith(API_PREFIX + '/asset/')) return handleAsset(request);

  const action = pathname.slice(API_PREFIX.length).replace(/^\/+/, '');
  const query = url.searchParams;

  /* ── the document list ── */
  if (action === 'docs' && request.method === 'GET') {
    const index = await loadIndex();
    // `inlineLimit` 让面板能如实说明「注入进会话的是前 N 字」，而不是笼统写「已同步」。
    return ok({ docs: index.docs, dataDir: DATA_DIR, inlineLimit: INLINE_TEXT_LIMIT });
  }

  if (action === 'docs' && request.method === 'POST') {
    const raw = await request.arrayBuffer();
    const doc = await createDoc(query.get('name') || 'untitled', new Uint8Array(raw));
    return ok({ doc });
  }

  if (action === 'docs' && request.method === 'DELETE') {
    const id = query.get('id') || '';
    const removed = await removeDoc(id);
    return removed ? ok({ id }) : fail(404, 'not-found', '没有这篇文档：' + id);
  }

  /* ── one document's bytes / html / text / memory ── */
  if (action.startsWith('doc/')) {
    const sub = action.slice(4);
    const id = query.get('id') || '';
    const doc = await findDoc(id);
    if (!doc) return fail(404, 'not-found', '没有这篇文档：' + id);

    if (sub === 'raw') {
      const bytes = await readFile(sourcePath(doc));
      // 只把「浏览器必须内联解析」的几种类型原样回出去（PDF 阅读器要它、图片要它）。
      // 其余一律降级成 text/plain + attachment：用户上传的 .html/.htm 如果按 text/html
      // 回给同源页面，就等于在 Harness 源里执行任意脚本（存储型 XSS）。
      const inlineSafe = doc.ext === 'pdf' || doc.ext === 'png' || doc.ext === 'jpg' || doc.ext === 'jpeg' || doc.ext === 'gif' || doc.ext === 'webp';
      const type = inlineSafe ? MIME['.' + doc.ext] || 'application/octet-stream' : 'text/plain; charset=utf-8';
      const headers = {
        'content-type': type,
        'content-length': String(bytes.length),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      };
      if (!inlineSafe) headers['content-disposition'] = 'attachment';
      return new Response(bytes, { status: 200, headers });
    }

    if (sub === 'docx') {
      if (doc.ext !== 'docx') return fail(400, 'not-docx', '不是 .docx');
      const convert = await loadDocxConverter();
      if (!convert) return fail(501, 'docx-unavailable', 'docx 转换模块没加载起来（src/host/docx.js）');
      const converted = await convert(new Uint8Array(await readFile(sourcePath(doc))));
      return ok({ id, title: converted.title || '', html: converted.html || '', warnings: converted.warnings || [] });
    }

    if (sub === 'text') {
      if (request.method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch (error) {
          return fail(400, 'body-invalid', '请求体不是合法 JSON');
        }
        const text = body && typeof body.text === 'string' ? normalisePlain(body.text) : '';
        if (text === '') return fail(400, 'body-invalid', '没有正文');
        await writeFile(textPath(doc.id), text, 'utf8');
        doc.chars = text.length;
        doc.hasText = true;
        delete doc.textError;
        await saveIndex();
        return ok({ id: doc.id, chars: text.length });
      }
      const text = await readTextOf(doc.id);
      return ok({ id: doc.id, text, chars: text.length, hasText: text !== '' });
    }

    if (sub === 'memory') {
      if (request.method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch (error) {
          return fail(400, 'body-invalid', '请求体不是合法 JSON');
        }
        const memory = body && typeof body.memory === 'string' ? body.memory : '';
        await withMemoryLock(doc.id, () => writeFile(memoryPath(doc.id), memory, 'utf8'));
        return ok({ id: doc.id, chars: memory.length });
      }
      const memory = await readMemoryOf(doc.id);
      return ok({ id: doc.id, memory, chars: memory.length });
    }

    if (sub === 'highlights') {
      let items = await readHighlightsOf(doc.id);

      if (request.method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch (error) {
          return fail(400, 'body-invalid', '请求体不是合法 JSON');
        }
        const incoming = normaliseHighlight(body && body.item);
        if (!incoming) return fail(400, 'body-invalid', '这条划线不合法（需要 id / text / anchor.start < end）');
        items = items.filter((entry) => entry.id !== incoming.id);
        items.push(incoming);
        items = await writeHighlightsOf(doc.id, items);
        return ok({ id: doc.id, items });
      }

      if (request.method === 'DELETE') {
        const hid = query.get('hid') || '';
        if (!hid) return fail(400, 'body-invalid', '缺少 hid');
        items = await writeHighlightsOf(
          doc.id,
          items.filter((entry) => entry.id !== hid),
        );
        return ok({ id: doc.id, items });
      }

      return ok({ id: doc.id, items });
    }

    if (sub === 'review') {
      if (request.method !== 'POST') return fail(405, 'method', 'POST only');
      const scheduler = service(ctx, 'schedule');
      if (!scheduler || typeof scheduler.create !== 'function') {
        return fail(501, 'schedule-unavailable', '这个 Host 没有排期服务（schedule），安排不了复习');
      }
      let body = {};
      try {
        body = (await request.json()) || {};
      } catch (error) {
        body = {};
      }
      // The schedule service wants `HH:mm:ss`; the panel only deals in `HH:mm`.
      let time = typeof body.time === 'string' ? body.time.trim() : '';
      if (/^\d{1,2}:\d{2}$/.test(time)) time = time.padStart(5, '0') + ':00';
      if (!/^\d{2}:\d{2}:\d{2}$/.test(time)) time = '20:00:00';
      const display = time.slice(0, 5);
      const timeZone = typeof body.timeZone === 'string' && body.timeZone.trim() !== '' ? body.timeZone.trim() : 'Asia/Shanghai';
      if (!doc.sessionId) return fail(400, 'no-session', '先打开一次这篇文档，让它有会话，才能安排复习');
      const entry = await scheduler.create({
        title: '复习 · ' + doc.name,
        prompt:
          '【DocMate 复习】请用 docmate_highlights 读出我在《' +
          doc.name +
          '》里标成「待复习」的划线，逐条用提问的方式考我：先问，等我答完再点评并指出我漏掉的部分。' +
          '如果一条「待复习」都没有，就挑几条「重点」来考。考完用 docmate_memory 记下我答错的地方。',
        timing: { kind: 'daily', daily: { time, time_zone: timeZone } },
        target: { kind: 'session', sessionId: doc.sessionId },
      });
      return ok({ id: doc.id, scheduleId: entry && entry.id, time: display, timeZone });
    }

    if (sub === 'session') {
      const result = await ensureDocSession(ctx, doc);
      return ok({ id: doc.id, ...result, chars: doc.chars, hasText: doc.hasText });
    }

    if (sub === 'resync') {
      // Drop the "already injected" flag so the next `/session` re-reads text + memory.
      doc.contextInjected = false;
      await saveIndex();
      const injected = await syncContext(ctx, doc);
      return ok({ id: doc.id, injected, chars: doc.chars, hasText: doc.hasText });
    }

    return fail(404, 'unknown-route', '没有这条文档路由：' + sub);
  }

  if (action === 'ask') {
    if (request.method !== 'POST') return fail(405, 'method', 'POST only');
    let body;
    try {
      body = await request.json();
    } catch (error) {
      return fail(400, 'body-invalid', '请求体不是合法 JSON');
    }
    const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : '';
    const text = body && typeof body.text === 'string' ? body.text : '';
    if (!sessionId) return fail(400, 'body-invalid', '缺少 sessionId');
    const image = normaliseImage(body && body.image);
    if (!image && !text.trim()) return fail(400, 'body-invalid', '消息是空的');
    if (image) {
      // 截图落盘是插件自己的事（用户还能找回原图），但**不写进消息**：
      // 一句「已存到某路径，需要时可以重新读」就足够把模型引去翻文件。
      await saveShot(body && body.docId, image);
    }
    const requestId = await askSession(ctx, sessionId, text, image, body && body.docId);
    return ok({ sessionId, requestId, savedShot: !!image });
  }

  if (action === 'guard') {
    if (request.method !== 'GET') return fail(405, 'method', 'GET only');
    const id = query.get('id') || '';
    if (id) return ok({ guard: visionPublic(visionLog.get(id)) });
    // 面板拿不到 requestId 也能看：按会话取最近一条。
    const sessionId = query.get('session') || '';
    if (!sessionId) return fail(400, 'body-invalid', '缺少 id 或 session');
    let latest = null;
    for (const entry of visionLog.values()) {
      if (entry.sessionId !== sessionId) continue;
      if (!latest || entry.queuedAt >= latest.queuedAt) latest = entry;
    }
    return ok({ guard: visionPublic(latest) });
  }

  return fail(404, 'unknown-route', '没有这条路由：' + pathname);
}

async function serve(ctx, request) {
  try {
    return await route(ctx, request);
  } catch (error) {
    const code = error && error.code ? String(error.code) : '';
    if (code === 'unsupported') return fail(415, 'unsupported', messageOf(error));
    if (code === 'empty') return fail(400, 'empty', messageOf(error));
    if (code === 'too-large') return fail(413, 'too-large', messageOf(error));
    if (code === 'bad-request') return fail(400, 'bad-request', messageOf(error));
    if (code === 'ENOENT') return fail(404, 'not-found', '文件不存在：' + messageOf(error));
    if (code === 'EACCES' || code === 'EPERM') return fail(403, 'denied', '没有权限：' + messageOf(error));
    return fail(500, 'internal', messageOf(error));
  }
}

/* ── Node <-> Fetch adapter ────────────────────────────────────────────── */

/**
 * The Web carrier's *resource* route only answers GET/HEAD, so the whole API is mounted as
 * a plain Node handler route instead: one adapter converts the incoming message into a
 * `Request`, our handlers stay fetch-shaped, and the response is written back.
 */
async function nodeToRequest(req) {
  const origin = 'http://' + (req.headers.host || '127.0.0.1');
  const url = new URL(req.url || '/', origin);
  const method = (req.method || 'GET').toUpperCase();
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, String(item));
    } else {
      headers.set(key, String(value));
    }
  }
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    // 边读边数，超了立刻停：先整包 `Buffer.concat` 再查大小的话，一个几 GB 的 POST
    // 就能把宿主进程 OOM 掉。上限 = 允许上传的最大文件 + 1MB（给 JSON 包装留余量）。
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES + 1024 * 1024) {
        const error = new Error('请求体超过上限（' + Math.round(MAX_UPLOAD_BYTES / 1024 / 1024) + ' MB）');
        error.code = 'too-large';
        throw error;
      }
      chunks.push(chunk);
    }
    init.body = Buffer.concat(chunks);
    // `duplex` is required by undici for a streamed body; a Buffer body is fine without it.
  }
  return new Request(url, init);
}

async function writeResponse(res, response) {
  res.statusCode = response.status;
  try {
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
  } catch (error) {
    /* a header the Node layer refuses is not worth failing the whole response */
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  res.setHeader('content-length', String(buffer.length));
  res.end(buffer);
}

export function apply(ctx) {
  const webServer = service(ctx, 'webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('dsh-docmate 需要一个 Web 载体（webServer）');
  }
  const connection = service(ctx, 'connection');

  /**
   * Re-apply the connection's own Host/Origin + browser-credential checks. Mounting a
   * prefix on the Web carrier directly would otherwise skip the `/api` fence; this is the
   * documented way for another Web route to inherit it.
   */
  function admit(request) {
    // 拿不到 connection 就**拒绝**，不是放行：这组路由能删文档、能发消息，
    // 没有鉴权就等于任意网页可以 CSRF。宁可插件在这个宿主上不工作。
    if (!connection || typeof connection.requestRejection !== 'function') return 403;
    try {
      return connection.requestRejection({ headers: request.headers }) || null;
    } catch (error) {
      return 403;
    }
  }

  registerTools(ctx);
  registerJournal(ctx);
  registerVisionGuard(ctx);

  const dispose = webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const request = await nodeToRequest(req);
        const rejection = admit(request);
        if (rejection) {
          res.statusCode = rejection;
          res.end('forbidden');
          return;
        }
        await writeResponse(res, await serve(ctx, request));
      } catch (error) {
        try {
          const code = error && error.code === 'too-large' ? 413 : 500;
          res.statusCode = code;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('connection', 'close');
          res.end(
            JSON.stringify({
              ok: false,
              error: { code: code === 413 ? 'too-large' : 'internal', message: messageOf(error) },
            }),
          );
        } catch (ignored) {
          /* the socket is already gone */
        }
        try {
          req.destroy();
        } catch (ignored) {
          /* already closed */
        }
      }
    },
  });

  ctx.effect(() => dispose, 'docmate: /api/docmate routes');
}
