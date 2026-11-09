/* ===== 50-docs.js ===== */
/**
 * The centre reading surface.
 *
 * One `DocBody` per pane. It owns only the fetch of one document and hands the rendered
 * result to the caller; selection gestures are owned by the app shell, which listens on the
 * `[data-dm-viewer]` container these components render.
 */
function createDocs(React, util, markdownModule, pdfModule, mathModule) {
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;
  const { cx, Icon, api, extOf } = util;

  const Markdown = markdownModule && markdownModule.Markdown ? markdownModule.Markdown : null;
  const PdfViewer = pdfModule && pdfModule.PdfViewer ? pdfModule.PdfViewer : null;

  function docKind(doc) {
    const ext = doc && doc.ext ? String(doc.ext).toLowerCase() : '';
    if (ext === 'pdf') return 'pdf';
    if (ext === 'docx') return 'docx';
    if (ext === 'md' || ext === 'markdown') return 'markdown';
    if (ext === 'html' || ext === 'htm') return 'text';
    return 'text';
  }

  function DocBody(props) {
    const doc = props.doc;
    const viewerRef = props.viewerRef;
    const onStatus = props.onStatus;
    const [state, setState] = useState({ phase: 'idle', error: null, text: '', html: '', url: '' });
    const bodyRef = useRef(null);

    /* 公式排版：markdown 渲染器只留下 `[data-tex]` 占位，这里在每次提交后把还没排过的
     * 交给 KaTeX。跑在「每次渲染之后」是有意的——划线、切换文档、重排都可能让 React
     * 重建节点，而排过的节点带 `data-tex-done`，重复调用只是一次 querySelectorAll。 */
    useEffect(() => {
      if (!mathModule || state.phase !== 'ready') return undefined;
      const node = bodyRef.current;
      if (!node) return undefined;
      let cancelled = false;
      mathModule
        .ensure()
        .then(() => {
          if (!cancelled && bodyRef.current) mathModule.renderIn(bodyRef.current);
        })
        .catch(() => {
          /* 没有公式引擎时保留等宽原文，不打断阅读 */
        });
      return () => {
        cancelled = true;
      };
    });

    useEffect(() => {
      if (!doc) {
        setState({ phase: 'idle', error: null, text: '', html: '', url: '' });
        return undefined;
      }
      let cancelled = false;
      let objectUrl = '';
      const kind = docKind(doc);
      setState({ phase: 'loading', error: null, text: '', html: '', url: '' });
      if (onStatus) onStatus({ phase: 'loading' });

      const query = '?id=' + encodeURIComponent(doc.id);

      async function load() {
        try {
          if (kind === 'pdf') {
            const response = await fetch(API + '/doc/raw' + query);
            if (!response.ok) throw new Error('读取 PDF 失败：HTTP ' + response.status);
            const blob = await response.blob();
            objectUrl = URL.createObjectURL(blob);
            if (cancelled) return;
            setState({ phase: 'ready', error: null, text: '', html: '', url: objectUrl });
            if (onStatus) onStatus({ phase: 'ready' });
            return;
          }
          if (kind === 'docx') {
            const payload = await api('/doc/docx' + query);
            if (cancelled) return;
            setState({ phase: 'ready', error: null, text: '', html: payload.html || '', url: '' });
            if (onStatus) onStatus({ phase: 'ready', warnings: payload.warnings || [] });
            return;
          }
          const response = await fetch(API + '/doc/raw' + query);
          if (!response.ok) throw new Error('读取文件失败：HTTP ' + response.status);
          const text = await response.text();
          if (cancelled) return;
          setState({ phase: 'ready', error: null, text, html: '', url: '' });
          if (onStatus) onStatus({ phase: 'ready' });
        } catch (error) {
          if (cancelled) return;
          const message = String((error && error.message) || error);
          setState({ phase: 'error', error: message, text: '', html: '', url: '' });
          if (onStatus) onStatus({ phase: 'error', error: message });
        }
      }

      load();
      return () => {
        cancelled = true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }, [doc && doc.id]);

    if (!doc) return null;

    if (state.phase === 'loading') {
      return h(
        'div',
        { className: 'dm-doc__scroll dm-scroll', 'data-dm-viewer': '1', ref: viewerRef },
        h('div', { className: 'dm-loading' }, h('span', { className: 'dm-spinner' }), '正在打开 ' + doc.name),
      );
    }

    if (state.phase === 'error') {
      return h(
        'div',
        { className: 'dm-doc__scroll dm-scroll', 'data-dm-viewer': '1', ref: viewerRef },
        h(
          'div',
          { className: 'dm-error' },
          h('div', { className: 'dm-error__title' }, '打不开这个文档'),
          h('div', null, state.error),
        ),
      );
    }

    const kind = docKind(doc);

    if (kind === 'pdf') {
      if (!PdfViewer) {
        return h(
          'div',
          { className: 'dm-doc__scroll dm-scroll', 'data-dm-viewer': '1' },
          h('div', { className: 'dm-error' }, 'PDF 阅读器模块没加载（40-pdf.js）'),
        );
      }
      return h(
        'div',
        { className: 'dm-doc', 'data-dm-viewer': '1', ref: viewerRef },
        h(PdfViewer, { url: state.url, pageJump: props.pageJump, onOutline: props.onOutline }),
      );
    }

    if (kind === 'docx') {
      return h(
        'div',
        { className: 'dm-doc__scroll dm-scroll', 'data-dm-viewer': '1', ref: viewerRef },
        h(
          'div',
          { className: 'dm-paper' },
          h('div', {
            className: 'dm-prose dm-docx',
            // The markup is produced by our own Host-side converter, which escapes every
            // text node and only ever emits the tags listed in src/host/docx.js.
            dangerouslySetInnerHTML: { __html: state.html },
          }),
        ),
      );
    }

    return h(
      'div',
      { className: 'dm-doc__scroll dm-scroll', 'data-dm-viewer': '1', ref: viewerRef },
      h(
        'div',
        { className: 'dm-paper', ref: bodyRef },
        kind === 'markdown' && Markdown
          ? h(Markdown, { source: state.text, className: 'dm-prose' })
          : h('pre', { className: 'dm-plain' }, state.text),
      ),
    );
  }

  return { DocBody, docKind };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createDocs };
