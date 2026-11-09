/* ===== 20-css.js ===== */
/**
 * The whole stylesheet, injected once from `apply` through `ctx.effect` + `styles.insert`.
 *
 * Colour rules follow the plugin practices: containers, text and borders use the host's
 * `--dsw-alias-*` tokens so light/dark switching is free; only artwork (the selection
 * highlight, the accent glow) carries literal colour. Every token has a fallback so a
 * renamed token degrades the look instead of breaking the layout.
 */
function createCss() {
  return `
.dm-root {
  --dm-bg: var(--dsw-alias-bg-base, #ffffff);
  --dm-bg-1: var(--dsw-alias-bg-layer-1, #f7f8fa);
  --dm-bg-2: var(--dsw-alias-bg-layer-2, #f1f2f5);
  --dm-bg-hover: var(--dsw-alias-bg-hover, rgba(0, 0, 0, 0.045));
  --dm-bg-active: var(--dsw-alias-bg-active, rgba(0, 0, 0, 0.075));
  --dm-line: var(--dsw-alias-border-l1, #e6e8ee);
  --dm-line-2: var(--dsw-alias-border-l2, #d5d9e2);
  --dm-text: var(--dsw-alias-label-primary, #1b1f27);
  --dm-text-2: var(--dsw-alias-label-secondary, #4d5666);
  --dm-text-3: var(--dsw-alias-label-tertiary, #7a8394);
  --dm-accent: var(--dsw-alias-brand-primary, #247bbf);
  --dm-accent-soft: color-mix(in srgb, var(--dm-accent) 12%, transparent);
  /* 「实心强调色底上的文字」不能写死 #fff：深色模式下宿主的 brand-primary 是近白色
     (#f9fafb)，白字压白底 = 文字消失（保存 / 选择文件 两个按钮就是这么没的）。
     用页面底色当反色是稳的——accent 本来就要在 bg 上可读，反过来也成立。 */
  --dm-on-accent: var(--dm-bg);
  --dm-danger: var(--dsw-alias-danger, #d64545);
  --dm-radius: 10px;
  --dm-shadow: 0 8px 28px rgba(15, 23, 42, 0.14), 0 1px 3px rgba(15, 23, 42, 0.10);

  position: relative;
  display: flex;
  height: 100%;
  min-height: 320px;
  width: 100%;
  background: var(--dm-bg);
  color: var(--dm-text);
  font-size: 13px;
  line-height: 1.6;
  overflow: hidden;
}

/* ── generic bits ─────────────────────────────────────────────────────── */
/* 表单控件的宽度都写成 100%（或 flex 拉伸），content-box 下 padding + border 会额外
   撑出去，把输入框顶出容器——研究记忆的 textarea 就是这么被裁掉右边的。 */
.dm-root input,
.dm-root textarea,
.dm-root select {
  box-sizing: border-box;
}

.dm-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--dm-text-2);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.dm-btn:hover { background: var(--dm-bg-hover); color: var(--dm-text); }
.dm-btn:active { background: var(--dm-bg-active); }
.dm-btn[disabled] { opacity: 0.45; cursor: default; }
.dm-btn.is-off { color: var(--dm-text-3); opacity: 0.7; }
.dm-btn.is-off:hover { opacity: 1; }
.dm-btn--icon { width: 28px; padding: 0; }
.dm-btn--solid {
  background: var(--dm-accent);
  color: var(--dm-on-accent);
  border-color: transparent;
}
.dm-btn--solid:hover { background: var(--dsw-alias-brand-primary-hover, var(--dm-accent)); color: var(--dm-on-accent); filter: brightness(1.05); }
.dm-btn--ghost-line { border-color: var(--dm-line); }

.dm-sep { width: 1px; height: 18px; background: var(--dm-line); margin: 0 4px; flex: none; }
.dm-spacer { flex: 1 1 auto; min-width: 0; }

.dm-scroll { overflow: auto; overscroll-behavior: contain; }
.dm-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.dm-scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--dm-text-3) 32%, transparent);
  border-radius: 8px;
  border: 3px solid transparent;
  background-clip: content-box;
}
.dm-scroll::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--dm-text-3) 55%, transparent); background-clip: content-box; }
.dm-scroll::-webkit-scrollbar-track { background: transparent; }

/* ── left column: document tree ───────────────────────────────────────── */
/* 宽度由 70-app.js 的 inline style 给（12-panes.js 的 resolveSizes 算出来的），这里的
   flex-basis / min-width 只是没有 panes 模块时的兜底默认值。分隔线由分隔条自己画，
   所以这里不再写 border-right —— 否则会和分隔条的 1px 线叠成两条。 */
.dm-side {
  flex: 0 1 236px;
  min-width: 176px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--dm-bg-1);
}
.dm-side > * { min-height: 0; }
.dm-side__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 12px 8px;
}
.dm-side__title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dm-text-3);
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-search {
  position: relative;
  margin: 0 12px 8px;
}
.dm-search svg {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--dm-text-3);
  pointer-events: none;
}
.dm-search input {
  width: 100%;
  height: 30px;
  padding: 0 8px 0 28px;
  border: 1px solid var(--dm-line);
  border-radius: 8px;
  background: var(--dm-bg);
  color: var(--dm-text);
  font: inherit;
  outline: none;
}
.dm-search input:focus { border-color: var(--dm-accent); box-shadow: 0 0 0 2px var(--dm-accent-soft); }
.dm-search input::placeholder { color: var(--dm-text-3); }

.dm-root-path {
  margin: 0 12px 6px;
  padding: 6px 8px;
  border-radius: 7px;
  background: var(--dm-bg-2);
  color: var(--dm-text-3);
  font-size: 11px;
  line-height: 1.45;
  word-break: break-all;
  display: flex;
  gap: 6px;
  align-items: flex-start;
}
.dm-root-path b { color: var(--dm-text-2); font-weight: 500; }

.dm-tree { flex: 1 1 auto; min-height: 0; padding: 2px 6px 16px; }
.dm-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border-radius: 7px;
  color: var(--dm-text-2);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.dm-row:hover { background: var(--dm-bg-hover); color: var(--dm-text); }
.dm-row.is-active { background: var(--dm-accent-soft); color: var(--dm-accent); font-weight: 500; }
.dm-row__twist {
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  color: var(--dm-text-3);
  transition: transform 120ms ease;
}
.dm-row__twist.is-open { transform: rotate(90deg); }
.dm-row__name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dm-row__meta { flex: none; font-size: 11px; color: var(--dm-text-3); }
.dm-badge {
  flex: none;
  font-size: 10px;
  line-height: 15px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--dm-bg-2);
  color: var(--dm-text-3);
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.dm-badge--pdf { color: #b4453c; background: rgba(180, 69, 60, 0.12); }
.dm-badge--docx { color: #2b579a; background: rgba(43, 87, 154, 0.12); }
.dm-badge--md { color: #3b7a57; background: rgba(59, 122, 87, 0.12); }

.dm-empty {
  padding: 28px 18px;
  text-align: center;
  color: var(--dm-text-3);
  font-size: 12px;
  line-height: 1.7;
}
.dm-empty__title { color: var(--dm-text-2); font-size: 13px; margin-bottom: 6px; }

/* ── centre column ────────────────────────────────────────────────────── */
/* min-width 交给 12-panes.js 的 resolveSizes 管：它保证中间至少 380px，并且会在面板
   极窄时把两侧压到 0 —— 这里再写死一个 min-width 只会在那种时候把三栏顶出容器。 */
.dm-main {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--dm-bg);
}
.dm-topbar {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 4px;
  height: 44px;
  padding: 0 10px;
  border-bottom: 1px solid var(--dm-line);
  background: var(--dm-bg);
}
.dm-topbar__title {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: 1 1 auto;
  overflow: hidden;
}
.dm-topbar__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--dm-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.dm-topbar__path {
  flex: none;
  font-size: 11px;
  color: var(--dm-text-3);
  white-space: nowrap;
}
.dm-topbar .dm-btn { flex: none; }
.dm-btn.is-on { background: var(--dm-accent-soft); color: var(--dm-accent); }

/* ── floating document outline ────────────────────────────────────────── */
.dm-outline {
  position: absolute;
  top: 50px;
  left: 12px;
  z-index: 60;
  width: 238px;
  max-height: calc(100% - 74px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dm-line);
  border-radius: 10px;
  background: var(--dsw-alias-bg-elevated, var(--dm-bg));
  box-shadow: var(--dm-shadow);
  overflow: hidden;
  animation: dm-outline-in 120ms ease-out;
}
@keyframes dm-outline-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.dm-outline__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 6px 12px;
  border-bottom: 1px solid var(--dm-line);
}
.dm-outline__title { font-size: 12px; font-weight: 600; color: var(--dm-text-2); letter-spacing: 0.02em; }
.dm-outline__count { margin-left: auto; color: var(--dm-text-3); font-size: 11px; }
.dm-outline__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dm-text-3);
  cursor: pointer;
}
.dm-outline__close:hover { background: var(--dm-bg-hover); color: var(--dm-text); }
.dm-outline__list {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 5px 5px 8px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dm-outline__row {
  flex: none;
  display: flex;
  align-items: center;
  min-height: 26px;
  padding: 3px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dm-text-2);
  font: inherit;
  font-size: 12px;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
}
.dm-outline__row:hover { background: var(--dm-bg-hover); color: var(--dm-text); }
.dm-outline__row.is-active { background: var(--dm-accent-soft); color: var(--dm-accent); }
.dm-outline__text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* the overflow menu that keeps the bar on one row */
.dm-topbar__more { position: relative; flex: none; }
.dm-topbar__menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 65;
  min-width: 230px;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--dm-line);
  background: var(--dsw-alias-bg-elevated, var(--dm-bg));
  box-shadow: var(--dm-shadow);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dm-topbar__menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dm-text-2);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.dm-topbar__menu-item:hover { background: var(--dm-bg-hover); color: var(--dm-text); }
.dm-topbar__menu-item[disabled] { opacity: 0.45; cursor: default; }
.dm-topbar__menu-item svg { flex: none; color: var(--dm-text-3); }
.dm-doc {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}
.dm-doc__scroll { flex: 1 1 auto; min-height: 0; }
.dm-paper {
  max-width: 780px;
  margin: 0 auto;
  padding: 32px clamp(16px, 3.4vw, 56px) 96px;
}
.dm-plain {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--dm-text);
}
.dm-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: center;
  padding: 80px 0;
  color: var(--dm-text-3);
}
.dm-spinner {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 2px solid var(--dm-line-2);
  border-top-color: var(--dm-accent);
  animation: dm-spin 720ms linear infinite;
}
@keyframes dm-spin { to { transform: rotate(360deg); } }
.dm-error {
  margin: 40px auto;
  max-width: 560px;
  padding: 18px 20px;
  border: 1px solid color-mix(in srgb, var(--dm-danger) 35%, var(--dm-line));
  border-radius: var(--dm-radius);
  background: color-mix(in srgb, var(--dm-danger) 7%, transparent);
  color: var(--dm-text);
  line-height: 1.7;
}
.dm-error__title { font-weight: 600; color: var(--dm-danger); margin-bottom: 6px; }
.dm-error pre { margin: 8px 0 0; white-space: pre-wrap; font-size: 11.5px; color: var(--dm-text-2); }

/* ── reading typography (markdown + docx share it) ────────────────────── */
.dm-prose { color: var(--dm-text); font-size: 15px; line-height: 1.82; letter-spacing: 0.002em; overflow-wrap: break-word; }
.dm-prose > :first-child { margin-top: 0; }
.dm-prose p, .dm-prose li, .dm-prose blockquote { overflow-wrap: anywhere; }
.dm-prose h1, .dm-prose h2, .dm-prose h3, .dm-prose h4, .dm-prose h5, .dm-prose h6 {
  margin: 1.7em 0 0.6em;
  line-height: 1.35;
  font-weight: 650;
  color: var(--dm-text);
  scroll-margin-top: 16px;
}
.dm-prose h1 { font-size: 1.62em; margin-top: 0.2em; }
.dm-prose h2 { font-size: 1.32em; padding-bottom: 0.24em; border-bottom: 1px solid var(--dm-line); }
.dm-prose h3 { font-size: 1.14em; }
.dm-prose h4 { font-size: 1em; }
.dm-prose h5, .dm-prose h6 { font-size: 0.94em; color: var(--dm-text-2); }
.dm-prose p { margin: 0.85em 0; }
.dm-prose a { color: var(--dsw-alias-text-link, var(--dm-accent)); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--dm-accent) 35%, transparent); }
.dm-prose a:hover { border-bottom-color: var(--dm-accent); }
.dm-prose strong { font-weight: 650; }
.dm-prose em { font-style: italic; }
.dm-prose del { color: var(--dm-text-3); }
.dm-prose ul, .dm-prose ol { margin: 0.7em 0; padding-left: 1.5em; }
.dm-prose li { margin: 0.28em 0; }
.dm-prose li > ul, .dm-prose li > ol { margin: 0.25em 0; }
.dm-prose blockquote {
  margin: 1em 0;
  padding: 0.2em 0 0.2em 1em;
  border-left: 3px solid var(--dm-line-2);
  color: var(--dm-text-2);
}
.dm-prose hr { border: 0; border-top: 1px solid var(--dm-line); margin: 1.8em 0; }
.dm-prose code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.86em;
  padding: 0.14em 0.38em;
  border-radius: 5px;
  background: var(--dm-bg-2);
  color: var(--dm-text);
}
.dm-prose pre {
  margin: 1em 0;
  padding: 14px 16px;
  border-radius: 10px;
  border: 1px solid var(--dm-line);
  background: var(--dm-bg-1);
  overflow: auto;
  line-height: 1.65;
}
.dm-prose pre code { padding: 0; background: transparent; font-size: 12.5px; }
.dm-prose img { max-width: 100%; height: auto; border-radius: 8px; margin: 0.6em 0; display: block; }
.dm-prose table {
  width: 100%;
  max-width: 100%;
  margin: 1.1em 0;
  border-collapse: collapse;
  font-size: 0.93em;
  table-layout: auto;
}
.dm-prose th, .dm-prose td {
  border: 1px solid var(--dm-line);
  padding: 7px 10px;
  text-align: left;
  vertical-align: top;
  /* Long unbreakable tokens (formulas, paths, hashes) must wrap, otherwise the table's
     min-content width pushes the whole reading pane into horizontal scroll. */
  overflow-wrap: anywhere;
  word-break: break-word;
}
.dm-prose th { background: var(--dm-bg-1); font-weight: 600; }
.dm-prose tr:nth-child(even) td { background: color-mix(in srgb, var(--dm-bg-1) 55%, transparent); }
.dm-prose input[type="checkbox"] { margin-right: 0.45em; vertical-align: -1px; }

/* selection highlight inside the reading surface */
.dm-doc__scroll ::selection { background: color-mix(in srgb, var(--dm-accent) 24%, transparent); }

/* ── selection toolbar ────────────────────────────────────────────────── */
.dm-selbar {
  position: absolute;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: calc(100% - 16px);
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--dm-line);
  background: var(--dsw-alias-bg-elevated, var(--dm-bg));
  box-shadow: var(--dm-shadow);
  animation: dm-pop 120ms ease-out;
}
@keyframes dm-pop { from { opacity: 0; transform: translateY(3px) scale(0.98); } to { opacity: 1; transform: none; } }
.dm-selbar__btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dm-text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.dm-selbar__btn:hover { background: var(--dm-bg-hover); color: var(--dm-text); }
.dm-selbar__btn--primary { color: var(--dm-accent); font-weight: 500; }
.dm-selbar__btn.is-open { background: var(--dm-bg-active); color: var(--dm-text); }
.dm-selbar__divider { width: 1px; height: 18px; background: var(--dm-line); margin: 0 2px; }

/* the 重点 / 疑问 / 待复习 picker, anchored under the bar */
.dm-selbar__menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px;
  border-radius: 9px;
  border: 1px solid var(--dm-line);
  background: var(--dsw-alias-bg-elevated, var(--dm-bg));
  box-shadow: var(--dm-shadow);
  z-index: 61;
}
.dm-selbar__color {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 14px 0 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dm-text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.dm-selbar__color:hover { background: var(--dm-bg-hover); color: var(--dm-text); }
.dm-selbar__dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.dm-selbar__dot--key { background: #f5c542; }
.dm-selbar__dot--question { background: #4a9df0; }
.dm-selbar__dot--review { background: #57b97f; }

/* ── right column: companion chat ─────────────────────────────────────── */
.dm-chat {
  /* 撑满右栏、但绝不超出：flex:none + 自动宽度会让面板按 max-content 撑到比栏还宽，
     一长行提示文字就把整列顶出可视区（右侧被裁掉）。 */
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--dm-bg);
  border-left: 1px solid var(--dm-line);
}
.dm-chat__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--dm-line);
}
.dm-chat__title { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; min-width: 0; }
.dm-chat__doc {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--dm-text-3);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 7px;
  border-left: 1px solid var(--dm-line);
}
.dm-chat__dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--dm-accent);
  box-shadow: 0 0 0 3px var(--dm-accent-soft);
}
.dm-chat__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
/* the host conversation body owns its own scroll + composer inside this box */
.dm-chat__host { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.dm-chat__host > * { flex: 1 1 auto; min-height: 0; }

/* 空白会话的起手牌：别让伴随栏第一眼是一片黑 */
.dm-chat__starter {
  flex: none;
  margin: 14px 14px 4px;
  padding: 14px 14px 12px;
  border: 1px solid var(--dm-line);
  border-radius: 12px;
  background: var(--dm-bg-1);
}
.dm-chat__starter-title { font-size: 13px; font-weight: 600; color: var(--dm-text); }
.dm-chat__starter-hint { margin-top: 4px; color: var(--dm-text-3); font-size: 11.5px; line-height: 1.6; }
.dm-chat__starter-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.dm-chat__chip {
  padding: 5px 10px;
  border: 1px solid var(--dm-line);
  border-radius: 999px;
  background: var(--dm-bg);
  color: var(--dm-text-2);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.dm-chat__chip:hover {
  background: var(--dm-accent-soft);
  border-color: color-mix(in srgb, var(--dm-accent) 35%, var(--dm-line));
  color: var(--dm-accent);
}
.dm-chat__chip[disabled] { opacity: 0.5; cursor: default; }
.dm-chat__notice {
  margin: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px dashed var(--dm-line-2);
  color: var(--dm-text-2);
  font-size: 12px;
  line-height: 1.7;
}
.dm-chat__notice b { color: var(--dm-text); }
.dm-chat__quote {
  flex: none;
  margin: 0 10px 8px;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid var(--dm-line);
  background: var(--dm-bg-1);
  font-size: 12px;
  color: var(--dm-text-2);
  line-height: 1.55;
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.dm-chat__quote svg { flex: none; margin-top: 2px; color: var(--dm-accent); }
.dm-chat__quote-text { flex: 1 1 auto; min-width: 0; max-height: 76px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.dm-chat__quote-src { display: block; margin-top: 4px; font-size: 11px; color: var(--dm-text-3); }

/* free-form follow-up strip, only while a selection is pending */
.dm-chat__ask {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 10px 10px;
  padding: 6px;
  border: 1px solid var(--dm-line);
  border-radius: 10px;
  background: var(--dm-bg-1);
}
.dm-chat__ask-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--dm-text);
  font: inherit;
  font-size: 12.5px;
}
.dm-chat__ask-input::placeholder { color: var(--dm-text-3); }

/* transient corner notice */
.dm-toast {
  position: absolute;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  z-index: 70;
  max-width: 70%;
  padding: 8px 14px;
  border-radius: 9px;
  border: 1px solid var(--dm-line);
  background: var(--dsw-alias-bg-elevated, var(--dm-bg));
  box-shadow: var(--dm-shadow);
  color: var(--dm-text);
  font-size: 12.5px;
  line-height: 1.5;
  animation: dm-pop 140ms ease-out;
}

/* ── resize handles ───────────────────────────────────────────────────── */
.dm-grip {
  flex: none;
  width: 5px;
  margin: 0 -2px;
  cursor: col-resize;
  position: relative;
  z-index: 5;
}
.dm-grip::after {
  content: "";
  position: absolute;
  inset: 0 2px;
  border-radius: 2px;
  background: transparent;
  transition: background 120ms ease;
}
.dm-grip:hover::after, .dm-grip.is-dragging::after { background: var(--dm-accent); opacity: 0.55; }

/* ── welcome / empty centre ───────────────────────────────────────────── */
.dm-welcome {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 40px;
  color: var(--dm-text-3);
  text-align: center;
}
.dm-welcome__mark {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  display: grid;
  place-items: center;
  color: var(--dm-on-accent);
  background: linear-gradient(145deg, var(--dm-accent), color-mix(in srgb, var(--dm-accent) 62%, #1b3a5c));
  box-shadow: 0 10px 26px color-mix(in srgb, var(--dm-accent) 32%, transparent);
}
.dm-welcome__title { font-size: 15px; font-weight: 600; color: var(--dm-text); }
.dm-welcome__hint { font-size: 12.5px; line-height: 1.8; max-width: 420px; }
.dm-welcome kbd {
  font-family: inherit;
  font-size: 11px;
  padding: 1px 5px;
  border: 1px solid var(--dm-line-2);
  border-bottom-width: 2px;
  border-radius: 5px;
  background: var(--dm-bg-1);
  color: var(--dm-text-2);
}
.dm-chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-width: 460px; }
.dm-chip {
  padding: 6px 11px;
  border-radius: 999px;
  border: 1px solid var(--dm-line);
  background: var(--dm-bg-1);
  color: var(--dm-text-2);
  font-size: 12px;
  cursor: pointer;
}
.dm-chip:hover { border-color: var(--dm-accent); color: var(--dm-accent); }

/* ── centre panes (one document, or two side by side) ─────────────────── */
.dm-panes { flex: 1 1 auto; min-height: 0; display: flex; }
.dm-pane {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.dm-panes.is-split .dm-pane + .dm-pane { border-left: 1px solid var(--dm-line); }
.dm-pane__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--dm-line);
  background: var(--dm-bg-1);
}
.dm-pane__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--dm-text-2);
}
.dm-rail-right { flex: 0 1 348px; min-width: 268px; display: flex; min-height: 0; }
.dm-side__hint {
  margin: 0 12px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--dm-text-3);
}

/* ── Obsidian dialect (frontmatter / callout / wikilink / tag / mark) ─── */
.dm-md-meta {
  margin: 0 0 1.6em;
  padding: 8px 12px;
  border-radius: 9px;
  border: 1px solid var(--dm-line);
  background: var(--dm-bg-1);
  font-size: 12px;
  line-height: 1.9;
  color: var(--dm-text-2);
  cursor: pointer;
  overflow: hidden;
}
.dm-md-meta:not(.is-open) {
  max-height: 4.6em;
}
.dm-md-meta__item { display: inline-flex; gap: 5px; margin-right: 14px; white-space: nowrap; }
.dm-md-meta__item b { color: var(--dm-text-3); font-weight: 500; }
.dm-md-meta__tag {
  display: inline-block;
  margin-right: 5px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--dm-bg-2);
  color: var(--dm-text-2);
  font-size: 11px;
  line-height: 18px;
}
.dm-md-meta__hint { display: block; margin-top: 2px; font-size: 11px; color: var(--dm-text-3); }

.dm-md-callout {
  --dm-callout: var(--dm-text-3);
  margin: 1em 0;
  padding: 10px 14px 10px 12px;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--dm-callout) 34%, transparent);
  border-left: 3px solid var(--dm-callout);
  background: color-mix(in srgb, var(--dm-callout) 8%, transparent);
  overflow: hidden;
  min-width: 0;
}
.dm-md-callout--blue { --dm-callout: #3a86ff; }
.dm-md-callout--green { --dm-callout: #34a86c; }
.dm-md-callout--yellow { --dm-callout: #d9a400; }
.dm-md-callout--red { --dm-callout: #d64545; }
.dm-md-callout--gray { --dm-callout: #8b93a1; }
.dm-md-callout__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--dm-callout);
  margin-bottom: 4px;
}
.dm-md-callout--foldable .dm-md-callout__title { cursor: pointer; user-select: none; }
.dm-md-callout__body > :first-child { margin-top: 0; }
.dm-md-callout__body > :last-child { margin-bottom: 0; }
.dm-md-callout--folded .dm-md-callout__body { display: none; }

.dm-md-wikilink {
  color: var(--dm-accent);
  border-bottom: 1px dashed color-mix(in srgb, var(--dm-accent) 45%, transparent);
  cursor: pointer;
}
.dm-md-wikilink:hover { border-bottom-style: solid; }
.dm-md-embed {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--dm-bg-2);
  color: var(--dm-text-3);
  font-size: 0.9em;
}
.dm-md-mark { background: rgba(240, 178, 0, 0.28); color: inherit; border-radius: 3px; padding: 0 1px; }

/* images that cannot resolve (relative paths from the original vault) */
.dm-md-img-missing {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  margin: 0.5em 0;
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px dashed var(--dm-line-2);
  background: var(--dm-bg-1);
  color: var(--dm-text-3);
  font-size: 12px;
  vertical-align: middle;
}
.dm-md-img-missing__icon { flex: none; opacity: 0.8; }
.dm-md-img-missing__name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dm-text-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
}
.dm-md-img-missing__hint { flex: none; color: var(--dm-text-3); }

/* math without a typesetting engine: monospace, still readable */
.dm-md-math {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--dm-bg-2);
  color: var(--dm-text);
  white-space: nowrap;
}
.dm-md-math--display {
  display: inline-block;
  padding: 2px 6px;
  background: var(--dm-bg-1);
  border: 1px solid var(--dm-line);
}
.dm-md-math-block {
  margin: 1em 0;
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid var(--dm-line);
  background: var(--dm-bg-1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--dm-text);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
/* KaTeX 排好之后（45-math.js 打上 .dm-math-on）：拆掉等宽占位的外壳，让公式用自己的
   字体和行高；块级公式保留横向滚动，宽公式不会把正文撑破。 */
.dm-md-math.dm-math-on,
.dm-md-math--display.dm-math-on {
  padding: 0;
  border: 0;
  background: none;
  font-family: inherit;
  font-size: 1em;
  white-space: normal;
}
.dm-md-math-block.dm-math-on {
  margin: 0.9em 0;
  padding: 2px 0;
  border: 0;
  background: none;
  font-family: inherit;
  font-size: 1em;
  line-height: normal;
  white-space: normal;
  word-break: normal;
  overflow-x: auto;
  overflow-y: hidden;
}
.dm-md-math-block.dm-math-on .katex-display { margin: 0.35em 0; }
.dm-math-on .katex { color: inherit; }
.dm-md-tag {
  display: inline-block;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dm-accent-soft);
  color: var(--dm-accent);
  font-size: 0.86em;
  line-height: 1.6;
}

/* ── pdf viewer (class names owned by 40-pdf.js) ──────────────────────── */
.dm-pdf-root { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; background: var(--dm-bg-2); }
.dm-pdf-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid var(--dm-line);
  background: var(--dm-bg);
  color: var(--dm-text-2);
  font-size: 12px;
}
.dm-pdf-toolbar .dm-btn { height: 26px; }
.dm-pdf-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 26px;
  min-width: 26px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dm-text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.dm-pdf-btn:hover { background: var(--dm-bg-hover); color: var(--dm-text); }
.dm-pdf-btn-active { background: var(--dm-accent-soft); color: var(--dm-accent); }
.dm-pdf-btn[disabled] { opacity: 0.45; cursor: default; }
.dm-pdf-sep { width: 1px; height: 16px; background: var(--dm-line); margin: 0 3px; flex: none; }
.dm-pdf-pageinfo { display: flex; align-items: center; gap: 3px; color: var(--dm-text-2); }
.dm-pdf-page-input {
  width: 40px;
  height: 22px;
  text-align: center;
  font: inherit;
  font-size: 12px;
  color: var(--dm-text);
  background: var(--dm-bg-1);
  border: 1px solid var(--dm-line);
  border-radius: 5px;
  outline: none;
}
.dm-pdf-page-input:focus { border-color: var(--dm-accent); }
.dm-pdf-page-total { color: var(--dm-text-3); }
.dm-pdf-zoom-label { min-width: 42px; text-align: center; color: var(--dm-text-3); }
.dm-pdf-notice {
  margin: 8px 12px 0;
  padding: 6px 10px;
  border-radius: 7px;
  background: var(--dm-bg-1);
  color: var(--dm-text-3);
  font-size: 11.5px;
}
.dm-pdf-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 18px 0 40px; }
.dm-pdf-pages { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.dm-pdf-page {
  position: relative;
  background: #fff;
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.16);
  border-radius: 2px;
  overflow: hidden;
}
.dm-pdf-canvas { display: block; border-radius: 2px; }
.dm-pdf-text-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  line-height: 1;
  opacity: 1;
}
.dm-pdf-text-layer span {
  position: absolute;
  white-space: pre;
  transform-origin: 0 0;
  color: transparent;
  cursor: text;
}
.dm-pdf-text-layer span::selection { background: color-mix(in srgb, var(--dm-accent) 30%, transparent); }
.dm-pdf-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 60px 0; color: var(--dm-text-3); }
.dm-pdf-page-error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--dm-bg-1);
  color: var(--dm-text-3);
  font-size: 12px;
}
.dm-pdf-error { margin: 40px auto; max-width: 520px; padding: 16px 18px; border-radius: 10px; border: 1px solid var(--dm-line); color: var(--dm-text-2); line-height: 1.7; }
.dm-pdf-error-title { font-weight: 600; color: var(--dm-danger); margin-bottom: 6px; }
.dm-pdf-error-msg { color: var(--dm-text-2); }
.dm-pdf-error-retry { margin-top: 10px; }

/* ── docx output (class names owned by src/host/docx.js) ──────────────── */
.dm-docx-table { width: 100%; max-width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 0.93em; }
.dm-docx-table td, .dm-docx-table th {
  border: 1px solid var(--dm-line);
  padding: 7px 10px;
  vertical-align: top;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.dm-docx-pagebreak { border: 0; border-top: 1px dashed var(--dm-line-2); margin: 2em 0; }
.dm-docx-align-center { text-align: center; }
.dm-docx-align-right { text-align: right; }
.dm-docx-align-justify { text-align: justify; }
.dm-docx-img { max-width: 100%; height: auto; }
.dm-docx-link { color: var(--dsw-alias-text-link, var(--dm-accent)); }

/* ── 框选截图（48-shot.js 出图，这里只负责手势与卡片） ────────────────── */
.dm-root.is-shot [data-dm-viewer] { cursor: crosshair; }
.dm-root.is-shot [data-dm-viewer] * {
  cursor: crosshair !important;
  user-select: none !important;
  -webkit-user-select: none !important;
}
.dm-shot-hint {
  position: absolute;
  top: 52px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 92;
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--dsw-alias-toast-bg, var(--dm-bg-2));
  color: var(--dsw-alias-toast-label, var(--dm-text));
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  box-shadow: var(--dm-shadow);
  pointer-events: none;
}
.dm-shotcard {
  position: absolute;
  z-index: 95;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px;
  border: 1px solid var(--dm-line);
  border-radius: 12px;
  background: var(--dsw-alias-bg-elevated, var(--dm-bg));
  box-shadow: var(--dm-shadow);
  animation: dm-shotcard-in 140ms ease-out;
}
@keyframes dm-shotcard-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.dm-shotcard__img {
  width: 100%;
  max-height: 190px;
  object-fit: contain;
  border-radius: 8px;
  background: var(--dm-bg-2);
}
.dm-shotcard__meta { color: var(--dm-text-3); font-size: 11px; line-height: 1.4; }
.dm-shotcard__acts { display: flex; flex-wrap: wrap; gap: 6px; }
.dm-shotcard__btn {
  flex: 1 1 auto;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--dm-line);
  border-radius: 7px;
  background: var(--dm-bg);
  color: var(--dm-text-2);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.dm-shotcard__btn:hover { background: var(--dm-bg-hover); color: var(--dm-text); }
.dm-shotcard__btn.is-primary { background: var(--dm-accent); border-color: transparent; color: var(--dm-on-accent); }
.dm-shotcard__btn--ghost { flex: 0 0 auto; }
.dm-chat__quote-shot {
  flex: none;
  width: 64px;
  height: 48px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--dm-line);
}

/* ── narrow viewports: the chat column can be collapsed by the user ───── */
/* （旧规则 .dm-root.is-narrow .dm-side { width: 200px !important } 已删除：三栏宽度现在由
   12-panes.js 统一分配，那条 !important 会盖掉分隔条拖出来的宽度。is-narrow 类也从没被
   加上过，属于死代码。） */
`;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createCss };
