# DocMate 插件 —— 模块契约（所有协作者必读）

DSH Web 插件：左栏入口「伴读」→ 中央三栏工作台（左：文档树 / 中：文档阅读区 / 右：AI 伴随聊天）。
本文件是**唯一**的接口契约。你只写自己被分配的**一个文件**，不要改别人的文件、不要改
`package.json`、`cordis.patch.yml`、`build.mjs`、`index.js`。

## 0. 环境事实（已核实，别再自己猜）

- 工作目录：本仓库根目录
- 插件包名：`dsh-docmate`（本地 bundle，用 `plugin_manager install_bundle` 安装）
- 浏览器端模块表只有：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
  `@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、
  `dsh-client-ui-dockkit`。**只允许 `require('react')`**，不许 require 任何 Harness 客户端包。
- 没有 JSX 编译。一律 `React.createElement`（下文用 `h` 别名）。
- 客户端插件是**普通 JS 片段**，由 `build.mjs` 按文件名排序拼接进一个 `factory(require){}` 闭包里。
  因此每个模块文件必须是「一个或多个函数声明 + 末尾一个 node 导出守卫」，**不许**出现顶层
  `import` / `export` / 顶层 `await` / 依赖其它片段里的变量（只依赖 `React` 参数）。
- 样式：宿主主题 token 一律用 `--dsw-alias-*`（见附录 A）。**不要**写死亮/暗色文字与背景，
  只有纯装饰（图标、代码块语法色）可以写死。CSS 由 Lead 统一注入，你只写 class 名，
  class 前缀按你的模块：markdown 用 `dm-md-*`，pdf 用 `dm-pdf-*`，docx 输出用 `dm-docx-*`。
- 验证方式：`node --check <你的文件>` 必须过；能写纯函数测试的写一个小 node 测试跑通。
  **不要**启动浏览器截图、不要装包、不要访问网络。

## 1. 文件模板（每个客户端模块都长这样）

```js
/* ===== 30-markdown.js ===== */
function createMarkdown(React) {
  const h = React.createElement;
  // ... 全部实现放这里 ...
  return { Markdown };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { createMarkdown };
```

`build.mjs` 会把所有 `src/client/NN-*.js` 依序拼进：

```js
window.__ModuleLoader__.load({
  id: 'dsh-docmate',
  factory(require) {
    const React = require('react');
    /* ...拼进来的片段... */
    return createPlugin(React, require);
  },
});
```

所以片段里**不能**有 `return` 出现在顶层（只能在函数内）。

## 2. Host 半提供的 HTTP 路由（客户端直接用 `fetch` 调，同源）

所有路由都在 `/api/docmate` 下；失败一律 `{ ok:false, error:{ code, message } }` + 非 2xx。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/docmate/tree?dir=<相对路径>` | `{ ok:true, root, dir, entries:[{path,name,kind:'dir'\|'file',ext,size,mtime}] }` |
| GET | `/api/docmate/raw?path=<相对路径>` | 文件原始字节（`Content-Type` 按扩展名） |
| GET | `/api/docmate/docx?path=<相对路径>` | `{ ok:true, html, title, warnings:[] }` |
| GET | `/api/docmate/asset/<文件名>` | 插件 `assets/pdfjs/` 下的静态文件 |
| POST | `/api/docmate/session` | `{ ok:true, sessionId }`（建/复用伴随聊天会话） |
| POST | `/api/docmate/ask` | body `{ sessionId, text }` → `{ ok:true }`（把一条用户消息投给该会话并唤醒 agent） |

`path` 一律是**相对文档根目录**的 POSIX 风格路径（`a/b.md`），Host 会做越界校验。

## 3. 模块 A —— `src/client/30-markdown.js`（负责人：markdown）

```js
function createMarkdown(React) { ... return { Markdown, parseMarkdown }; }
```

- `Markdown` 组件：`h(Markdown, { source, className })`，把 Markdown 源串渲染成 React 元素树。
- `parseMarkdown(source)`：纯函数，返回块级 AST（数组），供测试与将来复用。
- 必须支持：ATX 标题 `#`~`######`、段落、`**粗**` `*斜*` `~~删~~` `` `行内码` ``、
  链接 `[t](u)`、图片 `![a](u)`、无序/有序列表（支持嵌套一层以上）、任务列表 `- [ ]`、
  引用 `>`、围栏代码块 ```lang、表格（GFM，含对齐）、分隔线 `---`、硬换行（行尾两空格）。
- 代码块：`<pre class="dm-md-pre"><code class="dm-md-code">`，**不要**做语法高亮（保持零依赖）。
- 表格：`<table class="dm-md-table">`，表头 `<thead>`。
- 图片：`<img class="dm-md-img" loading="lazy">`，src 原样（相对路径由调用方处理）。
- 安全：**绝不**用 `dangerouslySetInnerHTML`；一切走 React 元素。链接 `target="_blank" rel="noreferrer"`。
- 健壮性：任何畸形输入都不能抛异常（宁可降级成纯文本段落）。
- 不要处理数学公式（原样当文本）。

## 4. 模块 B —— `src/client/40-pdf.js`（负责人：pdf）

```js
function createPdfViewer(React) { ... return { PdfViewer }; }
```

- `PdfViewer` 组件：`h(PdfViewer, { url, onTextSelection, onError })`。
- 用 **pdf.js v3 UMD 全局版**：Lead 已把 `pdf.min.js` / `pdf.worker.min.js` 放在
  `/api/docmate/asset/` 下。加载方式：动态插 `<script src="/api/docmate/asset/pdf.min.js">`，
  等 `window.pdfjsLib` 出现；然后 `window.pdfjsLib.GlobalWorkerOptions.workerSrc =
  '/api/docmate/asset/pdf.worker.min.js'`。**同一页面只加载一次**（模块级 Promise 缓存）。
- 渲染：连续滚动，每页一个 `<div class="dm-pdf-page">`，内含 `<canvas>` 与
  绝对定位的文本层 `<div class="dm-pdf-text-layer">`（每段一个 `<span>`，`position:absolute`，
  `transform: scaleX(...)` 对齐宽度；文本层 `user-select: text`，canvas 在下层）。
- 文本层必须能**正常选中**（这是本插件「划线提问」的基础）：span 用 pdf.js
  `textContent.items` 的 `transform` 定位（`left/top` 用 viewport 换算，字号用 `item.height`），
  不要用 pdf.js 自带的 `TextLayer` 类（版本差异大），自己算。
- 交互：顶部工具条（上一页/下一页/页码/缩放 −/+/适应宽度），`dm-pdf-toolbar`。
- 选中文本时调用 `onTextSelection({ text, page })`（在容器上监听 `mouseup`/`selectionchange`，
  只处理落在本组件容器内的选区）。
- 失败：pdf.js 加载失败或解析失败 → 渲染 `<div class="dm-pdf-error">` 并把原因交给 `onError`；
  **绝不能**让异常冒泡到 slot（会让整个面板白屏）。
- 卸载时清理：取消渲染任务（`task.destroy()`）、移除 script 监听、断开 ResizeObserver。
- 性能：只渲染视口附近的页（简单做法：先渲染全部页的占位高度，再用 IntersectionObserver
  懒渲染；页数 > 200 时给出提示）。

## 5. 模块 C —— `src/host/docx.js`（负责人：docx）

```js
export function convertDocxToHtml(bytes /* Uint8Array */) -> { html, title, warnings }
```

- 纯 Node ESM（`import { inflateRawSync } from 'node:zlib'`），**零第三方依赖**。
- 自己解 ZIP：读 EOCD → 中央目录 → 本地头 → `inflateRawSync`（stored 条目直接拷）。
  需要 `word/document.xml`、`word/styles.xml`（可选）、`word/numbering.xml`（可选）、
  `word/media/*`（可选）、`docProps/core.xml`（可选，取 title）。
- 输出语义 HTML（class 前缀 `dm-docx-*`）：
  - `<h1>`~`<h6>`（按 `w:pStyle` 的 `Heading1`/`heading 1`/`标题 1` 等识别，兜底看 `w:outlineLvl`）
  - `<p>`，`<strong>`/`<em>`/`<u>`/`<s>`（`w:b`/`w:i`/`w:u`/`w:strike`）
  - 列表 `<ul>/<ol>/<li>`（`w:numPr` 的 `w:numId` + `w:ilvl`，编号类型查 numbering.xml）
  - 表格 `<table class="dm-docx-table"><tr><td>`（含 `w:gridSpan` 的 colspan）
  - 图片：`word/media/*` 内联成 `data:<mime>;base64,...` 的 `<img>`
  - 超链接 `<a>`（`w:hyperlink` 的 `r:id` → `word/_rels/document.xml.rels`）
  - 分页 `<hr class="dm-docx-pagebreak">`（`w:br w:type="page"`）
- 文本：`w:t` 拼文本，`w:tab` → `\t`，`w:br` → `<br>`；**保留** `xml:space="preserve"` 的空格。
- 必须做 XML 转义（`& < > "`），文本里绝不能漏出未转义的 `<`。
- 健壮性：任何缺失部件都降级（没有 styles.xml 就按默认样式；坏图片跳过并记 warning）。
  抛异常只允许在「不是 zip / 没有 document.xml」时，且错误信息可读。
- 附带一个 `node src/host/docx.test.mjs` 自测：用 python-docx 或手写最小 docx 造样本，
  断言 `<h1>`/`<strong>`/表格出现在输出里。

## 6. 附录 A —— 主题 token（只用这些）

```
--dsw-alias-bg-base, --dsw-alias-bg-layer-1, --dsw-alias-bg-layer-2,
--dsw-alias-bg-elevated, --dsw-alias-bg-hover, --dsw-alias-bg-active,
--dsw-alias-label-primary, --dsw-alias-label-secondary, --dsw-alias-label-tertiary,
--dsw-alias-border-l1, --dsw-alias-border-l2,
--dsw-alias-brand-primary, --dsw-alias-brand-primary-hover,
--dsw-alias-text-link, --dsw-alias-danger
```
（真实 token 名以 `cordis_inspect_query` 的 `Theme.listTokens` 为准；Lead 已核对过这一批可用。）

## 7. 附录 B —— 不要做的事

- 不要 `document.body.appendChild`、不要替换 app root、不要读别的插件的 DOM。
- 不要在工厂体里做副作用（注册样式/监听器要在 `apply` 里，用 `ctx.effect`）。
- 不要写 `import`/`export`（Host 半 `src/host/*.js` 除外）。
- 只改你被分配的那个文件，不要顺手改别的目录。
