// Host-half contract test for the research-desk build. No browser, no network: `apply()`
// is driven with a fake Cordis context, the registered Web resource is called with real
// `Request` objects, and the two model-facing tools are executed directly.
//
//   node test/host.test.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'docs');

// The plugin reads DSH_HOME at module load, so point it at a throwaway directory first.
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'docmate-test-'));
process.env.DSH_HOME = sandbox;

const plugin = await import('../index.js');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    console.error('  ✗ ' + name);
    console.error('    ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n    ') : error));
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    console.error('  ✗ ' + name);
    console.error('    ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n    ') : error));
    process.exitCode = 1;
  }
}

/* ── fake host ─────────────────────────────────────────────────────────── */

const createdSessions = [];
const injected = [];
const prompted = [];
const scheduled = [];
const listeners = new Map();
const disposers = [];
const agentsById = new Map();
const registeredTools = [];

const sessionController = {
  async create(request) {
    createdSessions.push(request);
    const sessionId = 'sess-' + createdSessions.length;
    agentsById.set(sessionId, {
      id: sessionId,
      inject(message) {
        injected.push({ sessionId, message });
      },
    });
    return { sessionId };
  },
  async rename() {
    return { title: 'x', seq: 1 };
  },
  async resolveAgent(sessionId) {
    return agentsById.has(sessionId) ? { agent: agentsById.get(sessionId) } : { error: { code: 'session/not-found' } };
  },
  async prompt(request) {
    prompted.push(request);
    return { accepted: true };
  },
};

const services = {
  webServer: {
    register(route) {
      services.__route = route;
      return () => {};
    },
  },
  // The plugin now fails closed when it cannot ask the connection to vet a request, so the
  // fake host has to provide the same shape a real Web profile does.
  connection: { requestRejection: () => null },
  sessionController,
  agents: { get: (id) => agentsById.get(id) || null },
  tools: {
    register(definition, options) {
      registeredTools.push({ definition, options });
      return () => {};
    },
  },
  schedule: {
    async create(request) {
      scheduled.push(request);
      return { id: 'sch-' + scheduled.length, title: request.title };
    },
  },
};

const ctx = {
  get: (name) => services[name],
  on(name, handler) {
    // Cordis 允许同一个事件挂多个监听（本插件就同时挂了 journal 和 vision guard），
    // 所以这里必须存成数组，只留最后一个会把 journal 顶掉。
    const bucket = listeners.get(name) || [];
    bucket.push(handler);
    listeners.set(name, bucket);
    return () => {
      const current = listeners.get(name) || [];
      const index = current.indexOf(handler);
      if (index >= 0) current.splice(index, 1);
    };
  },
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return typeof dispose === 'function' ? dispose : () => {};
  },
};

/** 按注册顺序触发某个事件的全部监听。 */
function emit(name, ...args) {
  const bucket = listeners.get(name) || [];
  const results = [];
  for (const handler of bucket) results.push(handler(...args));
  return results;
}

plugin.apply(ctx);
const route = services.__route;
assert.equal(typeof route.handler, 'function', 'apply() must register a Web handler route');
assert.equal(route.kind, 'prefix');

const ORIGIN = 'http://127.0.0.1:1';

/** A Node-shaped request the adapter can iterate for its body. */
function makeReq(method, url, headers, body) {
  return {
    method,
    url,
    headers: Object.assign({ host: '127.0.0.1:1' }, headers || {}),
    destroy() {
      this.destroyed = true;
    },
    async *[Symbol.asyncIterator]() {
      if (Array.isArray(body)) {
        for (const chunk of body) yield chunk;
        return;
      }
      if (body && body.length) yield body;
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: Buffer.alloc(0),
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = String(value);
    },
    end(chunk) {
      this.body = chunk ? Buffer.from(chunk) : Buffer.alloc(0);
    },
  };
}

async function call(action, options) {
  const opts = options || {};
  const url = new URL(ORIGIN + '/api/docmate/' + action);
  for (const [key, value] of Object.entries(opts.query || {})) url.searchParams.set(key, value);
  const headers = {};
  let body = null;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = Buffer.from(JSON.stringify(opts.json));
  }
  if (opts.bytes !== undefined) body = Buffer.from(opts.bytes);
  if (opts.chunks !== undefined) body = opts.chunks;
  const req = makeReq(opts.method || 'GET', url.pathname + url.search, headers, body);
  const res = makeRes();
  await route.handler(req, res);
  return new Response(res.body, { status: res.statusCode, headers: res.headers });
}

async function upload(name, bytes) {
  const response = await call('docs', { method: 'POST', query: { name }, bytes });
  return { response, body: await response.json() };
}

/* ── ingestion ─────────────────────────────────────────────────────────── */

