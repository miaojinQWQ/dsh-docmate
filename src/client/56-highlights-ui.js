/* ===== 56-highlights-ui.js ===== */
/**
 * The left rail's highlight list.
 *
 * Every mark the user made in the *active* document, with a colour filter strip, a jump
 * back to the anchor, "ask the companion AI about this one", delete, and an optional inline
 * note editor. Purely presentational: the shell owns the HTTP routes, the anchor engine
 * (`52-highlights.js`) and the selection bar. The only ways out are the callbacks.
 *
 * Exposed as `createHighlightsUi(React, util) -> { HighlightList, HighlightsCss }`.
 * `HighlightsCss` is a plain string; the shell appends it to the plugin stylesheet.
 */
function createHighlightsUi(React, util) {
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;

  const cx =
    util && typeof util.cx === 'function'
      ? util.cx
      : function fallbackCx() {
          return Array.prototype.filter.call(arguments, Boolean).join(' ');
        };
  const Icon =
    util && typeof util.Icon === 'function'
      ? util.Icon
      : function fallbackIcon() {
          return null;
        };
  const oneLine =
    util && typeof util.oneLine === 'function'
      ? util.oneLine
      : function fallbackOneLine(text, max) {
          const flat = String(text || '').replace(/\s+/g, ' ').trim();
          if (!max || flat.length <= max) return flat;
          return flat.slice(0, max - 1) + '…';
        };

  /**
   * Mirrors `COLORS` in 52-highlights.js. Fragments may not share variables, so the shell
   * can pass the engine's own list as `colors` if it wants a single source of truth.
   */
  const COLOR_META = [
    { id: 'key', label: '重点', hint: '关键结论、定义、要记住的句子' },
    { id: 'question', label: '疑问', hint: '没读懂、想追问 AI 的地方' },
    { id: 'review', label: '待复习', hint: '过几天要回来再看的内容' },
  ];

  const FILTER_ALL = 'all';
  const FILTER_QUOTE = 'quote';
  const SUMMARY_CHARS = 60;

  /* ── tiny helpers ────────────────────────────────────────────────────── */

  function stop(event) {
    if (!event) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
  }

  function sameId(a, b) {
    if (a === undefined || a === null || b === undefined || b === null) return false;
    return String(a) === String(b);
  }

  function idOf(item, index) {
    if (item && item.id !== undefined && item.id !== null) return String(item.id);
    return 'hl-' + index;
  }

  function colorOf(colorId) {
    for (let index = 0; index < COLOR_META.length; index += 1) {
      if (COLOR_META[index].id === colorId) return COLOR_META[index];
    }
    return { id: 'key', label: '重点', hint: '' };
  }

  /** "刚刚 / 12 分钟前 / 3 小时前 / 2 天前 / 3月8日 / 2024年3月8日". */
  function formatWhen(value) {
    const stamp = Number(value);
    if (!isFinite(stamp) || stamp <= 0) return '';
    const now = Date.now();
    const diff = Math.max(0, now - stamp);
    const minute = 60000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return '刚刚';
    if (diff < hour) return Math.floor(diff / minute) + ' 分钟前';
    if (diff < day) return Math.floor(diff / hour) + ' 小时前';
    if (diff < 7 * day) return Math.floor(diff / day) + ' 天前';
    let date;
    try {
      date = new Date(stamp);
    } catch (error) {
      return '';
    }
    if (!date || !isFinite(date.getTime())) return '';
    const thisYear = new Date(now).getFullYear();
    const monthDay = date.getMonth() + 1 + '月' + date.getDate() + '日';
    return date.getFullYear() === thisYear ? monthDay : date.getFullYear() + '年' + monthDay;
  }

  /* ── the list ────────────────────────────────────────────────────────── */

  /**
   * `items` are the highlights of the active document (both `mark` and `quote` kinds);
   * `activeId` is the row currently being jumped to / hovered in the text.
   */
  function HighlightList(props) {
    const p = props || {};
    const items = Array.isArray(p.items) ? p.items : [];
    const activeId = p.activeId;
    const loading = !!p.loading;
    const error = p.error ? String(p.error) : null;
    const colors = Array.isArray(p.colors) && p.colors.length ? p.colors : COLOR_META;
    const onJump = p.onJump;
    const onDelete = p.onDelete;
    const onNote = p.onNote;
    const onAskAbout = p.onAskAbout;
    const onAskAll = p.onAskAll;

    const [open, setOpen] = useState(true);
    const [filter, setFilter] = useState(FILTER_ALL);
    const [editingId, setEditingId] = useState(null);
    const [noteDraft, setNoteDraft] = useState('');
    const rowRefs = useRef({});

    // Keep the active row visible when the shell jumps to a highlight from somewhere else.
    useEffect(() => {
      if (activeId === undefined || activeId === null) return;
      const node = rowRefs.current[String(activeId)];
      if (!node || typeof node.scrollIntoView !== 'function') return;
      try {
        node.scrollIntoView({ block: 'nearest' });
      } catch (error) {
        /* ignore — scrolling is a nicety */
      }
    }, [activeId, open, filter]);

    /* counts for the header and the filter strip */
    const counts = { all: items.length, quote: 0 };
    for (let index = 0; index < colors.length; index += 1) counts[colors[index].id] = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item) continue;
      if (item.kind === 'quote') counts.quote += 1;
      const color = String(item.color || '');
      for (let slot = 0; slot < colors.length; slot += 1) {
        if (colors[slot].id === color) {
          counts[color] += 1;
          break;
        }
      }
    }

    const filters = [{ id: FILTER_ALL, label: '全部' }]
      .concat(colors.map((color) => ({ id: color.id, label: color.label })))
      .concat([{ id: FILTER_QUOTE, label: '引用' }]);

    const visible = items.filter((item) => {
      if (!item) return false;
      if (filter === FILTER_ALL) return true;
      if (filter === FILTER_QUOTE) return item.kind === 'quote';
      return String(item.color || '') === filter;
    });

    function beginNote(item) {
      if (!onNote || !item) return;
      setEditingId(idOf(item, 0));
      setNoteDraft(typeof item.note === 'string' ? item.note : '');
    }

    function commitNote(item) {
      if (!item) {
        setEditingId(null);
        return;
      }
      const text = String(noteDraft || '').trim();
      const previous = typeof item.note === 'string' ? item.note : '';
      if (onNote && text !== previous) onNote(item, text);
      setEditingId(null);
      setNoteDraft('');
    }

    function cancelNote() {
      setEditingId(null);
      setNoteDraft('');
    }

    /* ── one row ───────────────────────────────────────────────────────── */

    function renderRow(item, index) {
      const id = idOf(item, index);
      const color = colorOf(item && item.color);
      const isActive = sameId(activeId, item && item.id);
      const isEditing = editingId === id;
      const note = item && typeof item.note === 'string' ? item.note : '';
      const isQuote = !!item && item.kind === 'quote';
      const when = formatWhen(item && item.createdAt);
      const summary = item && item.text ? oneLine(item.text, SUMMARY_CHARS) : '（空划线）';

      function jump() {
        if (onJump && item) onJump(item);
      }

      function ask(event) {
        stop(event);
        if (onAskAbout && item) onAskAbout(item);
      }

      function remove(event) {
        stop(event);
        if (onDelete && item) onDelete(item.id);
      }

      function editNote(event) {
        stop(event);
        beginNote(item);
      }

      return h(
        'div',
        {
          key: id,
          ref: (node) => {
            if (node) rowRefs.current[id] = node;
            else delete rowRefs.current[id];
          },
          className: cx('dm-hlui-row', isActive && 'is-active', isQuote && 'is-quote'),
          role: 'button',
          tabIndex: 0,
          'aria-current': isActive ? 'true' : undefined,
          title: item && item.text ? item.text : '',
          onClick: jump,
          onKeyDown: (event) => {
            // Only the row itself: Enter inside the note editor or on one of the trailing
            // buttons must not also jump.
            if (event.target !== event.currentTarget) return;
            if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
            event.preventDefault();
            jump();
          },
        },
        h('span', { className: 'dm-hlui-dot dm-hlui-dot--' + color.id, 'aria-hidden': 'true' }),
        h(
          'div',
          { className: 'dm-hlui-row__main' },
          h('div', { className: 'dm-hlui-row__text' }, summary),
          h(
            'div',
            { className: 'dm-hlui-row__meta' },
            when ? h('span', { className: 'dm-hlui-row__time' }, when) : null,
            isQuote ? h('span', { className: 'dm-hlui-row__kind' }, '引用') : null,
            onNote && !isEditing
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dm-hlui-note-btn',
                    title: note ? '编辑备注' : '加一条备注',
                    onClick: editNote,
                  },
                  note ? '备注' : '＋备注',
                )
              : null,
          ),
          note && !isEditing ? h('div', { className: 'dm-hlui-row__note' }, note) : null,
          isEditing
            ? h(
                'div',
                { className: 'dm-hlui-note-edit', onClick: stop },
                h('input', {
                  className: 'dm-hlui-note-input',
                  type: 'text',
                  value: noteDraft,
                  placeholder: '写点备注…',
                  'aria-label': '划线备注',
                  onChange: (event) => setNoteDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitNote(item);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelNote();
                    }
                  },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dm-hlui-note-save',
                    onClick: (event) => {
                      stop(event);
                      commitNote(item);
                    },
                  },
                  '保存',
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'dm-hlui-row__actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dm-hlui-act',
              title: '就这条问 AI',
              'aria-label': '就这条问 AI',
              disabled: !onAskAbout,
              onClick: ask,
            },
            h(Icon, { name: 'spark', size: 12 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dm-hlui-act dm-hlui-act--danger',
              title: '删除这条划线',
              'aria-label': '删除这条划线',
              disabled: !onDelete,
              onClick: remove,
            },
            h(Icon, { name: 'close', size: 12 }),
          ),
        ),
      );
    }

    /* ── render ────────────────────────────────────────────────────────── */

    return h(
      'div',
      { className: 'dm-hlui' },
      h(
        'div',
        { className: 'dm-hlui__head' },
        h(
          'button',
          {
            type: 'button',
            className: 'dm-hlui__toggle',
            'aria-expanded': open ? 'true' : 'false',
            title: open ? '收起划线列表' : '展开划线列表',
            onClick: () => setOpen((value) => !value),
          },
          h(
            'span',
            { className: cx('dm-hlui__twist', open && 'is-open') },
            h(Icon, { name: 'chevron', size: 12 }),
          ),
          h('span', { className: 'dm-hlui__title' }, '划线（' + items.length + '）'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dm-hlui__act',
            title: '让 AI 看看我划的这些',
            'aria-label': '让 AI 看看我划的这些',
            disabled: !onAskAll || items.length === 0,
            onClick: () => {
              if (onAskAll) onAskAll();
            },
          },
          h(Icon, { name: 'spark', size: 13 }),
        ),
      ),
      open
        ? h(
            'div',
            { className: 'dm-hlui__body' },
            items.length
              ? h(
                  'div',
                  { className: 'dm-hlui__filters', role: 'group', 'aria-label': '按类型筛选划线' },
                  filters.map((entry) =>
                    h(
                      'button',
                      {
                        key: entry.id,
                        type: 'button',
                        className: cx('dm-hlui-filter', filter === entry.id && 'is-active'),
                        'aria-pressed': filter === entry.id ? 'true' : 'false',
                        title: colorOf(entry.id).hint || entry.label,
                        onClick: () => setFilter(entry.id),
                      },
                      entry.label,
                      counts[entry.id] !== undefined
                        ? h('span', { className: 'dm-hlui-filter__n' }, String(counts[entry.id]))
                        : null,
                    ),
                  ),
                )
              : null,
            error ? h('div', { className: 'dm-hlui__error' }, error) : null,
            loading
              ? h(
                  'div',
                  { className: 'dm-hlui__state' },
                  h('span', { className: 'dm-spinner' }),
                  '正在读取划线…',
                )
              : null,
            !items.length && !loading && !error
              ? h(
                  'div',
                  { className: 'dm-hlui__empty' },
                  '选中正文，点浮条上的「划线」把它标下来',
                )
              : null,
            items.length && !visible.length
              ? h('div', { className: 'dm-hlui__empty' }, '这一类还没有划线')
              : null,
            visible.length
              ? h(
                  'div',
                  { className: 'dm-hlui__list dm-scroll', role: 'group', 'aria-label': '划线列表' },
                  visible.map(renderRow),
                )
              : null,
          )
        : null,
    );
  }

  /* ── stylesheet ──────────────────────────────────────────────────────── */

  const HighlightsCss = `
/* ── highlight list (56-highlights-ui.js) ─────────────────────────────── */
.dm-hlui {
  flex: 0 1 auto;
  min-height: 0;
  max-height: 42%;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--dm-line);
  background: var(--dm-bg-1);
}
.dm-hlui__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 7px 8px 5px;
}
.dm-hlui__toggle {
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
.dm-hlui__toggle:hover { background: var(--dm-bg-hover); color: var(--dm-text); }
.dm-hlui__toggle:focus-visible { outline: 2px solid var(--dm-accent); outline-offset: -2px; }
.dm-hlui__twist {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dm-text-3);
  transition: transform 120ms ease;
}
.dm-hlui__twist.is-open { transform: rotate(90deg); }
.dm-hlui__title { flex: none; }
.dm-hlui__act {
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
.dm-hlui__act:hover { background: var(--dm-bg-hover); color: var(--dm-text); }
.dm-hlui__act[disabled] { opacity: 0.35; cursor: default; }
.dm-hlui__act[disabled]:hover { background: transparent; color: var(--dm-text-3); }

.dm-hlui__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 0 6px 8px;
}
.dm-hlui__filters {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 2px 1px;
}
.dm-hlui-filter {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--dm-line);
  border-radius: 999px;
  background: transparent;
  color: var(--dm-text-3);
  font: inherit;
  font-size: 10.5px;
  line-height: 1;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.dm-hlui-filter:hover { background: var(--dm-bg-hover); color: var(--dm-text-2); }
.dm-hlui-filter:focus-visible { outline: 2px solid var(--dm-accent); outline-offset: -1px; }
.dm-hlui-filter.is-active {
  border-color: color-mix(in srgb, var(--dm-accent) 45%, var(--dm-line));
  background: var(--dm-accent-soft);
  color: var(--dm-accent);
}
.dm-hlui-filter__n { color: var(--dm-text-3); font-size: 9.5px; }
.dm-hlui-filter.is-active .dm-hlui-filter__n { color: var(--dm-accent); opacity: 0.8; }

.dm-hlui__list {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 1px 0 4px;
}
.dm-hlui-row {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 5px 6px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--dm-text-2);
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.dm-hlui-row:hover { background: var(--dm-bg-hover); }
.dm-hlui-row:focus-visible { outline: 2px solid var(--dm-accent); outline-offset: -2px; }
.dm-hlui-row.is-active {
  background: var(--dm-accent-soft);
  border-color: color-mix(in srgb, var(--dm-accent) 34%, transparent);
}
.dm-hlui-dot {
  flex: none;
  width: 7px;
  height: 7px;
  margin-top: 6px;
  border-radius: 50%;
  color: #fff;
}
.dm-hlui-dot--key { background: #e0a400; }
.dm-hlui-dot--question { background: #3a86ff; }
.dm-hlui-dot--review { background: #34a86c; }
.dm-hlui-row__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dm-hlui-row__text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--dm-text-2);
  font-size: 11.5px;
  line-height: 1.5;
  word-break: break-word;
}
.dm-hlui-row.is-active .dm-hlui-row__text { color: var(--dm-text); }
.dm-hlui-row__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 13px;
  color: var(--dm-text-3);
  font-size: 10px;
  line-height: 1.4;
}
.dm-hlui-row__time { flex: none; }
.dm-hlui-row__kind {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--dm-bg-2);
  color: var(--dm-text-3);
  font-size: 9.5px;
  line-height: 14px;
}
.dm-hlui-note-btn {
  flex: none;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dm-text-3);
  font: inherit;
  font-size: 10px;
  line-height: 1.4;
  cursor: pointer;
}
.dm-hlui-note-btn:hover { color: var(--dm-accent); }
.dm-hlui-row__note {
  margin-top: 2px;
  padding: 2px 6px;
  border-left: 2px solid var(--dm-line-2);
  border-radius: 0 5px 5px 0;
  background: var(--dm-bg-2);
  color: var(--dm-text-2);
  font-size: 10.5px;
  line-height: 1.55;
  word-break: break-word;
}
.dm-hlui-note-edit {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 3px;
}
.dm-hlui-note-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--dm-line);
  border-radius: 5px;
  background: var(--dm-bg);
  color: var(--dm-text);
  font: inherit;
  font-size: 11px;
  outline: none;
}
.dm-hlui-note-input:focus { border-color: var(--dm-accent); box-shadow: 0 0 0 2px var(--dm-accent-soft); }
.dm-hlui-note-input::placeholder { color: var(--dm-text-3); }
.dm-hlui-note-save {
  flex: none;
  height: 22px;
  padding: 0 7px;
  border: 0;
  border-radius: 5px;
  background: var(--dm-accent);
  color: var(--dm-on-accent);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.dm-hlui-note-save:hover { filter: brightness(1.06); }
.dm-hlui-row__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 1px;
  opacity: 0.5;
  transition: opacity 120ms ease;
}
.dm-hlui-row:hover .dm-hlui-row__actions,
.dm-hlui-row:focus-within .dm-hlui-row__actions,
.dm-hlui-row.is-active .dm-hlui-row__actions { opacity: 1; }
.dm-hlui-act {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--dm-text-3);
  cursor: pointer;
}
.dm-hlui-act:hover { background: var(--dm-bg-active); color: var(--dm-text); }
.dm-hlui-act--danger:hover { background: color-mix(in srgb, var(--dm-danger) 12%, transparent); color: var(--dm-danger); }
.dm-hlui-act[disabled] { opacity: 0.3; cursor: default; }
.dm-hlui-act[disabled]:hover { background: transparent; color: var(--dm-text-3); }
.dm-hlui__empty {
  padding: 8px 10px 12px;
  color: var(--dm-text-3);
  font-size: 11.5px;
  line-height: 1.7;
}
.dm-hlui__state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  color: var(--dm-text-3);
  font-size: 11.5px;
}
.dm-hlui__error {
  margin: 0 4px;
  padding: 6px 8px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--dm-danger) 9%, transparent);
  color: var(--dm-danger);
  font-size: 11.5px;
  line-height: 1.55;
  word-break: break-word;
}
`;

  return { HighlightList: HighlightList, HighlightsCss: HighlightsCss };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createHighlightsUi };
