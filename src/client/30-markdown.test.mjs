/* 30-markdown.test.mjs —— 纯 node 自测（不联网、不装包、不起浏览器）
 * 用假 React（createElement 返回 {t,p,c} 树）验证 30-markdown.js。
 * 运行：node src/client/30-markdown.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.join(here, '30-markdown.js');

/* ---------- 加载被测片段 ----------
 * 包是 "type":"module"，直接 require(.js) 会按 ESM 解析、跳过 CJS 守卫，
 * 所以这里把源码文本塞进一个函数体执行 —— 与 build.mjs 把片段拼进
 * factory(require){...} 闭包的方式一致，同时让末尾的 CJS 守卫生效。
 */
const sourceText = fs.readFileSync(filePath, 'utf8');
const cjsModule = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('module', 'exports', sourceText)(cjsModule, cjsModule.exports);
const { createMarkdown } = cjsModule.exports;
assert.equal(typeof createMarkdown, 'function', 'module.exports.createMarkdown 必须是函数');

/* ---------- 假 React ---------- */
/* 数组 child 摊平一层，方便断言树形状（React 本身也接受数组 children） */
const fakeReact = {
  createElement: (t, p, ...c) => ({ t, p: p || {}, c: c.flat() }),
};
const { Markdown, parseMarkdown } = createMarkdown(fakeReact);

/* 带 useState 的假 React：用来验证属性条折叠（hooks 需要独立实例） */
function makeHookReact() {
  const state = { value: undefined };
  return {
    createElement: (t, p, ...c) => ({ t, p: p || {}, c: c.flat() }),
    useState: (init) => {
      if (state.value === undefined) state.value = init;
      return [state.value, (next) => { state.value = next; }];
    },
  };
}
assert.equal(typeof Markdown, 'function', 'Markdown 必须是组件函数');
assert.equal(typeof parseMarkdown, 'function', 'parseMarkdown 必须是函数');

/* ---------- 断言小工具 ---------- */
let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  \u2713 ' + name);
  } catch (e) {
    console.error('  \u2717 ' + name);
    throw e;
  }
}

function text(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'object') {
    if ('t' in node) return text(node.c); /* 渲染树 {t,p,c} */
    if (node.type === 'text' || node.type === 'code') return node.value || ''; /* AST 行内 */
    if (node.type === 'wikilink' || node.type === 'embed') return node.label || '';
    if (node.type === 'tag') return '#' + (node.name || '');
    if (node.type === 'math' || node.type === 'mathBlock') return node.tex || '';
    if (node.type === 'image') return node.alt || '';
    if (node.type === 'comment') return '';
    if (node.type === 'br') return '\n';
    if ('children' in node) return text(node.children); /* AST 容器 */
  }
  return '';
}

function findAll(node, pred, acc = []) {
  if (node == null) return acc;
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, pred, acc);
    return acc;
  }
  if (typeof node === 'object' && 't' in node) {
    if (pred(node)) acc.push(node);
    findAll(node.c, pred, acc);
  }
  return acc;
}

function classes(node) {
  return String((node && node.p && node.p.className) || '').split(/\s+/).filter(Boolean);
}
function hasClass(node, c) {
  return classes(node).includes(c);
}
function render(source, className) {
  return Markdown({ source, className });
}
function renderText(source) {
  return text(render(source));
}
/* 递归展开函数组件（假 React 不会自动调用组件；用来检查真实 DOM 树） */
function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (node && typeof node === 'object' && 't' in node) {
    if (typeof node.t === 'function') return expand(node.t(node.p));
    return { t: node.t, p: node.p, c: expand(node.c) };
  }
  return node;
}
function renderExpanded(source) {
  return expand(render(source));
}

/* ================= [1] 标题 ================= */
console.log('\n[1] ATX 标题');
ok('1~6 级标题全部识别', () => {
  for (let lv = 1; lv <= 6; lv += 1) {
    const ast = parseMarkdown('#'.repeat(lv) + ' T' + lv);
    assert.equal(ast.length, 1);
    assert.equal(ast[0].type, 'heading');
    assert.equal(ast[0].level, lv);
    assert.equal(text(ast[0].children), 'T' + lv);
  }
});
ok('7 个 # 不是标题', () => {
  assert.equal(parseMarkdown('####### x')[0].type, 'paragraph');
});
ok('#abc 不是标题（缺空格）', () => {
  assert.equal(parseMarkdown('#abc')[0].type, 'paragraph');
});
ok('尾部 # 被去掉', () => {
  assert.equal(text(parseMarkdown('## Hi ##')[0].children), 'Hi');
});
ok('渲染成 h2.dm-md-h2', () => {
  const el = render('## Hi');
  assert.equal(el.t, 'div');
  assert.ok(hasClass(el, 'dm-md'));
  const h2 = el.c[0];
  assert.equal(h2.t, 'h2');
  assert.ok(hasClass(h2, 'dm-md-h2'));
  assert.equal(text(h2), 'Hi');
});