console.log('研究区：拖入文档');
const mdBytes = await readFile(path.join(fixtures, '深度学习入门笔记.md'));
const docxBytes = await readFile(path.join(fixtures, '课程大纲.docx'));
const pdfBytes = await readFile(path.join(fixtures, 'sample-report.pdf'));

let mdDoc = null;
let docxDoc = null;
let pdfDoc = null;

{
  const { response, body } = await upload('深度学习入门笔记.md', mdBytes);
  check('POST /docs 收下 markdown', () => {
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    mdDoc = body.doc;
    assert.equal(mdDoc.ext, 'md');
    assert.equal(mdDoc.hasText, true);
    assert.ok(mdDoc.chars > 100);
  });
}
{
  const { body } = await upload('课程大纲.docx', docxBytes);
  check('POST /docs 收下 docx 并抽出正文', () => {
    docxDoc = body.doc;
    assert.equal(docxDoc.ext, 'docx');
    assert.equal(docxDoc.hasText, true);
    assert.ok(docxDoc.chars > 100);
  });
}
{
  const { body } = await upload('sample-report.pdf', pdfBytes);
  check('POST /docs 收下 pdf（正文留给浏览器抽）', () => {
    pdfDoc = body.doc;
    assert.equal(pdfDoc.ext, 'pdf');
    assert.equal(pdfDoc.hasText, false);
    assert.equal(pdfDoc.chars, 0);
  });
}
{
  const response = await call('docs', { method: 'POST', query: { name: 'evil.exe' }, bytes: Buffer.from('MZ') });
  const body = await response.json();
  check('不支持的扩展名被拒绝', () => {
    assert.equal(response.status, 415);
    assert.equal(body.ok, false);
  });
}
{
  const response = await call('docs', { method: 'POST', query: { name: 'empty.md' }, bytes: Buffer.alloc(0) });
  check('空文件被拒绝', () => assert.equal(response.status, 400));
}
{
  const response = await call('docs', { method: 'POST', query: { name: '../../escape.md' }, bytes: Buffer.from('# hi') });
  const body = await response.json();
  check('文件名里的路径被剥掉', () => {
    assert.equal(body.ok, true);
    assert.equal(body.doc.name, 'escape.md');
  });
}

