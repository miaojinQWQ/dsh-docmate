# DocMate 伴读 — 贡献者须知

> 新协作者（人或 agent）读完它就能改代码、跑测试、在真实页面里验收，并且知道哪些事已经做过了别重做。

---

## 0. 一句话

本仓库是一个 **DSH Cordis 插件**（bundle 形态），在 Harness Web UI 里开出一个「沉浸式研究区」：
左栏放文档 + 划线 + 研究记忆，中间读文档（md / docx / pdf），右栏是**每篇文档一条**的伴随 AI 会话，
可以划词提问、划线留痕、让 AI 把结论沉淀进记忆。

## 1. 目录与两半

```
docmate\
  package.json          # dsh.bundle.patch + dsh.client(platform:web, immediately:true)
  cordis.patch.yml      # 往宿主组合里插一行 id: docmate
  index.js              # ★ Host 半（Node/ESM）：存储 + 路由 + 会话 + 全文注入 + 3 个模型工具
  client.js             # 构建产物（不要手改）
  build.mjs             # 把 src/client/NN-*.js 按文件名顺序拼成一个 __ModuleLoader__ 工厂
  src/client/NN-*.js    # ★ Client 半：纯脚本片段，见下面的硬约束
  src/host/docx.js      # docx → HTML（零依赖）
  assets/pdfjs/         # pdf.js 3.11.174 + 168 个 cMap
  assets/katex/         # katex.min.js（公式运行时；样式/字体复用宿主前端）
  test/host.test.mjs    # 89 项
  test/client.test.mjs  # 26 项
  src/host/docx.test.mjs            # 59 项
  src/client/30-markdown.test.mjs   # 81 组
  src/client/58-find.test.mjs       # 44 组
  src/client/48-shot.test.mjs       # 35 组
  src/client/12-panes.test.mjs      # 48 组
  docs/                 # 验收样本（md/docx/pdf/txt + 生成脚本）
  shots/                # 验证截图
```

Client 片段一览（**文件名前缀就是拼接顺序**）：

| 文件 | 职责 |
|---|---|
| `00-head.js` | 常量：`PANEL_ID` / `API` / `LS_*` |
| `10-util.js` | `h` / `cx` / `api` / `Icon`（图标名表）/ `makeBoundary` / `lsGet` / `lsSet` |
| `12-panes.js` | 三栏宽度拖拽：`resolveSizes` 纯函数 + `PaneHandle` 分隔条 + 键盘/双击复位 |
| `20-css.js` | 总样式。**只用 `--dsw-alias-*` 与 `--dm-*` 变量**，不写死颜色 |
| `30-markdown.js` | Markdown → React 元素（含 Obsidian 方言） |
| `40-pdf.js` | pdf.js 阅读器 + `extractText` |
| `45-math.js` | KaTeX：按需拉脚本 + 把 `[data-tex]` 排成公式 |
| `48-shot.js` | 框选截图引擎：PDF canvas / `<img>` 裁剪 + `foreignObject` 兜底 |
| `50-docs.js` | 阅读区 `DocBody`（按文档 id 取内容） |
| `52-highlights.js` | 划线引擎：锚点 / CSS Highlight 绘制 / 跳转 |
| `55-workspace.js` | 左栏：文档列表 / 研究记忆 / 拖拽层 |
| `56-highlights-ui.js` | 左栏：划线列表 |
| `58-find.js` | 文档内搜索：跨节点匹配 / 绘制 / 浮条组件 |
| `60-chat.js` | 右栏：嵌宿主会话 + 空白会话起手牌 |
| `70-app.js` | ★ 三栏面板：拖拽上传 / 选区桥 / 划线 / 对照 / 目录 / 阅读位置 / 搜索接线 / 导出 |
| `99-tail.js` | `createPlugin`：注入样式 + 注册两个槽位 |

## 2. 硬约束（踩了就白干）