/* ================= [2] 行内 ================= */
console.log('\n[2] 行内语法');
ok('粗/斜/删/行内码', () => {
  const kids = parseMarkdown('**b** *i* ~~s~~ `c`')[0].children;
  assert.deepEqual(kids.map((k) => k.type), ['strong', 'text', 'em', 'text', 'del', 'text', 'code']);
  assert.equal(text(kids[0].children), 'b');
  assert.equal(text(kids[2].children), 'i');
  assert.equal(text(kids[4].children), 's');
  assert.equal(kids[6].value, 'c');
});
ok('行内元素 class', () => {
  const el = render('**b** *i* ~~s~~ `c`');
  assert.ok(hasClass(findAll(el, (n) => n.t === 'strong')[0], 'dm-md-strong'));
  assert.ok(hasClass(findAll(el, (n) => n.t === 'em')[0], 'dm-md-em'));
  assert.ok(hasClass(findAll(el, (n) => n.t === 'del')[0], 'dm-md-del'));
  assert.ok(hasClass(findAll(el, (n) => n.t === 'code')[0], 'dm-md-code-inline'));
});
ok('链接属性 target/rel/href/title', () => {
  const el = render('[L](https://e.com/x "T")');
  const a = findAll(el, (n) => n.t === 'a')[0];
  assert.ok(a, '应有 <a>');
  assert.equal(a.p.href, 'https://e.com/x');
  assert.equal(a.p.target, '_blank');
  assert.equal(a.p.rel, 'noreferrer');
  assert.equal(a.p.title, 'T');
  assert.ok(hasClass(a, 'dm-md-a'));
  assert.equal(text(a), 'L');
});
ok('链接文字里可以有行内格式', () => {
  const el = render('[**粗** 链](u)');
  assert.equal(findAll(el, (n) => n.t === 'strong').length, 1);
  assert.equal(text(el), '粗 链');
});
ok('图片属性 loading=lazy / alt / class', () => {
  const el = expand(render('![A](a.png)'));
  const img = findAll(el, (n) => n.t === 'img')[0];
  assert.ok(img, '应有 <img>');
  assert.equal(img.p.src, 'a.png');
  assert.equal(img.p.alt, 'A');
  assert.equal(img.p.loading, 'lazy');
  assert.ok(hasClass(img, 'dm-md-img'));
  assert.equal(typeof img.p.onError, 'function', '应有 onError 走占位降级');
});
ok('链接套图片', () => {
  const el = expand(render('[![A](a.png)](u)'));
  assert.equal(findAll(el, (n) => n.t === 'a').length, 1);
  assert.equal(findAll(el, (n) => n.t === 'img').length, 1);
});
ok('硬换行（行尾两空格）', () => {
  const kids = parseMarkdown('a  \nb')[0].children;
  assert.deepEqual(kids.map((k) => k.type), ['text', 'br', 'text']);
  assert.equal(kids[0].value, 'a');
  assert.equal(kids[2].value, 'b');
  assert.ok(hasClass(findAll(render('a  \nb'), (n) => n.t === 'br')[0], 'dm-md-br'));
});
ok('软换行变空格', () => {
  assert.equal(text(parseMarkdown('a\nb')[0].children), 'a b');
});
ok('转义 \\*', () => {
  assert.equal(text(parseMarkdown('\\*not em\\*')[0].children), '*not em*');
});
ok('下划线强调（snake_case 不误伤）', () => {
  assert.equal(text(parseMarkdown('_i_')[0].children), 'i');
  assert.equal(text(parseMarkdown('snake_case_name')[0].children), 'snake_case_name');
});
ok('危险 URL 降级成文本', () => {
  const el = render('[x](javascript:alert(1))');
  assert.equal(findAll(el, (n) => n.t === 'a').length, 0);
  assert.equal(text(el), 'x');
  const el2 = render('![x](javascript:alert(1))');
  assert.equal(findAll(el2, (n) => n.t === 'img').length, 0);
  assert.equal(text(el2), 'x');
});
ok('原始 HTML 只当文本，不生成元素', () => {
  const el = render('<script>alert(1)</script>');
  assert.equal(findAll(el, (n) => n.t === 'script').length, 0);
  assert.ok(text(el).includes('<script>'));
});

/* ================= [3] 块级 ================= */
console.log('\n[3] 块级语法');
ok('分隔线', () => {
  for (const s of ['---', '***', '___', '- - -']) {
    assert.equal(parseMarkdown(s)[0].type, 'hr', JSON.stringify(s));
  }
  assert.ok(hasClass(findAll(render('---'), (n) => n.t === 'hr')[0], 'dm-md-hr'));
});
ok('围栏代码块（含语言）', () => {
  const ast = parseMarkdown('```js\nconst a = 1;\n```');
  assert.equal(ast[0].type, 'code');
  assert.equal(ast[0].lang, 'js');
  assert.equal(ast[0].code, 'const a = 1;');
  const el = render('```js\nconst a = 1;\n```');
  const pre = findAll(el, (n) => n.t === 'pre')[0];
  assert.ok(pre, '应有 <pre>');
  assert.ok(hasClass(pre, 'dm-md-pre'));
  const code = findAll(pre, (n) => n.t === 'code')[0];
  assert.ok(code, 'pre 里应有 <code>');
  assert.ok(hasClass(code, 'dm-md-code'));
  assert.equal(text(code), 'const a = 1;');
});
ok('未闭合围栏不抛异常', () => {
  const ast = parseMarkdown('```\nabc\ndef');
  assert.equal(ast[0].type, 'code');
  assert.equal(ast[0].code, 'abc\ndef');
});
ok('波浪号围栏', () => {
  const ast = parseMarkdown('~~~\nx\n~~~');
  assert.equal(ast[0].type, 'code');
  assert.equal(ast[0].code, 'x');
});
ok('引用（含标题与列表）', () => {
  const ast = parseMarkdown('> # H\n> - x');
  assert.equal(ast[0].type, 'blockquote');
  assert.deepEqual(ast[0].children.map((b) => b.type), ['heading', 'list']);
  const el = render('> hi');
  const bq = findAll(el, (n) => n.t === 'blockquote')[0];
  assert.ok(bq);
  assert.ok(hasClass(bq, 'dm-md-quote'));
  assert.equal(text(bq), 'hi');
});
ok('表格 + 对齐', () => {
  const src = '| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| 4 | 5 |';
  const ast = parseMarkdown(src);
  assert.equal(ast[0].type, 'table');
  assert.deepEqual(ast[0].align, ['left', 'center', 'right']);
  assert.equal(ast[0].header.length, 3);
  assert.equal(ast[0].rows.length, 2);
  assert.equal(ast[0].rows[1].length, 3, '短行应补齐空 cell');
  const el = render(src);
  const table = findAll(el, (n) => n.t === 'table')[0];
  assert.ok(table);
  assert.ok(hasClass(table, 'dm-md-table'));
  const ths = findAll(el, (n) => n.t === 'th');
  assert.equal(ths.length, 3);
  assert.ok(hasClass(ths[0], 'dm-md-align-left'));
  assert.ok(hasClass(ths[1], 'dm-md-align-center'));
  assert.ok(hasClass(ths[2], 'dm-md-align-right'));
  const tds = findAll(el, (n) => n.t === 'td');
  assert.equal(tds.length, 6);
  assert.equal(text(tds[0]), '1');
  assert.equal(text(tds[5]), '');
});
ok('表格里的转义竖线', () => {
  const ast = parseMarkdown('| a\\|b | c |\n|---|---|\n| 1 | 2 |');
  assert.equal(ast[0].type, 'table');
  assert.equal(text(ast[0].header[0]), 'a|b');
});
ok('列数不匹配的伪表格降级为段落', () => {
  const ast = parseMarkdown('a | b\n---');
  assert.equal(ast[0].type, 'paragraph');
});

