# 发布清单（npm + GitHub + 插件市场）

这份文件是**给你自己看的**，不进 npm 包（`files` 里没有它）。
三件事都做完，插件才会出现在 [dsh-market](https://github.com/dsh-market/dsh-market) 的 Discover 里。

代码这边已经准备好了：`package.json` 的 `name` / `version` / `license` / `engines` / `files` /
`prepublishOnly` 都填好了，`npm pack` 出来是 **1.58 MB / 203 个文件**，`npm install <tgz>` 能装、
`import('dsh-docmate')` 能加载。

---

## 0. 仓库地址（已填好）

`package.json` 里的三处已经指向 `miaojinQWQ`：

```json
"homepage": "https://github.com/miaojinQWQ/dsh-docmate#readme",
"repository": { "url": "git+https://github.com/miaojinQWQ/dsh-docmate.git" },
"bugs": { "url": "https://github.com/miaojinQWQ/dsh-docmate/issues" }
```

`scripts/prepublish.mjs` 会挡住「还是占位地址」的发布，所以 `npm publish` 之前先跑一次：

```powershell
cd docmate
npm run prepublishOnly     # 应该输出「✓ 发布前检查通过」
```

## 1. 建 GitHub 仓库并推上去

```powershell
cd docmate
gh repo create dsh-docmate --public --source=. --remote=origin --push
# 没有 gh 的话：
#   git remote add origin https://github.com/miaojinQWQ/dsh-docmate.git
#   git push -u origin main
```

推完在仓库 **Settings → Topics** 里加 `dsh-plugin`（市场收录会看这个 topic）。

## 2. 发 npm

> **国内网络提示**：`www.npmjs.com`（网页）经常被挡，但 `registry.npmjs.org`（真正发包的服务器）
> 通常是通的——先 `npm ping` 确认。网页打不开**不影响发布**，只要用**纯命令行登录**：
>
> ```powershell
> npm login --auth-type=legacy
> ```
>
> 它会在终端里依次问 Username / Password / OTP，全程不碰网页。
> 如果账号开了两步验证而发布时又要求 OTP，就在终端里自己跑一次 `npm publish`。

```powershell
npm login          # 交互终端里做；网页打不开就用上面的 legacy 方式
npm publish        # prepublishOnly 会先跑一遍检查
```

包名 `dsh-docmate` 目前**没有被占用**（已确认 npm 返回 404），可以直接用。
`publishConfig.access` 已经是 `public`。

发完验证：

```powershell
npm view dsh-docmate version
```

> **没有 npm 账号也能发布成功**：市场收录不依赖 npm，插件从 GitHub 装照样能用
> （`dsh plugin --profile <p> add github:miaojinQWQ/dsh-docmate`，已实测 7.7 秒装好）。
> npm 只是让市场卡片多一个下载量数字。

## 3. 提交到插件市场（关键的一步）

市场的目录**不在** dsh-market 那个仓库里，而在
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
流程是「一个插件 = 一个 YAML 文件」的 PR。

### 3.1 新建 `data/plugins/miaojinQWQ__dsh-docmate.yml`

```yaml
url: https://github.com/miaojinQWQ/dsh-docmate
name: miaojinQWQ/dsh-docmate
category: docs
description:
  en: 'Immersive reading desk for DeepSeek Harness: drop a md/docx/pdf into the centre pane and a companion AI on the right has already read the whole document. Select any sentence to ask, drag a box over a scanned page to let it look, keep highlights and a per-document research memory that survives restarts. KaTeX math, outline, in-document search, draggable panes, and a hard runtime brake on image questions.'
  zh: '沉浸式研究区：把 md/docx/pdf 拖进中间面板，右侧的伴随 AI 已经通读过全文。划词即问、扫描件框选一块让它看图、划线可跳回、每篇文档一份研究记忆且重启后仍在。另有 KaTeX 公式、目录、文档内搜索、三栏可拖拽，以及给识图提问装的运行时刹车。'
```

`category` 可选值见市场索引的 `metadata.categories`，`docs`（Docs & Rendering）最贴切；
如果更想强调「学习/伴随」，也可以选 `tools`。

### 3.2 PR 描述（照抄 `pr-body.md` 那份模板的格式）

```markdown
- [x] I added **one file** at `data/plugins/miaojinQWQ__dsh-docmate.yml` — that single file is the whole submission.
- [x] My repo's `package.json` declares **`dsh.bundle`** (`dsh.bundle.patch: ./cordis.patch.yml`, plus `dsh.client` for the browser half).
- [x] My repo is at least **1 day old** — created <日期>.
- [x] `category: docs` — it is a document reader with a companion AI.
- [x] Description states what the plugin does, no superlatives.
- [x] My repo has the `dsh-plugin` topic.

DocMate turns the Harness centre pane into an immersive reading desk: md / docx / pdf render in the
middle, and the right-hand column is one ordinary Harness session per document that has already been
fed the whole text, the research memory and the existing highlights. Selecting a sentence sends it with
its source; scanned PDFs and images have no text layer, so a marquee drag captures that region and sends
it to a vision model instead — under a turn-scoped runtime brake (max 2 steps, output cap, every tool call
denied before dispatch, 45 s cancel) that took the same question from 16 steps / 882K tokens down to
2 steps / 25 s. Highlights are anchored as character offsets and painted with the CSS Custom Highlight API,
so they survive reloads and window resizes. Zero runtime dependencies; pdf.js and KaTeX are vendored under
`assets/`.
```

### 3.3 提 PR

```powershell
# fork + clone 那个仓库，加一个文件，提 PR
```

市场 CI 会检查：仓库 ≥ 1 天、`dsh.bundle` 存在、`dsh-plugin` topic、描述没有夸张词。
通过后一般一天内出现在市场卡片里，`dsh-market` 和 `plugin_market` 工具都会搜到。

---

## 发布之后

- 改版本号 → `npm publish` → 市场卡片会自动显示新版本（它读 npm）。
- 想撤回：`npm unpublish dsh-docmate@<version>`（72 小时内），市场条目需要单独提 PR 删。
- 中文 README 是主文档；市场卡片的中英文描述来自上面那个 YAML，改描述要重新提 PR。