1. **片段里没有 import / export / JSX / 顶层 await**。每个文件是普通脚本，被拼进一个 factory 函数体；
   只能通过 `createXxx(React, util)` 的工厂参数拿东西。文件末尾照抄：
   `if (typeof module !== 'undefined' && module.exports) module.exports = { createXxx };`
2. **CSS 写在模板字符串里**：注释和内容里**不能出现反引号**（`` ` ``），否则整个 bundle 语法错。
   这是最容易踩的坑，`node build.mjs --check` 会立刻报出来。
3. **颜色只用变量**。宿主的 `--dsw-alias-brand-primary` **在深色模式下是近白色 `#f9fafb`**，
   所以「实心强调色底上的文字」必须用 `var(--dm-on-accent)`（= 页面底色），写死 `#fff` 会让文字消失。
   改完**深色和浅色两种模式都要看**。
4. **不要碰** 用户的个人笔记目录（只读，别碰）。
   插件自己的数据只在 `<DSH_HOME>/docmate/`。
5. **不要动** `docs/` 里的样本和用户的文档数据（`<DSH_HOME>/docmate/docs/`）。
6. 不引入新依赖；要 vendor 的东西放 `assets/`，通过 `/api/docmate/asset/*` 提供。
7. 改完必须：`node build.mjs --check` + 全部 7 套测试全绿。

### 2.1 安全不变量（改 `index.js` 时别破坏）

这几条是发布前审计封住的，都有对应的测试，别为了图省事绕过去：

- **每个路由都过 `admit()`，且 fail-closed**：拿不到 `connection` 就返回 403，不是放行。
  这组路由能删文档、能往会话里发消息，没鉴权等于任意网页可以 CSRF。
- **用户上传的字节永远不能按 `text/html` 回出去**。`/doc/raw` 只对 pdf / png / jpg / gif / webp
  内联，其余一律 `text/plain` + `nosniff` + `Content-Disposition: attachment`。
- **请求体边读边数**（`nodeToRequest`）：先 `Buffer.concat` 再查大小的话，一个几 GB 的 POST
  就能把宿主进程 OOM 掉。
- **任何拼进文件路径的 id 都要先过 `/^[\w-]+$/`**，再用 `path.relative` 确认落在目标目录内
  （`removeDoc` 就是这么防路径穿越的）。
- **`index.json` 读坏了要回退 `.bak`**，不能直接 500——否则面板连文档列表都打不开。
- **`memory.md` 的所有写入走 `withMemoryLock`**：自动流水是「读-改-写」，和面板手存并发会互相覆盖。

## 3. 开发循环

```powershell
cd docmate
node build.mjs --check          # 拼 bundle + node --check
node test\host.test.mjs         # 89
node test\client.test.mjs       # 26
node src\host\docx.test.mjs     # 59
node src\client\30-markdown.test.mjs   # 81 组
node src\client\58-find.test.mjs       # 44 组
node src\client\48-shot.test.mjs       # 35 组
node src\client\12-panes.test.mjs      # 48 组
```

**让运行中的 Harness 加载新代码**（两步，缺一不可）：

1. 用 `plugin_manager` 工具把插件关再开：
   `set_plugin { target: "include:docmate", enabled: false }` → 再 `enabled: true`。
   （host 半和 client 半都会重新 apply）
2. 在浏览器里 **Ctrl+R 刷新页面**（client bundle 的 URL 带 rev，但缓存有时不认，用 `ignoreCache` 重载最稳）。

> 用户自己开的桌面端窗口也需要他手动刷新一次；改完记得告诉他。

## 4. 在真实页面里验证

MCP 浏览器工具（`mcp__browser__*`）已装好，连的是 `http://127.0.0.1:9222` 的调试 Chrome。
**但 Chrome 没开的时候要先起一个**：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
    --remote-debugging-port=9222 --user-data-dir="$env:TEMP\dsh-chrome" about:blank