/* ================= [4] 列表 ================= */
console.log('\n[4] 列表');
ok('无序嵌套列表（三层）', () => {
  const ast = parseMarkdown('- a\n  - b\n    - c\n- d');
  assert.equal(ast[0].type, 'list');
  assert.equal(ast[0].ordered, false);
  assert.equal(ast[0].items.length, 2);
  assert.deepEqual(ast[0].items[0].blocks.map((b) => b.type), ['paragraph', 'list']);
  const inner = ast[0].items[0].blocks[1];
  assert.deepEqual(inner.items[0].blocks.map((b) => b.type), ['paragraph', 'list']);
  const el = render('- a\n  - b\n    - c\n- d');
  assert.equal(findAll(el, (n) => n.t === 'ul').length, 3);
  assert.equal(findAll(el, (n) => n.t === 'li').length, 4);
  assert.equal(text(el), 'abcd');
  assert.ok(hasClass(findAll(el, (n) => n.t === 'ul')[0], 'dm-md-ul'));
  assert.ok(hasClass(findAll(el, (n) => n.t === 'li')[0], 'dm-md-li'));
});
ok('有序列表起始编号', () => {
  const ast = parseMarkdown('3. x\n4. y');
  assert.equal(ast[0].type, 'list');
  assert.equal(ast[0].ordered, true);
  assert.equal(ast[0].start, 3);
  assert.equal(ast[0].items.length, 2);
  const ol = findAll(render('3. x'), (n) => n.t === 'ol')[0];
  assert.equal(ol.p.start, 3);
  assert.ok(hasClass(ol, 'dm-md-ol'));
});
ok('有序列表 1) 形式', () => {
  const ast = parseMarkdown('1) a\n2) b');
  assert.equal(ast[0].ordered, true);
  assert.equal(ast[0].items.length, 2);
});
ok('任务列表', () => {
  const ast = parseMarkdown('- [ ] todo\n- [x] done');
  assert.equal(ast[0].items[0].checked, false);
  assert.equal(ast[0].items[1].checked, true);
  const el = render('- [ ] todo\n- [x] done');
  const inputs = findAll(el, (n) => n.t === 'input');
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].p.type, 'checkbox');
  assert.equal(inputs[0].p.checked, false);
  assert.equal(inputs[1].p.checked, true);
  assert.ok(hasClass(inputs[0], 'dm-md-checkbox'));
  const lis = findAll(el, (n) => n.t === 'li');
  assert.ok(hasClass(lis[0], 'dm-md-task'));
  assert.ok(hasClass(lis[1], 'dm-md-task-done'));
  assert.equal(text(lis[0]), 'todo');
});
ok('列表项里的多段落', () => {
  const ast = parseMarkdown('- a\n\n  b');
  assert.deepEqual(ast[0].items[0].blocks.map((b) => b.type), ['paragraph', 'paragraph']);
});
ok('列表项里的代码块', () => {
  const src = '- 说明\n\n  ```js\n  x\n  ```';
  const ast = parseMarkdown(src);
  assert.equal(ast[0].type, 'list');
  assert.deepEqual(ast[0].items[0].blocks.map((b) => b.type), ['paragraph', 'code']);
});
ok('列表打断段落', () => {
  const ast = parseMarkdown('前言\n- a\n- b');
  assert.deepEqual(ast.map((b) => b.type), ['paragraph', 'list']);
});

/* ================= [5] 段落 ================= */
console.log('\n[5] 段落');
ok('多段落', () => {
  const ast = parseMarkdown('one\n\ntwo');
  assert.deepEqual(ast.map((b) => b.type), ['paragraph', 'paragraph']);
  assert.equal(text(ast[0].children), 'one');
  assert.equal(text(ast[1].children), 'two');
  assert.ok(hasClass(findAll(render('x'), (n) => n.t === 'p')[0], 'dm-md-p'));
});
ok('空文档 / 只有空行', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('\n\n   \n'), []);
  assert.deepEqual(parseMarkdown(null), []);
  assert.deepEqual(parseMarkdown(undefined), []);
});

/* ================= [6] 健壮性 ================= */
console.log('\n[6] 健壮性（畸形输入不抛异常）');
ok('畸形输入全都不抛异常且渲染出根 div', () => {
  const weird = [
    '', '   ', '\n\n\n', '**', '***', '****', '`', '``', '```', '~~~',
    '[', '[a](', '![', '![](', '[]()', '|', '| a |', '| a |\n|',
    '>', '>'.repeat(400), '- ', '1.', '#######', '\u0000\u0001',
    'a|b\n---', '~~', '\\', '**unclosed', '*unclosed', '`unclosed',
    '| a | b |\n|---|---|\n' + '| 1 | 2 |\n'.repeat(200),
    '*'.repeat(3000), '`'.repeat(3000), '- '.repeat(1500),
    '> '.repeat(400), '\n'.repeat(500), '[a](b'.repeat(500),
    /* Obsidian 畸形输入 */
    '[[', ']]', '![[', '==', '%%', '---\n', '---\ntitle', '#', '#include',
    '[[a|', '![[a|]]', '> [!', '> [!info', '%%\n%%\n%%',
    '---\ntitle: x\n---\n---', '[[a'.repeat(500), '=='.repeat(500),
    '%%'.repeat(500), '> [!info]'.repeat(200), '---\n' + 'k: v\n'.repeat(300) + '---',
    /* 病态 Obsidian 输入：缺 ]] 的 [[ 不能退化成 O(n^2) */
    '['.repeat(8000), '[['.repeat(5000), '![[ '.repeat(3000),
    '[['.repeat(3000) + ' | x', 'a | ' + '['.repeat(4000),
    '=='.repeat(5000), '%%'.repeat(5000), '~~'.repeat(5000), '``'.repeat(3000),
    /* 病态公式输入 */
    '$'.repeat(5000), '$$'.repeat(3000), '$a'.repeat(3000), '$$\n'.repeat(500),
    '$x$'.repeat(2000), null, undefined, 123, true, {}, [], () => {},
  ];
  const t0 = Date.now();
  for (const s of weird) {
    assert.doesNotThrow(() => parseMarkdown(s), 'parse 抛异常: ' + String(s).slice(0, 24));
    let el;
    assert.doesNotThrow(() => { el = render(s); }, 'render 抛异常: ' + String(s).slice(0, 24));
    assert.equal(el.t, 'div');
  }
  const cost = Date.now() - t0;
  assert.ok(cost < 5000, '病态输入处理耗时过长: ' + cost + 'ms');
  console.log('    （病态输入总耗时 ' + cost + 'ms）');
});
ok('深嵌套不爆栈', () => {
  let src = '';
  for (let i = 0; i < 40; i += 1) src += '  '.repeat(i) + '- n' + i + '\n';
  assert.doesNotThrow(() => render(src));
  let q = '';
  for (let i = 0; i < 60; i += 1) q += '> ';
  q += 'deep';
  assert.doesNotThrow(() => render(q));
});
ok('parseMarkdown 是纯函数（同输入同输出）', () => {
  const src = '# H\n\n- a\n  - b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```js\nx\n```';
  assert.deepEqual(parseMarkdown(src), parseMarkdown(src));
  assert.deepEqual(parseMarkdown(src), parseMarkdown(src));
});
ok('Markdown 组件 props 兜底', () => {
  assert.equal(Markdown({}).p.className, 'dm-md');
  assert.deepEqual(Markdown({}).c, []);
  assert.equal(Markdown().t, 'div');
  assert.equal(Markdown({ source: 123 }).t, 'div');
  assert.equal(render('x', 'doc-body').p.className, 'dm-md doc-body');
  assert.equal(render('x', '  ').p.className, 'dm-md');
});