console.log('研究区：列表与正文');
{
  const body = await (await call('docs')).json();
  check('GET /docs 列出全部文档（新的在前）', () => {
    assert.equal(body.ok, true);
    assert.ok(body.docs.length >= 4);
    assert.equal(body.docs[0].name, 'escape.md');
  });
  check('dataDir 指向临时 DSH_HOME', () => assert.ok(body.dataDir.toLowerCase().includes('docmate-test-')));
}
{
  const response = await call('doc/raw', { query: { id: mdDoc.id } });
  const text = await response.text();
  check('GET /doc/raw 返回原始字节', () => {
    assert.equal(response.status, 200);
    assert.ok(text.includes('伴随式学习'));
  });
}
{
  const body = await (await call('doc/docx', { query: { id: docxDoc.id } })).json();
  check('GET /doc/docx 返回转换后的 HTML', () => {
    assert.equal(body.ok, true);
    assert.match(body.html, /<h1>/);
    assert.match(body.html, /<table class="dm-docx-table">/);
  });
}
{
  const body = await (await call('doc/text', { query: { id: docxDoc.id } })).json();
  check('docx 的 text.md 保留了结构（标题变 #）', () => {
    assert.equal(body.ok, true);
    assert.match(body.text, /^#+ /m);
  });
}
{
  const response = await call('doc/raw', { query: { id: 'nope' } });
  check('不存在的文档 → 404', () => assert.equal(response.status, 404));
}

console.log('研究区：PDF 正文回填');
{
  const response = await call('doc/text', {
    method: 'POST',
    query: { id: pdfDoc.id },
    json: { text: '--- 第 1 页 ---\nDocMate Sample Report\n\n--- 第 2 页 ---\nPage two' },
  });
  const body = await response.json();
  check('POST /doc/text 写入浏览器抽出的全文', () => {
    assert.equal(body.ok, true);
    assert.ok(body.chars > 20);
  });
  const listed = await (await call('docs')).json();
  const row = listed.docs.find((doc) => doc.id === pdfDoc.id);
  check('列表里的字数跟着更新', () => {
    assert.equal(row.hasText, true);
    assert.ok(row.chars > 20);
  });
}

console.log('研究区：每篇一条会话 + 全文同步');
{
  const body = await (await call('doc/session', { method: 'POST', query: { id: mdDoc.id } })).json();
  check('POST /doc/session 建出会话', () => {
    assert.equal(body.ok, true);
    assert.equal(body.sessionId, 'sess-1');
  });
  check('会话的 cwd 是这篇文档自己的目录', () => {
    assert.equal(createdSessions.length, 1);
    assert.ok(createdSessions[0].cwd.includes(mdDoc.id));
  });
  check('全文被注入进会话', () => {
    assert.equal(injected.length, 1);
    const text = injected[0].message.content[0].text;
    assert.ok(text.includes('文档已载入'));
    assert.ok(text.includes('伴随式学习'), 'full text missing');
    assert.ok(text.includes('docmate_read'), 'working rules missing');
  });
  check('注入的消息是合法 UserMessage 形状', () => {
    const message = injected[0].message;
    assert.equal(message.role, 'user');
    assert.equal(message.source.kind, 'user');
    assert.ok(typeof message.id === 'string' && message.id.length > 8);
  });
}
{
  const body = await (await call('doc/session', { method: 'POST', query: { id: mdDoc.id } })).json();
  check('再开同一篇：复用会话，不重复注入', () => {
    assert.equal(body.sessionId, 'sess-1');
    assert.equal(body.injected, false);
    assert.equal(injected.length, 1);
    assert.equal(createdSessions.length, 1);
  });
}
{
  await call('doc/memory', {
    method: 'POST',
    query: { id: mdDoc.id },
    json: { memory: '- 用户关心「伴随式」的定义\n- 待办：划线持久化' },
  });
  const body = await (await call('doc/resync', { method: 'POST', query: { id: mdDoc.id } })).json();
  check('重新同步会把记忆一起带上', () => {
    assert.equal(body.injected, true);
    const text = injected[injected.length - 1].message.content[0].text;
    assert.ok(text.includes('划线持久化'), 'memory missing from re-sync');
  });
}
{
  const body = await (await call('doc/session', { method: 'POST', query: { id: docxDoc.id } })).json();
  check('另一篇文档拿到另一条会话', () => {
    assert.equal(body.sessionId, 'sess-2');
    assert.equal(createdSessions.length, 2);
  });
}

console.log('研究区：记忆');
{
  const body = await (await call('doc/memory', { query: { id: mdDoc.id } })).json();
  check('GET /doc/memory 读回刚写的记忆', () => {
    assert.equal(body.ok, true);
    assert.ok(body.memory.includes('伴随式'));
  });
}

console.log('研究区：划线');
{
  const item = {
    id: 'h1',
    color: 'key',
    text: '注意力的瓶颈不在算力',
    note: '',
    anchor: { scope: 'doc', page: null, start: 10, end: 24 },
    kind: 'mark',
    createdAt: Date.now(),
  };
  const body = await (await call('doc/highlights', { method: 'POST', query: { id: mdDoc.id }, json: { item } })).json();
  check('POST /doc/highlights 存下一条划线', () => {
    assert.equal(body.ok, true);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].color, 'key');
  });
}
{
  const body = await (await call('doc/highlights', { query: { id: mdDoc.id } })).json();
  check('GET /doc/highlights 读回', () => {
    assert.equal(body.ok, true);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].text, '注意力的瓶颈不在算力');
  });
}
{
  const item = {
    id: 'h2',
    color: 'question',
    text: '上下文窗口',
    anchor: { scope: 'page', page: 2, start: 0, end: 5 },
    kind: 'quote',
    createdAt: Date.now(),
  };
  const body = await (await call('doc/highlights', { method: 'POST', query: { id: mdDoc.id }, json: { item } })).json();
  check('page 作用域的引用也能存', () => {
    assert.equal(body.items.length, 2);
    assert.equal(body.items[1].anchor.scope, 'page');
    assert.equal(body.items[1].anchor.page, 2);
    assert.equal(body.items[1].kind, 'quote');
  });
}
{
  const item = { id: 'bad', color: 'key', text: 'x', anchor: { scope: 'doc', start: 5, end: 5 } };
  const body = await (await call('doc/highlights', { method: 'POST', query: { id: mdDoc.id }, json: { item } })).json();
  check('非法锚点（start === end）被拒绝', () => assert.equal(body.ok, false));
}
{
  const item = { id: 'h1', color: 'review', text: '注意力的瓶颈不在算力', anchor: { scope: 'doc', start: 10, end: 24 } };
  const body = await (await call('doc/highlights', { method: 'POST', query: { id: mdDoc.id }, json: { item } })).json();
  check('同 id 再 POST 是更新而不是重复', () => {
    assert.equal(body.items.length, 2);
    const updated = body.items.find((entry) => entry.id === 'h1');
    assert.equal(updated.color, 'review');
  });
}
{
  const body = await (await call('doc/highlights', { method: 'DELETE', query: { id: mdDoc.id, hid: 'h2' } })).json();
  check('DELETE /doc/highlights 删掉一条', () => {
    assert.equal(body.ok, true);
    assert.equal(body.items.length, 1);
  });
}
{
  await call('doc/resync', { method: 'POST', query: { id: mdDoc.id } });
  const text = injected[injected.length - 1].message.content[0].text;
  check('重新同步时把用户的划线也带进上下文', () => {
    assert.ok(text.includes('用户已经划下的线'), 'highlight section missing');
    assert.ok(text.includes('注意力的瓶颈不在算力'), 'highlight text missing');
    assert.ok(text.includes('[待复习]'), 'colour label missing');
  });
}