```

**登录 URL 怎么拿**（token 是「进程级」的，宿主一重启就变，所以别指望记住它）：

1. 在 `index.js` 的 `webServer.register(...)` handler 最前面临时插一段（**验证完必须删掉**）：

```js
if (req.url && req.url.split('?')[0] === API_PREFIX + '/_link') {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ url: connection.authenticatedUrl('http://127.0.0.1:' + webServer.port + '/') }));
  return;
}
```

2. 关/开插件（同上一节），然后 `Invoke-WebRequest http://127.0.0.1:<端口>/api/docmate/_link` 拿 URL。
3. 端口从「当前 DSH Web GUI URL」里读（每次启动可能不同）。
4. 用完删掉这段代码、再关/开一次插件。

**常用页面操作**（都是 `mcp__browser__evaluate_script`）：

```js
// 打开面板（侧栏入口叫「伴读」；窗口窄时侧栏会收成图标，先把窗口拉到 1440 宽）
[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '伴读').click()
// 关掉鲸鱼挂件的「余额预警」弹窗（会挡住截图）
[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '知道了')?.click()
// 量布局：确认没有被裁掉的元素
const r = document.querySelector('.dm-root');
[...r.querySelectorAll('*')].filter(el => el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible')
```

**深色 / 浅色都要看**：`mcp__browser__emulate { colorScheme: "light" }` → 刷新 → 看完再切回 `dark`。

## 5. 已经做完的（别重做）

- 三栏布局 + 拖拽上传 + 自动折叠侧栏（面板宽 < 1000px 时收起研究区）
- Markdown / docx / pdf 三种阅读面；Obsidian 方言（frontmatter / callout / wikilink / embed / `==mark==` / `#tag` / `%%注释%%`）
- 划线：字符偏移锚点 + CSS Custom Highlight API + 列表跳转 + 备注 + 「就这条问 AI」
- 每篇文档一条宿主会话（`sessionController.create` + 按文档名 `rename`）；全文/记忆/划线注入
- 三个模型工具：`docmate_read` / `docmate_memory` / `docmate_highlights`（只在研究区会话里可见）
- 记忆三层：注入 / 每轮自动流水 / 主动沉淀；左栏可手改
- 复习排期（`schedule` 服务）、并排对照两篇
- **KaTeX 公式排版**（`45-math.js`，473 个公式实测）
- **文档目录**（顶栏列表图标 → 浮层，67 节实测；支持 PDF 大纲、嵌套章节与页码跳转，深浅色实测）
- **文档内搜索**（`Ctrl/Cmd+F`，跨节点 + KaTeX 去重）
- **阅读位置记忆**（`docmate.pos.<id>`）
- **空白会话起手牌**（三张牌，问过就收起）
- **导出笔记**（⋯ 菜单 → 研究记忆 + 划线存成 md）
- **框选截图问 AI**（`48-shot.js` + 顶栏裁剪图标）：扫描件 / 图片没有文字层时，拖一个框 → 解释 / 提取文字 / 追问，
  截图存 `docs/<id>/shots/` 并随消息发给识图模型
- **PDF 目录**（`40-pdf.js` 的 `getOutline` → 复用顶栏目录浮层）
- **三栏宽度可拖拽**（`12-panes.js`）：两个分隔条、宽度持久化（合并进 `docmate.panes`）、
  双击/Enter 复位、方向键 ±16px、Home/End 到极值、拖动时全屏 overlay 挡 PDF canvas
- **快速识图的刹车**（`index.js` 的 `registerVisionGuard`）：见 §6.5——这是唯一一处
  用宿主 waterfall 做的运行时硬限制，改之前先把那节读完- 深色/浅色双模式对比度修复（`--dm-on-accent`）
- 布局修复：研究记忆面板被裁、右栏被 max-content 撑出可视区、表单控件 `content-box` 溢出
- PDF.js 异版本共存：宿主已有其它版本时，DocMate 使用自己的库且不覆盖宿主全局变量

