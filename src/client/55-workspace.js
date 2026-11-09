/* ===== 55-workspace.js ===== */
/**
 * The research workspace's left rail: the documents the user dragged in, the per-document
 * research memory editor, and the drag-and-drop affordance.
 *
 * Everything here is presentational. Dropping files, reading/writing `memory.md`, and
 * persisting the document list are owned by the app shell (`70-app.js`); these components
 * only render props and call back. No `document` / `window` access, no side effects outside
 * React's own hooks — the shell stays in charge of I/O.
 *
 * Exposed as `createWorkspace(React, util) -> { DocList, MemoryPanel, DropOverlay, css }`.
 * `css` is a plain string; the shell appends it to the plugin stylesheet.
 */
function createWorkspace(React, util) {
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;
  const { cx, Icon, formatBytes } = util;

  /* ── shared helpers ──────────────────────────────────────────────────── */

  /** Format badge classes. The `dm-badge` family is shared with the reading surface. */
  const BADGES = {
    pdf: 'dm-badge dm-badge--pdf',
    docx: 'dm-badge dm-badge--docx',
    doc: 'dm-badge dm-badge--docx',
    md: 'dm-badge dm-badge--md',
    markdown: 'dm-badge dm-badge--md',
    mdx: 'dm-badge dm-badge--md',
    txt: 'dm-badge dm-badge--txt',
  };

  function badgeOf(ext) {
    return BADGES[String(ext || '').toLowerCase()] || 'dm-badge dm-badge--txt';
  }

  function badgeLabel(ext) {
    const key = String(ext || '').toLowerCase();
    if (!key) return '?';
    if (key === 'markdown' || key === 'mdx') return 'MD';
    if (key === 'doc') return 'DOCX';
    return key.toUpperCase();
  }

  /** The shell gives every entry an `id`; the fallbacks keep a malformed entry renderable. */
  function docId(doc) {
    if (!doc) return '';
    if (doc.id !== undefined && doc.id !== null) return doc.id;
    return doc.path || doc.name || '';
  }

  function sameId(a, b) {
    if (a === undefined || a === null || b === undefined || b === null) return false;
    return String(a) === String(b);
  }

  /** Secondary line: character count when the document has text, size otherwise. */
  function metaOf(doc) {
    const chars = doc && typeof doc.chars === 'number' ? doc.chars : 0;
    if (chars > 0) return chars >= 10000 ? (chars / 10000).toFixed(1) + ' 万字' : chars + ' 字';
    return formatBytes(doc && doc.size) || '';
  }

  function countLabel(count) {
    if (!count) return '0 字';
    return count >= 10000 ? (count / 10000).toFixed(1) + ' 万字' : count + ' 字';
  }

  /* ── 1. document list ────────────────────────────────────────────────── */

  /**
   * `docs: [{ id, name, ext, size, chars, hasText, sessionId, addedAt }]`
   *
   * Rows are `role="button"` and respond to Enter/Space; the two trailing buttons stop
   * propagation so a click on them never also selects the row. Right-clicking a row is a
   * second way to send that document to the compare pane.
   */
  function DocList(props) {
    const docs = Array.isArray(props.docs) ? props.docs : [];
    const activeId = props.activeId;
    const compareId = props.compareId;
    const onSelect = props.onSelect;
    const onRemove = props.onRemove;
    const onCompare = props.onCompare;

    if (!docs.length) {
      return h(
        'div',
        { className: 'dm-doclist dm-doclist--empty' },
        h(
          'div',
          { className: 'dm-doclist-empty' },
          h('div', { className: 'dm-doclist-empty__title' }, '研究区还是空的'),
          h('div', { className: 'dm-doclist-empty__hint' }, '把文档拖进来，或点上面的 ＋'),
        ),
      );
    }

    return h(
      'div',
      { className: 'dm-doclist dm-scroll', role: 'group', 'aria-label': '研究区文档' },
      docs.map((doc, index) => {
        const id = docId(doc);
        const isActive = sameId(activeId, id);
        const isCompare = sameId(compareId, id);
        const meta = metaOf(doc);
        const name = (doc && doc.name) || '未命名文档';

        function select() {
          if (onSelect) onSelect(id);
        }

        function compare(event) {
          if (event) {
            event.preventDefault();
            event.stopPropagation();
          }
          if (onCompare) onCompare(id);
        }

        function remove(event) {
          if (event) {
            event.preventDefault();
            event.stopPropagation();
          }
          if (onRemove) onRemove(id);
        }

        return h(
          'div',
          {
            key: id || 'doc-' + index,
            className: cx('dm-doclist-row', isActive && 'is-active', isCompare && 'is-compare'),
            role: 'button',
            tabIndex: 0,
            'aria-current': isActive ? 'true' : undefined,
            title: name + (meta ? ' · ' + meta : ''),
            onClick: select,
            onContextMenu: (event) => {
              if (!onCompare) return;
              compare(event);
            },
            onKeyDown: (event) => {
              // Only the row itself: Enter on one of the trailing buttons must not also
              // select the document.
              if (event.target !== event.currentTarget) return;
              if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
              event.preventDefault();
              select();
            },
          },
          h('span', { className: badgeOf(doc && doc.ext) }, badgeLabel(doc && doc.ext)),
          h(
            'span',
            { className: 'dm-doclist-row__main' },
            h('span', { className: 'dm-doclist-row__name' }, name),
            h(
              'span',
              { className: 'dm-doclist-row__meta' },
              meta ? h('span', { className: 'dm-doclist-row__meta-text' }, meta) : null,
              isCompare ? h('span', { className: 'dm-doclist-row__flag' }, '对照中') : null,
            ),
          ),
          h(
            'span',
            { className: 'dm-doclist-row__actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dm-doclist-act',
                title: isCompare ? '已在对照窗格' : '放进对照窗格',
                'aria-label': '对照 ' + name,
                'aria-pressed': isCompare ? 'true' : 'false',
                onClick: compare,
                disabled: !onCompare,
              },
              h(Icon, { name: 'panel', size: 13 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dm-doclist-act dm-doclist-act--danger',
                title: '从研究区移除',
                'aria-label': '移除 ' + name,
                onClick: remove,
                disabled: !onRemove,
              },
              h(Icon, { name: 'close', size: 13 }),
            ),
          ),
        );
      }),
    );
  }

  /* ── 2. research memory ──────────────────────────────────────────────── */

  /**
   * `doc`, `memory` (contents of memory.md), `loading`, `error`, `onSave(text)`,
   * `onRefresh()`.
   *
   * The editor keeps a local draft. `dirty` is derived from `draft !== memory`, so the
   * shell clears it simply by passing the saved text back as the new `memory` prop.
   * Switching documents replaces the draft; a refresh only replaces it while the user has
   * no unsaved edits (never clobber typing).
   */
  function MemoryPanel(props) {
    const doc = props.doc || null;
    const memory = typeof props.memory === 'string' ? props.memory : '';
    const loading = !!props.loading;
    const error = props.error ? String(props.error) : null;
    const onSave = props.onSave;
    const onRefresh = props.onRefresh;

    const docKey = doc ? String(docId(doc)) : '';
    const [draft, setDraft] = useState(memory);
    const [open, setOpen] = useState(true);
    const docKeyRef = useRef(docKey);
    const memoryRef = useRef(memory);

    useEffect(() => {
      if (docKeyRef.current === docKey) return;
      docKeyRef.current = docKey;
      memoryRef.current = memory;
      setDraft(memory);
    }, [docKey, memory]);

    useEffect(() => {
      if (memoryRef.current === memory) return;
      const previous = memoryRef.current;
      memoryRef.current = memory;
      setDraft((current) => (current === previous ? memory : current));
    }, [memory]);

    const dirty = draft !== memory;

    function save() {
      if (!onSave || !dirty) return;
      onSave(draft);
    }

    if (!doc) {
      return h(
        'div',
        { className: 'dm-mem dm-mem--empty' },
        h('div', { className: 'dm-mem__head' }, h('span', { className: 'dm-mem__title' }, '研究记忆')),
        h('div', { className: 'dm-mem__placeholder' }, '先打开一篇文档'),
      );
    }

    return h(
      'div',
      { className: 'dm-mem' },
      h(
        'div',
        { className: 'dm-mem__head' },
        h(
          'button',
          {
            type: 'button',
            className: 'dm-mem__toggle',
            'aria-expanded': open ? 'true' : 'false',
            title: open ? '收起研究记忆' : '展开研究记忆',
            onClick: () => setOpen((value) => !value),
          },
          h('span', { className: cx('dm-mem__twist', open && 'is-open') }, h(Icon, { name: 'chevron', size: 12 })),
          h('span', { className: 'dm-mem__title' }, '研究记忆'),
          dirty ? h('span', { className: 'dm-mem__dot', title: '有未保存的改动' }) : null,
          h('span', { className: 'dm-mem__count' }, countLabel(draft.length)),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dm-mem__act',
            title: '重新读取 memory.md',
            'aria-label': '刷新研究记忆',
            onClick: onRefresh,
            disabled: !onRefresh || loading,
          },
          h(Icon, { name: 'refresh', size: 13 }),
        ),
      ),
      open
        ? h(
            'div',
            { className: 'dm-mem__body' },
            error ? h('div', { className: 'dm-mem__error' }, error) : null,
            loading ? h('div', { className: 'dm-mem__loading' }, '正在读取研究记忆…') : null,
            h('textarea', {
              className: 'dm-mem__editor',
              value: draft,
              spellCheck: false,
              rows: 8,
              placeholder: '还没有研究记忆。读到值得长期记住的结论时，让 AI 记下来。',
              'aria-label': '研究记忆',
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  save();
                }
              },
            }),
            h(
              'div',
              { className: 'dm-mem__foot' },
              h('span', { className: 'dm-mem__hint' }, 'AI 会把值得长期记住的结论追加到这里；你也可以自己改'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dm-mem__save',
                  title: '保存（Ctrl/Cmd + Enter）',
                  onClick: save,
                  disabled: !dirty,
                },
                '保存',
              ),
            ),
          )
        : null,
    );
  }

  /* ── 3. drop overlay ─────────────────────────────────────────────────── */

  /**
   * Purely visual: the shell listens for dragenter/dragover/dragleave/drop on the panel
   * root and flips `visible`. The overlay must never eat pointer events, so it is
   * `pointer-events: none` in CSS.
   */
  function DropOverlay(props) {
    if (!props || !props.visible) return null;
    return h(
      'div',
      { className: 'dm-drop', 'aria-hidden': 'true' },
      h(
        'div',
        { className: 'dm-drop__frame' },
        h('div', { className: 'dm-drop__icon' }, h(Icon, { name: 'plus', size: 22 })),
        h('div', { className: 'dm-drop__title' }, '松手加入研究区'),
        h('div', { className: 'dm-drop__hint' }, '支持 PDF / DOCX / Markdown / TXT'),
      ),
    );
  }

  /* ── stylesheet ──────────────────────────────────────────────────────── */

  const css = `
/* ── research workspace: document list (55-workspace.js) ───────────────── */
.dm-doclist {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 6px 14px;
}
.dm-doclist--empty {
  justify-content: center;
  overflow: hidden;
}
.dm-doclist-empty {
  padding: 26px 16px;
  color: var(--dm-text-3);
  font-size: 12px;
  line-height: 1.8;
  text-align: center;
}
.dm-doclist-empty__title {
  margin-bottom: 4px;
  color: var(--dm-text-2);
  font-size: 13px;
  font-weight: 500;
}
.dm-doclist-empty__hint { color: var(--dm-text-3); }

.dm-doclist-row {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 7px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--dm-text-2);
  cursor: pointer;
  user-select: none;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.dm-doclist-row:hover { background: var(--dm-bg-hover); color: var(--dm-text); }
.dm-doclist-row:focus-visible { outline: 2px solid var(--dm-accent); outline-offset: -2px; }
.dm-doclist-row.is-active { background: var(--dm-accent-soft); color: var(--dm-accent); }
.dm-doclist-row.is-active .dm-doclist-row__meta { color: var(--dm-accent); opacity: 0.85; }
.dm-doclist-row.is-compare { border-color: color-mix(in srgb, var(--dm-accent) 42%, var(--dm-line)); }

.dm-doclist-row__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dm-doclist-row__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  line-height: 1.45;
}
.dm-doclist-row__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 14px;
  color: var(--dm-text-3);
  font-size: 11px;
  line-height: 1.4;
}
.dm-doclist-row__meta-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-doclist-row__flag {
  flex: none;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--dm-accent-soft);
  color: var(--dm-accent);
  font-size: 10px;
  line-height: 15px;
  letter-spacing: 0.02em;
}
.dm-doclist-row__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0.55;
  transition: opacity 120ms ease;
}
.dm-doclist-row:hover .dm-doclist-row__actions,
.dm-doclist-row:focus-within .dm-doclist-row__actions,
.dm-doclist-row.is-active .dm-doclist-row__actions,
.dm-doclist-row.is-compare .dm-doclist-row__actions { opacity: 1; }

.dm-doclist-act {
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
.dm-doclist-act:hover { background: var(--dm-bg-active); color: var(--dm-text); }
.dm-doclist-act--danger:hover { background: color-mix(in srgb, var(--dm-danger) 12%, transparent); color: var(--dm-danger); }
.dm-doclist-act[disabled] { opacity: 0.35; cursor: default; }
.dm-doclist-act[disabled]:hover { background: transparent; color: var(--dm-text-3); }

/* the badge family is shared; keep it legible inside the rail */
.dm-doclist .dm-badge {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--dm-bg-2);
  color: var(--dm-text-3);
  font-size: 10px;
  font-weight: 500;
  line-height: 15px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.dm-doclist .dm-badge--pdf { color: #b4453c; background: rgba(180, 69, 60, 0.12); }
.dm-doclist .dm-badge--docx { color: #2b579a; background: rgba(43, 87, 154, 0.12); }
.dm-doclist .dm-badge--md { color: #3b7a57; background: rgba(59, 122, 87, 0.12); }
.dm-doclist .dm-badge--txt { color: var(--dm-text-3); background: var(--dm-bg-2); }

/* ── research memory ───────────────────────────────────────────────────── */
.dm-mem {
  /* Shrinkable, never flex:none: the rail stacks three sections and a fixed-height
     memory panel used to overflow the column and clip its own footer. */
  flex: 0 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--dm-line);
  background: var(--dm-bg-1);
}
.dm-mem--empty { background: transparent; }
.dm-mem__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 7px 8px 5px;
}
.dm-mem__toggle {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dm-text-2);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-align: left;
  cursor: pointer;
}
.dm-mem__toggle:hover { background: var(--dm-bg-hover); color: var(--dm-text); }
.dm-mem__toggle:focus-visible { outline: 2px solid var(--dm-accent); outline-offset: -2px; }
.dm-mem__twist {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dm-text-3);
  transition: transform 120ms ease;
}
.dm-mem__twist.is-open { transform: rotate(90deg); }
.dm-mem__title { flex: none; }
.dm-mem__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dm-accent);
  box-shadow: 0 0 0 3px var(--dm-accent-soft);
}
.dm-mem__count {
  flex: none;
  margin-left: auto;
  padding-left: 8px;
  color: var(--dm-text-3);
  font-size: 11px;
  font-weight: 400;
}
.dm-mem__act {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dm-text-3);
  cursor: pointer;
}
.dm-mem__act:hover { background: var(--dm-bg-hover); color: var(--dm-text); }
.dm-mem__act[disabled] { opacity: 0.35; cursor: default; }
.dm-mem__act[disabled]:hover { background: transparent; color: var(--dm-text-3); }
.dm-mem__body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  padding: 0 10px 10px;
}
.dm-mem__editor {
  flex: 0 1 auto;
  width: 100%;
  height: 152px;
  min-height: 54px;
  resize: none;
  padding: 8px 9px;
  border: 1px solid var(--dm-line);
  border-radius: 8px;
  background: var(--dm-bg);
  color: var(--dm-text);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.7;
  outline: none;
  tab-size: 2;
}
.dm-mem__editor:focus { border-color: var(--dm-accent); box-shadow: 0 0 0 2px var(--dm-accent-soft); }
.dm-mem__editor::placeholder { color: var(--dm-text-3); }
.dm-mem__foot { flex: none; display: flex; align-items: flex-start; gap: 8px; }
.dm-mem__hint {
  flex: 1 1 auto;
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--dm-text-3);
  font-size: 11px;
  line-height: 1.5;
}
.dm-mem__save {
  flex: none;
  height: 26px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: var(--dm-accent);
  color: var(--dm-on-accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: filter 120ms ease, opacity 120ms ease;
}
.dm-mem__save:hover { filter: brightness(1.06); }
.dm-mem__save[disabled] { opacity: 0.4; cursor: default; filter: none; }
.dm-mem__loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--dm-text-3);
  font-size: 11.5px;
}
.dm-mem__loading::before {
  content: "";
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 2px solid var(--dm-line-2);
  border-top-color: var(--dm-accent);
  animation: dm-mem-spin 720ms linear infinite;
}
@keyframes dm-mem-spin { to { transform: rotate(360deg); } }
.dm-mem__error {
  padding: 6px 8px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--dm-danger) 9%, transparent);
  color: var(--dm-danger);
  font-size: 11.5px;
  line-height: 1.55;
  word-break: break-word;
}
.dm-mem__placeholder {
  padding: 2px 14px 14px;
  color: var(--dm-text-3);
  font-size: 12px;
}

/* ── drag-and-drop overlay ─────────────────────────────────────────────── */
.dm-drop {
  position: absolute;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: stretch;
  justify-content: center;
  padding: 16px;
  background: color-mix(in srgb, var(--dm-bg) 70%, transparent);
  pointer-events: none;
  animation: dm-drop-in 120ms ease-out;
}
@keyframes dm-drop-in { from { opacity: 0; } to { opacity: 1; } }
.dm-drop__frame {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  border: 2px dashed var(--dm-accent);
  border-radius: calc(var(--dm-radius) + 4px);
  background: var(--dm-accent-soft);
  text-align: center;
}
.dm-drop__icon {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 13px;
  background: var(--dm-accent);
  color: var(--dm-on-accent);
  box-shadow: var(--dm-shadow);
}
.dm-drop__title { color: var(--dm-text); font-size: 14px; font-weight: 600; }
.dm-drop__hint { color: var(--dm-text-3); font-size: 12px; }
`;

  return { DocList, MemoryPanel, DropOverlay, css };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createWorkspace };