console.log('研究区：发消息');
{
  const response = await call('ask', {
    method: 'POST',
    json: { sessionId: 'sess-1', text: '解释一下第一段' },
  });
  const body = await response.json();
  check('POST /ask 投递为一条 text 内容块', () => {
    assert.equal(body.ok, true);
    assert.equal(prompted.length, 1);
    assert.deepEqual(prompted[0].content, [{ type: 'text', text: '解释一下第一段' }]);
    assert.equal(prompted[0].mode, 'queue');
  });
  const empty = await (await call('ask', { method: 'POST', json: { sessionId: 'sess-1', text: '  ' } })).json();
  check('空消息被拒绝', () => assert.equal(empty.ok, false));
}

console.log('模型工具');
{
  const toolNamed = (name) => registeredTools.find((entry) => entry.definition.name === name);

  check('注册了 docmate_read 与 docmate_memory', () => {
    const names = registeredTools.map((entry) => entry.definition.name);
    assert.ok(names.includes('docmate_read'), 'docmate_read missing');
    assert.ok(names.includes('docmate_memory'), 'docmate_memory missing');
  });

  await checkAsync('工具只对研究区会话可见', async () => {
    const read = toolNamed('docmate_read');
    assert.equal(await read.options.when({ agent: { id: 'sess-1' } }), true);
    assert.equal(await read.options.when({ agent: { id: 'some-other-session' } }), false);
  });

  await checkAsync('docmate_read 默认读当前会话对应的文档', async () => {
    const value = await toolNamed('docmate_read').definition.execute({}, { agent: { id: 'sess-1' } });
    assert.ok(value.total > 100);
    assert.ok(value.text.includes('伴随式学习'));
    assert.equal(value.offset, 0);
    assert.equal(value.eof, true);
  });

  await checkAsync('docmate_read 支持分段', async () => {
    const read = toolNamed('docmate_read').definition;
    const first = await read.execute({ offset: 0, limit: 200 }, { agent: { id: 'sess-1' } });
    assert.equal(first.text.length < first.total, true);
    assert.equal(first.eof, false);
    assert.ok(first.text.includes('还有'));
    const second = await read.execute({ offset: 200, limit: 200 }, { agent: { id: 'sess-1' } });
    assert.equal(second.offset, 200);
  });

  await checkAsync('docmate_read 能按名字读另一篇', async () => {
    const value = await toolNamed('docmate_read').definition.execute({ doc: '课程大纲' }, { agent: { id: 'sess-1' } });
    assert.ok(value.text.includes('DocMate 验收样本'));
  });

  await checkAsync('docmate_read 找不到文档时给可读提示', async () => {
    const value = await toolNamed('docmate_read').definition.execute({ doc: '不存在的' }, { agent: { id: 'sess-1' } });
    assert.ok(value.text.includes('没有这篇文档'));
  });

  await checkAsync('docmate_memory append 追加带时间戳的一条', async () => {
    const value = await toolNamed('docmate_memory').definition.execute(
      { action: 'append', text: '关键结论：选区即输入' },
      { agent: { id: 'sess-1' } },
    );
    assert.ok(value.chars > 0);
    const readBack = await (await call('doc/memory', { query: { id: mdDoc.id } })).json();
    assert.ok(readBack.memory.includes('选区即输入'));
    assert.match(readBack.memory, /- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/);
  });

  await checkAsync('docmate_memory read 返回当前记忆', async () => {
    const value = await toolNamed('docmate_memory').definition.execute({ action: 'read' }, { agent: { id: 'sess-1' } });
    assert.ok(value.text.includes('选区即输入'));
  });

  await checkAsync('docmate_memory 空内容被拒绝', async () => {
    const value = await toolNamed('docmate_memory').definition.execute(
      { action: 'append', text: '   ' },
      { agent: { id: 'sess-1' } },
    );
    assert.ok(value.text.includes('没有给'));
  });
}

console.log('研究区：自动记忆（turn/end 流水）');
{
  const stack = listeners.get('session/event') || [];
  check('注册了 session/event 监听', () => assert.ok(stack.length >= 1));

  const session = {
    id: 'sess-1',
    ownEvents: () => [
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '解释一下第一段' }] } },
      {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '这段讲的是伴随式阅读的动机。'.repeat(20) }] } },
      },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  };
  emit('session/event', session, { type: 'turn/end', data: {} });
  await new Promise((resolve) => setTimeout(resolve, 80));

  const body = await (await call('doc/memory', { query: { id: mdDoc.id } })).json();
  check('回合结束后自动写进研究记忆', () => {
    assert.ok(body.memory.includes('（自动）'), 'auto marker missing');
    assert.ok(body.memory.includes('解释一下第一段'), 'question missing');
    assert.ok(body.memory.includes('伴随式阅读的动机'), 'answer digest missing');
  });

  const other = {
    id: 'sess-1',
    ownEvents: () => [
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '【研究区 · 文档已载入】全文……' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x'.repeat(300) }] } } },
      { type: 'turn/end', data: { turn: 1 } },
    ],
  };
  emit('session/event', other, { type: 'turn/end', data: {} });
  await new Promise((resolve) => setTimeout(resolve, 60));  const after = await (await call('doc/memory', { query: { id: mdDoc.id } })).json();
  check('不把注入的全文当成用户提问记下来', () => {
    assert.ok(!after.memory.includes('【研究区 · 文档已载入】'));
  });
}