## 6. 待办（按性价比排序，自己挑，别一次全做）

### P1 · 划线列表的「复习模式」
左栏「划线」现在只是列表。加一个「开始复习」按钮：逐条显示划线原文 → 你心里答 → 点开看 AI 之前怎么说 / 或让 AI 出题。
验收：能一条条过完，进度可见，随时退出。

### P1 · 框选截图的后续：存成「图片划线」
现在框选完的图只存到 `docs/<id>/shots/`，聊天里能看到，但左栏列表里没有。
可以把截图也记成一条 highlight（`kind: 'shot'`，带 `shotPath`），这样：
- 左栏能翻回「我当时框过这张图」；
- 复习模式能把图片和文字划线一起过；
- 导出笔记时把截图路径一起写进 md。
验收：框选 → 左栏出现一条带缩略图的记录 → 点它能滚回原位并重新显示那张图。

### P1 · 刹车提示条的持久化
刹车触发后，`60-chat.js` 只在 `busy` 下降沿开始轮询 90 秒，面板一卸载提示就没了。
可以把最近一次 trip 记进 `localStorage`（或让 `/guard?session=` 在面板挂载时先查一次），
重开面板还能看到「上一轮为什么停了」。

### P2 · 记忆面板从「一个 textarea」升级
现在是裸 textarea。可以按行渲染成条目（`- [时间] …` 是一行），支持单条删除 / 置顶 / 折叠；
自动流水行和手写行视觉上区分开。
验收：研究记忆里有 10 条时仍然好用，不破坏「保存」语义。

### P2 · 长文档的公式懒渲染
27k 字 + 473 个公式会在打开时一次性排完（实测可接受，但更长会更慢）。
用 `IntersectionObserver` 只排视口附近的，滚动到再排。
验收：首屏时间下降，滚动不出现空白公式。

### P2 · 窄面板（< 900px）的可用性
现在研究区会自动收起，但顶栏按钮会挤。检查 900×700 / 800×600：
顶栏是否换行、正文行宽、目录浮层是否超出。
验收：两种尺寸截图，无重叠、无裁切、无横向滚动。

### P3 · 无障碍与键盘
- 所有可点元素有可见 focus ring（部分已有 `:focus-visible`）
- 划线列表 / 目录支持上下键选择 + Enter 跳转
- `aria-live` 播报「已保存 / 已导出」这类提示
验收：只用键盘能完成「打开文档 → 搜索 → 跳到命中 → 划线」。

### P3 · 文案与 i18n
`locale/en.json` 现在只有插件名。面板本身是中文硬编码。
要么补一套英文（工作量不小，要抽词条），要么明确「只做中文」并在 README 写清楚。

### 别做的
- 知识树 / 知识库 / 从文件夹批量导入（用户明确说过不要，只要「把想深读的文档拉进面板」）
- 多文档共用一个会话（用户明确要「每篇文档一条」）
- 鲸鱼挂件的遮挡（用户说他自己决定，不用管）

## 6.5 快速识图刹车的硬限制（改之前必读）

`index.js` 的 `registerVisionGuard` 用宿主真实 waterfall 给「带图片的那一轮」装了四道闸。
作用域全部靠**这一轮的 `AbortSignal`**（宿主每个 turn 新建一个，同 turn 内所有 step 共用），
`WeakMap<AbortSignal, 状态>` 就是精确到轮次的；认不出轮次一律放行。

| 闸 | 宿主接口 | 性质 |
|---|---|---|
| 认出轮次 | `agent/pre-step` 的 `messages[i].source.rpcId` 对 `visionPending` | 硬（`prompt({requestId})` 写进去的） |
| 限步 / 限预算 | `agent/pre-step` 返回 `{ kind:'reject' }` | 硬：turn 以 `blocked` 结束，不会自动续跑 |
| 单步输出上限 | `agent/request` 返回 `{ ...config, maxTokens }` | 硬（返回新对象，seed 是 deepFreeze 的） |
| 拒工具 | `tools/pre-execute` 返回 `{ kind:'deny', reason }` | 硬：工具**不执行**，只回一条 error result |
| 超时取消 | `agent.cancel({kind:'hook',reason},{keepInbox:true})` | 硬：abort 真实 turn，保留其它排队消息 |