/* ================= [7] 源码约束 ================= */
console.log('\n[7] 源码约束（契约 §0/§1/§3/§7）');
ok('无原始 HTML 注入 / 无 import / 无 export / 无 require', () => {
  const src = fs.readFileSync(filePath, 'utf8');
  assert.ok(!src.includes('dangerously' + 'SetInnerHTML'), '不得使用原始 HTML 注入');
  assert.ok(!/^\s*import\s/m.test(src), '不得有 import');
  assert.ok(!/^\s*export\s/m.test(src), '不得有 export');
  assert.ok(!/\brequire\s*\(/.test(src), '不得 require 其它模块');
  assert.ok(!/^\s*await\s/m.test(src), '不得有顶层 await');
});
ok('文件末尾有 CJS 导出守卫', () => {
  const src = fs.readFileSync(filePath, 'utf8');
  assert.ok(
    /if \(typeof module !== 'undefined' && module\.exports\) module\.exports = \{ createMarkdown \};/.test(src),
    '缺少导出守卫'
  );
  assert.ok(src.trimEnd().endsWith('module.exports = { createMarkdown };'), '导出守卫必须在文件末尾');
});
ok('只依赖参数 React（不碰 window/document）', () => {
  const src = fs.readFileSync(filePath, 'utf8');
  assert.ok(!/\bwindow\s*\./.test(src), '不得访问 window');
  assert.ok(!/\bdocument\s*\./.test(src), '不得访问 document');
});
ok('浏览器环境（无 module）下片段可安全执行', () => {
  /* 模拟 build.mjs 的 factory 闭包：作用域里没有 module，导出守卫必须静默跳过 */
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    const factory = new Function('React', sourceText + '\nreturn createMarkdown;');
    const createMarkdownFn = factory(fakeReact);
    const cm = createMarkdownFn(fakeReact);
    assert.equal(typeof cm.Markdown, 'function');
    assert.equal(typeof cm.parseMarkdown, 'function');
    const el = cm.Markdown({ source: '# x', className: 'dm-prose' });
    assert.equal(el.t, 'div');
    assert.equal(el.p.className, 'dm-md dm-prose');
  });
});

/* ================= [8] 性能 ================= */
console.log('\n[8] 大文档性能');
ok('150KB 混合文档解析 + 渲染 < 1000ms', () => {
  const block = [
    '## 第 N 节 标题', '',
    '这是**粗体**、*斜体*、~~删除~~、`行内码` 和 [链接](https://example.com) 的混排段落，',
    '第二行结尾有硬换行  ', '第三行。', '',
    '- 无序一', '  - 嵌套二', '    - 嵌套三', '- [x] 已完成任务', '- [ ] 未完成任务', '',
    '1. 有序一', '2. 有序二', '',
    '> 引用行', '> > 二级引用', '',
    '| 左 | 中 | 右 |', '|:---|:---:|---:|', '| 1 | 2 | 3 |', '',
    '```js', 'const x = 1; // 代码块', '```', '', '---', '',
  ].join('\n');
  let doc = '';
  let n = 0;
  while (Buffer.byteLength(doc) < 150 * 1024) {
    n += 1;
    doc += block.replace('第 N 节', '第 ' + n + ' 节') + '\n';
  }
  const t0 = Date.now();
  const ast = parseMarkdown(doc);
  const el = render(doc, 'dm-prose');
  const cost = Date.now() - t0;
  assert.ok(ast.length > 1000, '应解析出上千个块: ' + ast.length);
  assert.equal(el.t, 'div');
  assert.ok(cost < 1000, '150KB 文档过慢: ' + cost + 'ms');
  console.log('    （150KB / ' + doc.split('\n').length + ' 行 → ' + ast.length +
    ' blocks，解析+渲染 ' + cost + 'ms）');
});