console.log('研究区：复习排期');
{
  const response = await call('doc/review', {
    method: 'POST',
    query: { id: mdDoc.id },
    json: { time: '21:30', timeZone: 'Asia/Shanghai' },
  });
  const body = await response.json();
  check('POST /doc/review 建出每日复习任务', () => {
    assert.equal(body.ok, true);
    assert.equal(body.scheduleId, 'sch-1');
    assert.equal(body.time, '21:30');
  });
  check('排期指向这篇文档的会话，每天一次', () => {
    assert.equal(scheduled.length, 1);
    const request = scheduled[0];
    assert.equal(request.target.kind, 'session');
    assert.equal(request.target.sessionId, 'sess-1');
    assert.equal(request.timing.kind, 'daily');
    // the schedule service wants HH:mm:ss; the panel speaks HH:mm
    assert.equal(request.timing.daily.time, '21:30:00');
    assert.equal(request.timing.daily.time_zone, 'Asia/Shanghai');
    assert.ok(request.prompt.includes('docmate_highlights'));
  });
}

console.log('模型工具：划线');
{
  const tool = registeredTools.find((entry) => entry.definition.name === 'docmate_highlights');
  check('注册了 docmate_highlights', () => assert.ok(tool));
  await checkAsync('能读出这篇文档的划线', async () => {
    const value = await tool.definition.execute({}, { agent: { id: 'sess-1' } });
    assert.ok(value.count >= 1);
    assert.ok(value.text.includes('注意力的瓶颈不在算力'));
    assert.ok(value.text.includes('[待复习]'));
  });
  await checkAsync('按颜色筛选', async () => {
    const value = await tool.definition.execute({ color: 'quote' }, { agent: { id: 'sess-1' } });
    assert.equal(value.count, 0, 'no quote marks were recorded in this run');
  });
}