**做不到的（宿主上游限制，别浪费时间试）**：
- **没法让这一轮的请求里没有工具**。`system-prompt/assemble` 的入参是 `PromptPresentation`
  （sections/contexts/variables），**没有 `tools`**；官方契约原话 "tool declarations remain
  provider-owned"。`SystemPrompt.tools(provider)` 只能追加；`tools.register(def,{when})` 的
  `when` 是 agent 级不是 turn 级。所以工具 schema（这个 profile 50+ 工具，约 20K token）
  缩不掉，模型看得见工具、仍可能先试一次。
- **没法只给一轮降 reasoning effort**。`agent/request` 里设的 `reasoningEffort` 会被
  `dsh-agent` 的 `installModelSelection` 监听无条件剥掉（它 `{reasoningEffort: _inherited, ...rest}`）。
  所以只能用 `maxTokens` 兜。

**实测曲线（同一张扫描件，`docs/扫描件-电路例题.pdf`）**：

| 配置 | 结果 |
|---|---|
| 修之前 | 16 步 / 882K token / 4 分钟，模型去画图建文件 |
| maxTokens 1000 | 1 步，模型把预算全花在思考上，**正文为空** |
| maxTokens 2500 | 同上 |
| maxTokens 4000 | 2 步（1 次工具被拒），正文写到第五节被截断 |
| maxTokens 8000 | 2 步 / 2 次模型调用 / 1 次工具被拒且未执行 / 30 秒 / 答案完整但**是一屏长文** |

**加了「回答风格」注入（`CONTEXT_VERSION = 2`）之后**：正文从 ~5000 token 的讲义压到 ~180 字，
`maxTokens` 也降回 4000（够思考 + 三句正文）。实测 2 步 / 25.5 秒 / fresh 31.9K / billed 78.5K。
改 `contextMessage` 一定要 +1 `CONTEXT_VERSION`，否则老文档的会话里还是旧指令。

口径说明：`usage.fresh`（未缓存输入 + 输出）= 预算闸用，实测 31.9K；
`usage.billed`（再加缓存读/写）= 面板显示用，实测 78.5K（缓存命中 62%）。
**30K 是「新增 token」的预算，不是计费总额**——第一次请求光工具 schema 就 24K，
按 billed 卡 30K 等于第一步就断路。要真把 billed 压下来，只能等宿主开放「按轮次过滤工具目录」。

## 7. 多人 / 多 agent 并行时的规矩

多个协作者共享同一个工作目录和同一个运行中的 Harness，**会互相踩**。所以：

1. **先认领文件**。一个任务只改自己那一两个文件；`70-app.js`（1600 行）是最容易冲突的，
   同一时间只让一个人改它。
2. **`client.js` 是共享产物**。谁改完谁 `node build.mjs --check`；发现别人正在改就先等等，
   别在对方改到一半时 build（会拼出半成品，虽然 `--check` 能挡住语法错）。
3. **插件开关 / 页面刷新也是共享的**。一个人正在页面上验证时，另一个人关插件会让他的页面崩掉。
   验证前在共享任务板上写一句「我要用页面 5 分钟」。
4. **浏览器只有一个**（9222 那个 Chrome）。两个 agent 同时操作会抢焦点、抢页面。
   非视觉任务（host 路由 / 纯函数 / 单测 / 文档）不需要浏览器，优先派给不占页面的人。
5. 建议分工：一个人做 **视觉/交互**（要浏览器），一个人做 **逻辑/测试/文档**（不用浏览器）。