/* ================= [9] Obsidian frontmatter ================= */
console.log('\n[9] Obsidian frontmatter（属性条）');
ok('frontmatter 解析成独立块，不进正文', () => {
  const src = '---\ntitle: 碘吸附DFT计算实战手册\ntags: [DFT, Zn-I2, 主文档, ORCA, MOC]\ncreated: 2026-07-24\nupdated: 2026-08-07\nstatus: 进行中\n---\n\n# 第 0 章 总览\n\n正文。';
  const ast = parseMarkdown(src);
  assert.equal(ast[0].type, 'frontmatter');
  assert.equal(ast[0].data.title, '碘吸附DFT计算实战手册');
  assert.deepEqual(ast[0].data.tags, ['DFT', 'Zn-I2', '主文档', 'ORCA', 'MOC']);
  assert.equal(ast[0].data.created, '2026-07-24');
  assert.equal(ast[0].data.status, '进行中');
  assert.ok(ast[0].raw.includes('title:'));
  assert.deepEqual(ast.slice(1).map((b) => b.type), ['heading', 'paragraph']);
  assert.equal(renderText(src), '第 0 章 总览正文。');
});
ok('属性条结构：item / key / value / tags chip / hint', () => {
  const src = '---\ntitle: 手册\ntags: [DFT, Zn-I2]\n---\nbody';
  const el = render(src);
  const bar = el.c[0];
  assert.equal(typeof bar.t, 'function', '第一个子节点应是 MetaBar 组件');
  const barEl = bar.t(bar.p);
  assert.equal(barEl.t, 'div');
  assert.ok(hasClass(barEl, 'dm-md-meta'));
  assert.ok(!hasClass(barEl, 'is-open'), '默认折叠（CSS: .dm-md-meta:not(.is-open)）');
  assert.equal(barEl.p.role, 'button');
  assert.equal(barEl.p['aria-expanded'], 'false');
  const items = findAll(barEl, (n) => n.t === 'span' && hasClass(n, 'dm-md-meta__item'));
  assert.equal(items.length, 2);
  const keys = findAll(barEl, (n) => n.t === 'b');
  assert.deepEqual(keys.map(text), ['title', 'tags']);
  assert.ok(hasClass(keys[0], 'dm-md-meta__key'));
  const chips = findAll(barEl, (n) => n.t === 'span' && hasClass(n, 'dm-md-meta__tag'));
  assert.deepEqual(chips.map(text), ['DFT', 'Zn-I2']);
  const values = findAll(barEl, (n) => n.t === 'span' && hasClass(n, 'dm-md-meta__value'));
  assert.deepEqual(values.map(text), ['手册']);
  const hint = findAll(barEl, (n) => n.t === 'span' && hasClass(n, 'dm-md-meta__hint'))[0];
  assert.ok(hint, '应有 dm-md-meta__hint（Lead CSS 里有这条规则）');
  assert.equal(text(hint), '点击展开');
});
ok('属性条点击展开 / 收起（useState）', () => {
  const md = createMarkdown(makeHookReact());
  const el = md.Markdown({ source: '---\ntitle: x\n---\nbody' });
  const bar = el.c[0];
  const collapsed = bar.t(bar.p);
  assert.ok(!hasClass(collapsed, 'is-open'));
  assert.equal(text(findAll(collapsed, (n) => hasClass(n, 'dm-md-meta__hint'))[0]), '点击展开');
  collapsed.p.onClick({ preventDefault() {} });
  const opened = bar.t(bar.p);
  assert.ok(hasClass(opened, 'is-open'));
  assert.equal(opened.p['aria-expanded'], 'true');
  assert.equal(text(findAll(opened, (n) => hasClass(n, 'dm-md-meta__hint'))[0]), '点击收起');
  opened.p.onClick({ preventDefault() {} });
  const closed = bar.t(bar.p);
  assert.ok(!hasClass(closed, 'is-open'));
  assert.equal(closed.p['aria-expanded'], 'false');
});
ok('没有 frontmatter 时不输出属性条', () => {
  const el = render('# H\n\n正文');
  assert.equal(findAll(el, (n) => n.t === 'div' && hasClass(n, 'dm-md-meta')).length, 0);
  assert.equal(el.c[0].t, 'h1');
});
ok('frontmatter 边界：单 --- / 非 YAML / 未闭合 / 只有头', () => {
  assert.equal(parseMarkdown('---')[0].type, 'hr');
  assert.deepEqual(
    parseMarkdown('---\nnot yaml\n---\nbody').map((b) => b.type),
    ['hr', 'paragraph', 'hr', 'paragraph'],
    '解析不出键就不当 frontmatter，正文不能丢'
  );
  const unclosed = parseMarkdown('---\ntitle: x\nbody');
  assert.equal(unclosed[0].type, 'hr');
  const only = parseMarkdown('---\ntitle: x\n---');
  assert.deepEqual(only.map((b) => b.type), ['frontmatter']);
  const empty = parseMarkdown('---\n---\nbody');
  assert.equal(empty[0].type, 'frontmatter');
  assert.equal(empty[1].type, 'paragraph');
});
ok('frontmatter：块状 tags / 引号 / ... 收尾 / tags 逗号串', () => {
  const a = parseMarkdown('---\ntags:\n  - a\n  - b\n---\nx');
  assert.deepEqual(a[0].data.tags, ['a', 'b']);
  const b = parseMarkdown('---\ntitle: "a: b"\n---\nx');
  assert.equal(b[0].data.title, 'a: b');
  const c = parseMarkdown('---\ntitle: x\n...\nx');
  assert.equal(c[0].type, 'frontmatter');
  const d = parseMarkdown('---\ntags: a, b, c\n---\nx');
  assert.deepEqual(d[0].data.tags, ['a', 'b', 'c']);
});