console.log('快速识图：刹车');
{
  const vision = plugin.visionInternals;
  const preStep = (listeners.get('agent/pre-step') || [])[0];
  const agentRequest = (listeners.get('agent/request') || [])[0];
  const preTool = (listeners.get('tools/pre-execute') || [])[0];

  check('注册了 agent/pre-step / agent/request / tools/pre-execute', () => {
    assert.equal(typeof preStep, 'function');
    assert.equal(typeof agentRequest, 'function');
    assert.equal(typeof preTool, 'function');
  });

  const nextEnter = async () => ({ kind: 'enter', messages: [] });
  const nextConfig = async () => ({ provider: 'deepseek', model: 'flash' });
  const nextAllow = async () => ({ kind: 'allow' });
  // 1x1 PNG：只要 base64 合法、能落盘就行，识别本身由真实模型验收。
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const shot = { mediaType: 'image/png', data: 'data:image/png;base64,' + PNG };

  /* ── 普通文字提问完全不进守卫 ── */
  const plainAsk = await (
    await call('ask', { method: 'POST', json: { sessionId: 'sess-1', text: '普通问题' } })
  ).json();
  check('纯文字 /ask 不登记快速识图轮次', () => {
    assert.equal(plainAsk.ok, true);
    assert.equal(vision.visionLog.has(plainAsk.requestId), false);
  });

  const plainSignal = new AbortController().signal;
  const plainAgent = {
    session: { id: 'sess-1' },
    cancel() {
      throw new Error('普通轮次不该被取消');
    },
  };
  const plainDecision = await preStep(
    { agent: plainAgent, messages: [{ source: { kind: 'user' } }], turn: 9, step: 1, signal: plainSignal },
    nextEnter,
  );
  check('普通文字消息不进入守卫', () => assert.equal(plainDecision.kind, 'enter'));

  const plainConfig = await agentRequest({ agent: plainAgent, turn: 9, step: 1, signal: plainSignal }, nextConfig);
  check('普通轮次的 maxTokens 不受影响', () => assert.equal(plainConfig.maxTokens, undefined));

  const plainTool = await preTool({ name: 'pwsh', agent: plainAgent, signal: plainSignal }, nextAllow);
  check('非目标会话的工具照常放行', () => assert.equal(plainTool.kind, 'allow'));

  /* ── 图片消息按 source.rpcId 认出来 ── */
  const asked = await (
    await call('ask', {
      method: 'POST',
      json: { sessionId: 'sess-1', docId: mdDoc.id, text: '解释这张图', image: shot },
    })
  ).json();
  check('POST /ask 返回 requestId', () => {
    assert.equal(asked.ok, true);
    assert.ok(typeof asked.requestId === 'string' && asked.requestId.length > 0);
  });

  const lastPrompt = prompted[prompted.length - 1];
  check('快速识图消息不包含截图路径诱导文案', () => {
    const text = lastPrompt.content[0].text;
    assert.ok(!text.includes('截图已存到'), 'still nudging the model to re-read the file');
    assert.ok(!text.includes('shots/'), 'shot path leaked into the message');
    assert.ok(text.includes('解释这张图'));
  });
  check('图片作为独立 content part 发出', () => {
    assert.equal(lastPrompt.content.length, 2);
    assert.equal(lastPrompt.content[1].type, 'image');
  });

  const visionSignal = new AbortController().signal;
  const visionAgent = { session: { id: 'sess-1' }, cancel() {} };
  const bound = await preStep(
    {
      agent: visionAgent,
      messages: [{ source: { kind: 'user', rpcId: asked.requestId } }],
      turn: 1,
      step: 1,
      signal: visionSignal,
    },
    nextEnter,
  );
  check('图片消息按 source.rpcId 被识别为快速识图轮次', () => assert.equal(bound.kind, 'enter'));

  const capped = await agentRequest({ agent: visionAgent, turn: 1, step: 1, signal: visionSignal }, nextConfig);
  check('快速识图轮次的单步输出被压到 4000', () => assert.equal(capped.maxTokens, 4000));
  check('只改 maxTokens，不动 provider / model', () => {
    assert.equal(capped.provider, 'deepseek');
    assert.equal(capped.model, 'flash');
  });

  const denied = await preTool({ name: 'pwsh', agent: visionAgent, signal: visionSignal }, nextAllow);
  check('快速识图轮次里的工具调用被拒（不是提示词，是运行时拒绝）', () => {
    assert.equal(denied.kind, 'deny');
    assert.ok(denied.reason.includes('只读'));
    assert.ok(denied.reason.includes('pwsh'));
  });

  /* 工具目录缩不掉是宿主的上限：system-prompt/assemble 的入参没有 tools。
   * 所以这里只断言「运行时拒绝」这一层是真的，不去假装能隐藏工具。 */
  const assemble = (listeners.get('system-prompt/assemble') || [])[0];
  check('不注册 system-prompt/assemble（它拿不到 tools，装了也是骗自己）', () => {
    assert.equal(assemble, undefined);
  });

  const third = await preStep({ agent: visionAgent, messages: [], turn: 1, step: 3, signal: visionSignal }, nextEnter);
  check('第 3 步被拒绝', () => assert.equal(third.kind, 'reject'));
  check('拒绝原因记为 steps', () => {
    const state = vision.visionLog.get(asked.requestId);
    assert.equal(state.reason, 'steps');
    assert.equal(state.phase, 'tripped');
  });

  /* ── 累计 token 超预算后不再开始下一步 ── */
  const asked2 = await (
    await call('ask', {
      method: 'POST',
      json: { sessionId: 'sess-1', docId: mdDoc.id, text: '再看一块', image: shot },
    })
  ).json();
  const signal2 = new AbortController().signal;
  const agent2 = { session: { id: 'sess-1' }, cancel() {} };
  await preStep(
    { agent: agent2, messages: [{ source: { kind: 'user', rpcId: asked2.requestId } }], turn: 2, step: 1, signal: signal2 },
    nextEnter,
  );
  emit(
    'session/event',
    { id: 'sess-1' },
    {
      type: 'assistant/message',
      data: { turn: 2, usage: { inputTokens: 20000, outputTokens: 900, cacheReadTokens: 10000 } },
    },
  );
  const entry2 = vision.visionLog.get(asked2.requestId);
  check('用量同时记 billed（花费）与 fresh（未缓存输入 + 输出）', () => {
    assert.equal(entry2.usage.input, 20000);
    assert.equal(entry2.usage.cacheRead, 10000);
    assert.equal(entry2.usage.output, 900);
    assert.equal(entry2.usage.billed, 30900);
    assert.equal(entry2.usage.fresh, 20900);
  });
  check('模型调用次数单独记', () => assert.equal(entry2.calls, 1));

  const underBudget = await preStep({ agent: agent2, messages: [], turn: 2, step: 2, signal: signal2 }, nextEnter);
  check('预算按 fresh 计：20.9K 时第 2 步仍放行（缓存读不算跑飞）', () => assert.equal(underBudget.kind, 'enter'));

  emit(
    'session/event',
    { id: 'sess-1' },
    { type: 'assistant/message', data: { turn: 2, usage: { inputTokens: 9500, outputTokens: 600 } } },
  );
  check('第 2 步把 fresh 推过 30K', () => assert.ok(entry2.usage.fresh >= 30000));

  const overBudget = await preStep({ agent: agent2, messages: [], turn: 2, step: 2, signal: signal2 }, nextEnter);
  check('超过 30K 后不再开始下一步', () => assert.equal(overBudget.kind, 'reject'));
  check('拒绝原因记为 tokens（不是 steps：步数还没超）', () => assert.equal(vision.visionLog.get(asked2.requestId).reason, 'tokens'));

  /* ── 45 秒超时取消真实 turn（测试把阈值临时调小） ── */
  const asked3 = await (
    await call('ask', {
      method: 'POST',
      json: { sessionId: 'sess-1', docId: mdDoc.id, text: '超时测试', image: shot },
    })
  ).json();
  const signal3 = new AbortController().signal;
  const cancelled3 = [];
  const agent3 = {
    session: { id: 'sess-1' },
    cancel(cause, options) {
      cancelled3.push({ cause, options });
    },
  };
  const savedTimeout = vision.VISION.timeoutMs;
  vision.VISION.timeoutMs = 30;
  await preStep(
    { agent: agent3, messages: [{ source: { kind: 'user', rpcId: asked3.requestId } }], turn: 3, step: 1, signal: signal3 },
    nextEnter,
  );
  vision.VISION.timeoutMs = savedTimeout;
  await new Promise((resolve) => setTimeout(resolve, 90));
  check('超时会取消真实运行中的 turn', () => {
    assert.equal(cancelled3.length, 1);
    assert.equal(cancelled3[0].cause.kind, 'hook');
    assert.equal(cancelled3[0].options.keepInbox, true, 'keepInbox must survive the cancel');
  });
  check('超时原因记为 timeout', () => assert.equal(vision.visionLog.get(asked3.requestId).reason, 'timeout'));

  /* ── turn/end 收尾 ── */
  emit('session/event', { id: 'sess-1' }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted' } } });
  check('turn/end 后轮次状态收尾并解引用', () => {
    const entry3 = vision.visionLog.get(asked3.requestId);
    assert.equal(entry3.phase, 'tripped');
    assert.equal(entry3.agent, null);
    assert.equal(entry3.signal, null);
    assert.equal(vision.visionByTurn.has('sess-1#3'), false);
  });

  /* ── GET /guard 是面板能读到的形状 ── */
  const guardBody = await (await call('guard', { query: { id: asked3.requestId } })).json();
  check('GET /guard 返回这一轮的步数 / token / 原因', () => {
    assert.equal(guardBody.ok, true);
    assert.equal(guardBody.guard.state, 'tripped');
    assert.equal(guardBody.guard.reason, 'timeout');
    assert.equal(guardBody.guard.limits.maxSteps, 2);
    assert.equal(guardBody.guard.limits.maxOutputTokens, 4000);
    assert.equal(guardBody.guard.limits.maxTurnTokens, 30000);
  });
  const unknown = await (await call('guard', { query: { id: 'nope' } })).json();
  check('未知 requestId → state unknown', () => assert.equal(unknown.guard.state, 'unknown'));

  const bySession = await (await call('guard', { query: { session: 'sess-1' } })).json();
  check('GET /guard?session= 取这个会话最近一条', () => {
    assert.equal(bySession.ok, true);
    assert.equal(bySession.guard.id, asked3.requestId);
    assert.equal(bySession.guard.reason, 'timeout');
  });
  const noSession = await call('guard');
  check('既没有 id 也没有 session → 400', () => assert.equal(noSession.status, 400));
}

console.log('健壮性：发布前封住的那几条');
{
  /* 用户上传的 .html 不能按 text/html 回给同源页面（存储型 XSS） */
  const html = Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8');
  const htmlDoc = (await upload('evil.html', html)).body.doc;
  const raw = await call('doc/raw', { query: { id: htmlDoc.id } });
  check('/doc/raw 把 html 降级成 text/plain + nosniff', () => {
    assert.equal(raw.status, 200);
    assert.ok(String(raw.headers.get('content-type')).startsWith('text/plain'), 'must not echo text/html');
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(raw.headers.get('content-disposition'), 'attachment');
  });
  const pdfRaw = await call('doc/raw', { query: { id: pdfDoc ? pdfDoc.id : '' } });
  check('/doc/raw 仍然让 pdf 内联（阅读器要用）', () => {
    if (!pdfDoc) return;
    assert.equal(pdfRaw.headers.get('content-type'), 'application/pdf');
    assert.equal(pdfRaw.headers.get('content-disposition'), null);
  });

  /* 非法 id 不能把 rm(recursive) 带出 docs/ */
  const traversal = await call('docs', { method: 'DELETE', query: { id: '..' } });
  check('DELETE /docs 拒绝非法 id（路径穿越）', () => assert.equal(traversal.status, 404));
  const dotted = await call('docs', { method: 'DELETE', query: { id: '../docmate' } });
  check('DELETE /docs 拒绝带斜杠的 id', () => assert.equal(dotted.status, 404));

  /* 畸形 URL 编码是 400，不是 500 */
  const badUri = await call('asset/%E0%A4%A');
  check('畸形 asset URI → 400（不是 500）', () => assert.equal(badUri.status, 400));

  /* 坏划线条目在读取时被丢掉，而不是让整篇文档打不开 */
  await writeFile(
    path.join(sandbox, 'docmate', 'docs', mdDoc.id, 'highlights.json'),
    JSON.stringify({
      version: 1,
      items: [
        { id: 'good', color: 'key', text: '还要能读', anchor: { scope: 'doc', start: 1, end: 5 } },
        { id: 'no-text', color: 'key', anchor: { scope: 'doc', start: 1, end: 5 } },
        { id: 'bad-anchor', text: '锚点坏了', anchor: { scope: 'doc', start: 9, end: 2 } },
        null,
        'nonsense',
      ],
    }),
    'utf8',
  );
  const cleaned = await (await call('doc/highlights', { query: { id: mdDoc.id } })).json();
  check('坏划线条目在读取时被丢弃，好的留下', () => {
    assert.equal(cleaned.items.length, 1);
    assert.equal(cleaned.items[0].id, 'good');
  });

  /* 请求体在读完之前就掐断，不能先 Buffer.concat 再查大小 */
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const chunks = [];
  for (let i = 0; i < 98; i += 1) chunks.push(chunk);
  const tooBig = await call('docs', { method: 'POST', query: { name: 'huge.txt' }, chunks });
  check('超大请求体 → 413（边读边掐，不 OOM）', () => assert.equal(tooBig.status, 413));
}

console.log('健壮性：index.json 损坏时回退 .bak');
{
  const dataDir = path.join(sandbox, 'docmate');
  const indexPath = path.join(dataDir, 'index.json');
  const good = await readFile(indexPath, 'utf8');
  await writeFile(indexPath + '.bak', good, 'utf8');
  await writeFile(indexPath, '{"version":1,"docs":[', 'utf8'); // 半截 JSON

  // 缓存是模块级的，所以换一个模块实例来模拟「重启后读到坏索引」。
  const fresh = await import('../index.js?broken=' + Date.now());
  const freshRoutes = [];
  const freshCtx = {
    get: (name) =>
      ({
        webServer: {
          register(routeDef) {
            freshRoutes.push(routeDef);
            return () => {};
          },
        },
        connection: { requestRejection: () => null },
        sessionController,
        agents: services.agents,
        tools: services.tools,
        schedule: services.schedule,
      })[name],
    on: () => () => {},
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };
  fresh.apply(freshCtx);
  const freshRoute = freshRoutes[0];
  const req = makeReq('GET', '/api/docmate/docs', {}, null);
  const res = makeRes();
  await freshRoute.handler(req, res);
  const body = JSON.parse(Buffer.from(res.body).toString('utf8'));
  check('index.json 坏了也能从 .bak 恢复出文档列表', () => {
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.docs) && body.docs.length >= 1, 'backup should still list documents');
  });
}

console.log('移除');
{
  const body = await (await call('docs', { method: 'DELETE', query: { id: docxDoc.id } })).json();
  check('DELETE /docs 移除文档', () => assert.equal(body.ok, true));
  const listed = await (await call('docs')).json();
  check('列表里不再有它', () => assert.ok(!listed.docs.some((doc) => doc.id === docxDoc.id)));
  const missing = await call('docs', { method: 'DELETE', query: { id: docxDoc.id } });
  check('重复移除 → 404', () => assert.equal(missing.status, 404));
}

console.log('卸载');
{
  const vision = plugin.visionInternals;
  for (const dispose of disposers) {
    try {
      dispose();
    } catch (error) {
      /* 卸载顺序不保证；这里只关心 vision guard 那一个 */
    }
  }
  check('dispose 后清掉 pending / 轮次索引 / 记录', () => {
    assert.equal(vision.visionPending.size, 0);
    assert.equal(vision.visionByTurn.size, 0);
    assert.equal(vision.visionLog.size, 0);
  });
  check('dispose 后 waterfall 监听被摘掉', () => {
    assert.equal((listeners.get('agent/pre-step') || []).length, 0);
    assert.equal((listeners.get('agent/request') || []).length, 0);
    assert.equal((listeners.get('tools/pre-execute') || []).length, 0);
  });
}

console.log('');
console.log(passed + ' 项通过' + (process.exitCode ? '（有失败）' : '，全绿'));

await rm(sandbox, { recursive: true, force: true });