/* ================= [10] Obsidian callout ================= */
console.log('\n[10] Obsidian callout');
ok('callout 基本信息：类型 / 标题 / 正文', () => {
  const src = '> [!info] 项目定位\n> · 体系：Cd₀.₅Zn₀.₅S（CZS）/ CdS / ZnS / AC\n> - 列表项';
  const ast = parseMarkdown(src);
  assert.equal(ast[0].type, 'callout');
  assert.equal(ast[0].kind, 'info');
  assert.equal(text(ast[0].title), '项目定位');
  assert.deepEqual(ast[0].blocks.map((b) => b.type), ['paragraph', 'list']);
  const box = expand(render(src)).c[0];
  assert.equal(box.t, 'div');
  assert.ok(hasClass(box, 'dm-md-callout'));
  assert.ok(hasClass(box, 'dm-md-callout--info'));
  assert.ok(hasClass(box, 'dm-md-callout--blue'));
  const title = findAll(box, (n) => n.t === 'div' && hasClass(n, 'dm-md-callout__title'))[0];
  const body = findAll(box, (n) => n.t === 'div' && hasClass(n, 'dm-md-callout__body'))[0];
  assert.equal(text(title), '项目定位');
  assert.ok(body, '应有 dm-md-callout__body');
  assert.ok(text(body).includes('· 体系'));
  assert.equal(findAll(body, (n) => n.t === 'ul').length, 1, '正文保持块级解析');
});
ok('callout 类型 → 5 组配色', () => {
  const cases = [
    ['info', 'blue'], ['todo', 'blue'],
    ['tip', 'green'], ['success', 'green'], ['check', 'green'],
    ['warning', 'yellow'], ['caution', 'yellow'], ['attention', 'yellow'],
    ['danger', 'red'], ['error', 'red'], ['failure', 'red'], ['bug', 'red'],
    ['note', 'gray'], ['quote', 'gray'], ['cite', 'gray'],
    ['mystery', 'gray'],
  ];
  for (const [kind, group] of cases) {
    const box = expand(render('> [!' + kind + '] t\n> x')).c[0];
    assert.ok(hasClass(box, 'dm-md-callout--' + kind), kind);
    assert.ok(hasClass(box, 'dm-md-callout--' + group), kind + ' → ' + group);
  }
});
ok('callout 空标题用中文默认名', () => {
  const cases = [
    ['info', '信息'], ['note', '笔记'], ['tip', '提示'], ['warning', '注意'],
    ['danger', '危险'], ['todo', '待办'], ['quote', '引用'], ['success', '完成'],
    ['mystery', 'mystery'],
  ];
  for (const [kind, name] of cases) {
    const title = findAll(expand(render('> [!' + kind + ']\n> x')),
      (n) => n.t === 'div' && hasClass(n, 'dm-md-callout__title'))[0];
    assert.equal(text(title), name, kind);
  }
});
ok('callout 折叠标记 - / +', () => {
  const folded = expand(render('> [!compass]- 🧭 文档导航（MOC）\n> x')).c[0];
  assert.ok(hasClass(folded, 'dm-md-callout--foldable'));
  assert.ok(hasClass(folded, 'dm-md-callout--folded'));
  const plus = expand(render('> [!info]+ t\n> x')).c[0];
  assert.ok(hasClass(plus, 'dm-md-callout--foldable'));
  assert.ok(!hasClass(plus, 'dm-md-callout--folded'));
});
ok('callout 折叠交互：点标题展开 / 收起（useState）', () => {
  const md = createMarkdown(makeHookReact());
  const el = md.Markdown({ source: '> [!info]- 标题\n> body' });
  const box = el.c[0].t(el.c[0].p); /* 初始：- 折叠 */
  assert.ok(hasClass(box, 'dm-md-callout--folded'));
  assert.ok(hasClass(box, 'dm-md-callout--foldable'));
  assert.equal(typeof box.c[0].p.onClick, 'function', '标题应可点击');
  box.c[0].p.onClick({ preventDefault() {} });
  const box2 = el.c[0].t(el.c[0].p);
  assert.ok(!hasClass(box2, 'dm-md-callout--folded'), '点击后展开');
  box2.c[0].p.onClick({ preventDefault() {} });
  const box3 = el.c[0].t(el.c[0].p);
  assert.ok(hasClass(box3, 'dm-md-callout--folded'), '再点收起');
  /* 无折叠标记的 callout 不可折叠、标题无 onClick */
  const plain = expand(render('> [!info] t\n> body')).c[0];
  assert.ok(!hasClass(plain, 'dm-md-callout--foldable'));
  assert.equal(plain.c[0].p.onClick, undefined);
});
ok('callout 大小写不敏感', () => {
  const box = expand(render('> [!TIP] t\n> x')).c[0];
  assert.ok(hasClass(box, 'dm-md-callout--tip'));
  assert.ok(hasClass(box, 'dm-md-callout--green'));
});
ok('callout 标题支持行内语法（粗体 / wikilink）', () => {
  const src = '> [!info] **粗** 和 [[目标]]\n> x';
  const title = findAll(expand(render(src)),
    (n) => n.t === 'div' && hasClass(n, 'dm-md-callout__title'))[0];
  assert.equal(findAll(title, (n) => n.t === 'strong').length, 1);
  assert.equal(findAll(title, (n) => n.t === 'a' && hasClass(n, 'dm-md-wikilink')).length, 1);
});
ok('普通引用不受影响', () => {
  const ast = parseMarkdown('> 普通引用\n> 第二行');
  assert.equal(ast[0].type, 'blockquote');
  const el = render('> 普通引用\n> 第二行');
  assert.equal(el.c[0].t, 'blockquote');
  assert.ok(hasClass(el.c[0], 'dm-md-quote'));
  assert.equal(findAll(el, (n) => n.t === 'div' && hasClass(n, 'dm-md-callout')).length, 0);
  assert.equal(text(el.c[0]), '普通引用 第二行');
});
ok('空行分隔的两个引用是两个块（callout 不会互相吞）', () => {
  assert.deepEqual(parseMarkdown('> a\n\n> b').map((b) => b.type), ['blockquote', 'blockquote']);
  assert.deepEqual(
    parseMarkdown('> [!info] a\n> x\n\n> [!tip] b\n> y').map((b) => b.type),
    ['callout', 'callout']
  );
});
ok('嵌套 callout', () => {
  const src = '> [!info] 外\n> > [!tip] 内\n> > x';
  const callouts = findAll(expand(render(src)), (n) => n.t === 'div' && hasClass(n, 'dm-md-callout'));
  assert.equal(callouts.length, 2);
});
ok('callout 正文里列表 / 代码块正常', () => {
  const listBox = expand(render('> [!info] t\n> - a\n> - b')).c[0];
  assert.equal(findAll(listBox, (n) => n.t === 'li').length, 2);
  const codeBox = expand(render('> [!info] t\n> ```js\n> x\n> ```')).c[0];
  assert.equal(findAll(codeBox, (n) => n.t === 'pre').length, 1);
});

/* ================= [11] Obsidian wikilink / embed ================= */
console.log('\n[11] Obsidian wikilink / embed');
ok('wikilink 四种形态', () => {
  const el = render('[[目标]] [[目标|别名]] [[#第 0 章 总览]] [[笔记#标题]]');
  const links = findAll(el, (n) => n.t === 'a' && hasClass(n, 'dm-md-wikilink'));
  assert.equal(links.length, 4);
  assert.equal(links[0].p.href, '#');
  assert.equal(links[0].p['data-target'], '目标');
  assert.equal(text(links[0]), '目标');
  assert.equal(links[0].p['data-anchor'], undefined);
  assert.equal(links[1].p['data-target'], '目标');
  assert.equal(text(links[1]), '别名');
  assert.equal(links[2].p['data-target'], '#第 0 章 总览');
  assert.equal(links[2].p['data-anchor'], '第 0 章 总览');
  assert.equal(text(links[2]), '第 0 章 总览');
  assert.equal(links[3].p['data-target'], '笔记#标题');
  assert.equal(text(links[3]), '笔记 › 标题');
});
ok('wikilink 点击 preventDefault（且空事件不抛）', () => {
  const a = findAll(render('[[目标]]'), (n) => n.t === 'a' && hasClass(n, 'dm-md-wikilink'))[0];
  let prevented = false;
  a.p.onClick({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.doesNotThrow(() => a.p.onClick(null));
  assert.doesNotThrow(() => a.p.onClick({}));
});
ok('embed ![[...]] 只占位，不当图片', () => {
  const el = expand(render('![[图片.png]] ![[图片.png|300]] ![[a.png|大图]]'));
  assert.equal(findAll(el, (n) => n.t === 'img').length, 0);
  const spans = findAll(el, (n) => n.t === 'span' && hasClass(n, 'dm-md-embed'));
  assert.equal(spans.length, 3);
  assert.deepEqual(spans.map(text), ['图片.png', '图片.png', '大图']);
});
ok('wikilink 畸形输入降级为文本', () => {
  for (const s of ['[[', '[[a', 'a [[ b', '[[]]', '![[', '![[a', '[[a|', '![[a|]]']) {
    assert.doesNotThrow(() => render(s), s);
  }
  assert.ok(renderText('a [[ b').includes('[[ b'));
});
ok('表格里的 wikilink 别名不切列', () => {
  const src = '| [[a|b]] | c |\n|---|---|\n| [[x#y|z]] | 2 |';
  const ast = parseMarkdown(src);
  assert.equal(ast[0].type, 'table');
  assert.equal(ast[0].header.length, 2);
  assert.equal(text(ast[0].header[0]), 'b');
  assert.equal(text(ast[0].rows[0][0]), 'z');
});
ok('表格里的行内码竖线不切列', () => {
  const ast = parseMarkdown('| `a|b` | c |\n|---|---|\n| 1 | 2 |');
  assert.equal(ast[0].header.length, 2);
  assert.equal(text(ast[0].header[0]), 'a|b');
});

/* ================= [12] Obsidian 高亮 / 标签 / 注释 ================= */
console.log('\n[12] Obsidian ==高亮== / #标签 / %%注释%%');
ok('==高亮==', () => {
  const mark = findAll(render('这是 ==高亮== 文字'), (n) => n.t === 'mark')[0];
  assert.ok(mark);
  assert.ok(hasClass(mark, 'dm-md-mark'));
  assert.equal(text(mark), '高亮');
  assert.equal(findAll(render('==**粗**=='), (n) => n.t === 'strong').length, 1);
});
ok('== 未闭合不误伤', () => {
  assert.equal(renderText('a == b'), 'a == b');
  assert.equal(renderText('x ==a== y'), 'x a y');
});
ok('#标签 正常渲染', () => {
  const tags = findAll(render('#DFT 和 #主文档。'), (n) => n.t === 'span' && hasClass(n, 'dm-md-tag'));
  assert.equal(tags.length, 2);
  assert.deepEqual(tags.map(text), ['#DFT', '#主文档']);
  assert.equal(renderText('见 #Zn-I2 和 #a_b'), '见 #Zn-I2 和 #a_b');
});
ok('#标签 误伤防护', () => {
  const cases = [
    'C#include', 'a#b', 'https://x/#a', '# 不是标签', '#123',
    '#include <stdio.h>', '`#notag`',
  ];
  for (const s of cases) {
    const tags = findAll(render(s), (n) => n.t === 'span' && hasClass(n, 'dm-md-tag'));
    assert.equal(tags.length, 0, '不该当标签: ' + s);
  }
  assert.ok(renderText('#include <stdio.h>').includes('#include'));
});
ok('%%注释%% 不渲染', () => {
  assert.equal(renderText('a %%hidden%% b'), 'a  b');
  assert.equal(renderText('%%\nhidden\n%%\nvisible'), 'visible');
  assert.equal(renderText('%%hidden%%\nvisible'), 'visible');
  assert.equal(renderText('a %% b'), 'a %% b');
  assert.equal(renderText('50%% 完成'), '50%% 完成');
});

/* ================= [13] 图片加载失败 → 占位块 ================= */
console.log('\n[13] 图片加载失败 → 占位块');
ok('正常图片渲染 <img>（相对路径 / 外链 / data: 一样）', () => {
  const el = expand(render('![图 1](figures/Fig_Eads_16grid.png) ![x](https://a.com/b.png) ![y](data:image/png;base64,AAAA)'));
  const imgs = findAll(el, (n) => n.t === 'img');
  assert.equal(imgs.length, 3);
  assert.equal(imgs[0].p.src, 'figures/Fig_Eads_16grid.png');
  assert.equal(imgs[1].p.src, 'https://a.com/b.png');
  assert.equal(imgs[2].p.src, 'data:image/png;base64,AAAA');
  for (const img of imgs) {
    assert.equal(img.p.loading, 'lazy');
    assert.ok(hasClass(img, 'dm-md-img'));
    assert.equal(typeof img.p.onError, 'function', '应有 onError');
  }
});
ok('加载失败 → dm-md-img-missing 占位块（alt 显示、原始路径进 title）', () => {
  const md = createMarkdown(makeHookReact());
  const el = md.Markdown({ source: '![图 1　四种宿主上四种碘物种的吸附能（16 格矩阵）。](figures/Fig_Eads_16grid.png)' });
  const comp = el.c[0].c[0]; /* p > MarkdownImage */
  assert.equal(typeof comp.t, 'function');
  const img = comp.t(comp.p);
  assert.equal(img.t, 'img');
  img.p.onError(); /* 模拟 404 */
  const box = comp.t(comp.p);
  assert.equal(box.t, 'span');
  assert.ok(hasClass(box, 'dm-md-img-missing'));
  assert.equal(box.p.title, '原始路径：figures/Fig_Eads_16grid.png');
  const icon = findAll(box, (n) => n.t === 'span' && hasClass(n, 'dm-md-img-missing__icon'))[0];
  const name = findAll(box, (n) => n.t === 'span' && hasClass(n, 'dm-md-img-missing__name'))[0];
  const hint = findAll(box, (n) => n.t === 'span' && hasClass(n, 'dm-md-img-missing__hint'))[0];
  assert.equal(text(icon), '🖼');
  assert.equal(text(name), '图 1　四种宿主上四种碘物种的吸附能（16 格矩阵）。', '有 alt 时显示 alt');
  assert.equal(text(hint), '图片未随文档导入');
  assert.equal(findAll(box, (n) => n.t === 'img').length, 0, '失败后不再有 <img>');
});
ok('占位块：无 alt 时显示文件名（去目录 / 查询串 / %20）', () => {
  const md = createMarkdown(makeHookReact());
  const el = md.Markdown({ source: '![](figures/sub/Fig%20A.png?v=2#x)' });
  const comp = el.c[0].c[0];
  comp.t(comp.p).p.onError();
  const box = comp.t(comp.p);
  const name = findAll(box, (n) => n.t === 'span' && hasClass(n, 'dm-md-img-missing__name'))[0];
  assert.equal(text(name), 'Fig A.png');
});
ok('外链图片失败也走同一占位', () => {
  const md = createMarkdown(makeHookReact());
  const el = md.Markdown({ source: '![外链](https://example.com/a.png)' });
  const comp = el.c[0].c[0];
  comp.t(comp.p).p.onError();
  const box = comp.t(comp.p);
  assert.ok(hasClass(box, 'dm-md-img-missing'));
  assert.equal(box.p.title, '原始路径：https://example.com/a.png');
});
ok('图片组件 key 带 src（换图会重建、失败状态不复用）', () => {
  const el = render('![a](a.png)');
  const comp = el.c[0].c[0];
  assert.ok(String(comp.p.key).includes('a.png'), 'key 应包含 src: ' + comp.p.key);
});

/* ================= [14] 数学公式降级 ================= */
console.log('\n[14] 数学公式降级（$...$ / $$...$$）');
ok('行内 $...$ → span.dm-md-math + data-tex（去掉 $）', () => {
  const el = render('欧姆定律 $U=IR$ 成立，角度 $120^\\circ$。');
  const spans = findAll(el, (n) => n.t === 'span' && hasClass(n, 'dm-md-math'));
  assert.equal(spans.length, 2);
  assert.equal(spans[0].p['data-tex'], 'U=IR');
  assert.equal(text(spans[0]), 'U=IR');
  assert.equal(spans[1].p['data-tex'], '120^\\circ');
  assert.deepEqual(parseMarkdown('$U=IR$')[0].children[0],
    { type: 'math', tex: 'U=IR', display: false });
  assert.equal(renderText('欧姆定律 $U=IR$ 成立'), '欧姆定律 U=IR 成立');
  assert.ok(!renderText('欧姆定律 $U=IR$ 成立').includes('$'));
});
ok('块级 $$...$$ → div.dm-md-math-block（单行 / 跨行）', () => {
  const one = parseMarkdown('$$\\sum_i E_i$$');
  assert.equal(one[0].type, 'mathBlock');
  assert.equal(one[0].tex, '\\sum_i E_i');
  const el = render('$$\\sum_i E_i$$');
  assert.equal(el.c[0].t, 'div');
  assert.ok(hasClass(el.c[0], 'dm-md-math-block'));
  assert.equal(el.c[0].p['data-tex'], '\\sum_i E_i');
  assert.equal(text(el.c[0]), '\\sum_i E_i');

  const multi = parseMarkdown('$$\n\\sum_i E_i\n$$');
  assert.equal(multi[0].type, 'mathBlock');
  assert.equal(multi[0].tex, '\\sum_i E_i');
  const el2 = render('$$\n\\sum_i E_i\n$$');
  assert.ok(hasClass(el2.c[0], 'dm-md-math-block'));
  assert.equal(el2.c[0].p['data-tex'], '\\sum_i E_i');
});
ok('块级公式打断段落 + 行内 $$..$$ 降级 display', () => {
  const ast = parseMarkdown('正文\n$$\nx^2\n$$\n后续');
  assert.deepEqual(ast.map((b) => b.type), ['paragraph', 'mathBlock', 'paragraph']);
  const el = render('前面 $$x^2$$ 后面');
  const spans = findAll(el, (n) => n.t === 'span' && hasClass(n, 'dm-md-math'));
  assert.equal(spans.length, 1);
  assert.ok(hasClass(spans[0], 'dm-md-math--display'));
  assert.equal(spans[0].p['data-tex'], 'x^2');
});
ok('公式误伤防护', () => {
  const cases = [
    ['$ 5 块钱', '钱（$ 后空格）'],
    ['价格 $5 和 $10 元', '未闭合 / 收尾空白'],
    ['`$x$`', '行内码'],
    ['\\$5', '转义'],
    ['a$b$c', '前面是字母'],
    ['https://a.com/$p$', 'URL'],
    ['$', '单个 $'],
    ['$$', '未闭合 $$'],
    ['$x', '未闭合 $'],
  ];
  for (const [s, why] of cases) {
    const el = render(s);
    const found = findAll(el, (n) =>
      (n.t === 'span' && hasClass(n, 'dm-md-math')) ||
      (n.t === 'div' && hasClass(n, 'dm-md-math-block')));
    assert.equal(found.length, 0, '不该当公式（' + why + '）: ' + s);
  }
  assert.equal(renderText('`$x$`'), '$x$');
  assert.equal(renderText('\\$5'), '$5');
  assert.equal(renderText('$ 5 块钱'), '$ 5 块钱');
});
ok('表格 cell 里的公式', () => {
  const ast = parseMarkdown('| 公式 | 说明 |\n|---|---|\n| $U=IR$ | 欧姆 |');
  assert.equal(ast[0].type, 'table');
  assert.equal(text(ast[0].rows[0][0]), 'U=IR');
  const el = render('| 公式 |\n|---|\n| $U=IR$ |');
  assert.equal(findAll(el, (n) => n.t === 'span' && hasClass(n, 'dm-md-math')).length, 1);
});

/* ================= 汇总 ================= */
console.log('\n全部通过：' + passed + ' 组断言。');
