/* ===== 99-tail.js ===== */
/**
 * Wiring. Everything above this file is a factory that takes `React` and returns
 * components; this is the only place that touches the Cordis context.
 */
function createPlugin(React) {
  const util = createUtil(React);

  // Optional modules: each is authored in its own fragment and may be absent while the
  // plugin is being built. A missing one degrades that part only — never the panel.
  const markdownModule = typeof createMarkdown === 'function' ? createMarkdown(React) : null;
  const pdfModule = typeof createPdfViewer === 'function' ? createPdfViewer(React) : null;
  const mathModule = typeof createMath === 'function' ? createMath(util) : null;
  const findModule = typeof createFind === 'function' ? createFind(React, util) : null;
  const shotModule = typeof createShot === 'function' ? createShot(util) : null;
  const panesModule = typeof createPanes === 'function' ? createPanes(React, util) : null;
  const workspaceModule =
    typeof createWorkspace === 'function'
      ? createWorkspace(React, util)
      : {
          DocList: () => null,
          MemoryPanel: () => null,
          DropOverlay: () => null,
          css: '',
        };

  const docsModule = createDocs(React, util, markdownModule, pdfModule, mathModule);
  const chatModule = createChat(React, util);
  const highlightsModule = typeof createHighlights === 'function' ? createHighlights(React, util) : null;
  const highlightsUiModule = typeof createHighlightsUi === 'function' ? createHighlightsUi(React, util) : null;
  const app = createApp(
    React,
    util,
    docsModule,
    chatModule,
    workspaceModule,
    pdfModule,
    highlightsModule,
    highlightsUiModule,
    findModule,
    shotModule,
    panesModule,
  );
  const highlightsCss = (highlightsModule && highlightsModule.css) || '';
  const highlightsUiCss = (highlightsUiModule && highlightsUiModule.HighlightsCss) || '';
  const findCss = (findModule && findModule.css) || '';
  const shotCss = (shotModule && shotModule.css) || '';
  const panesCss = (panesModule && panesModule.css) || '';

  function service(ctx, name) {
    // `ctx.get(name)` is the documented lookup, but a service that was not declared in
    // `inject` is also reachable as a plain property on the context. Try both: the panel
    // degrades to a readable notice instead of silently losing the chat column.
    try {
      const value = ctx.get(name);
      if (value) return value;
    } catch (error) {
      /* fall through */
    }
    try {
      return ctx[name] || null;
    } catch (error) {
      return null;
    }
  }

  return {
    // `slots` is where we draw; `sessions` is the Client service that lets the chat column
    // retain and embed a real Harness session. Both must be declared: in this Host a
    // service that was not injected throws on property access instead of reading undefined.
    inject: ['slots', 'sessions'],
    apply(ctx) {
      chatModule.setHostServices({
        sessions: service(ctx, 'sessions'),
      });

      // One stylesheet for the whole panel, owned by the plugin fiber so unloading the
      // plugin removes it with everything else.
      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-dsh-docmate', '1');
        style.textContent = createCss() + (workspaceModule.css || '') + highlightsCss + highlightsUiCss + findCss + shotCss + panesCss;
        document.head.appendChild(style);
        return () => {
          style.remove();
        };
      }, 'docmate: stylesheet');

      // The centre panel. The `children` table is load-bearing: the framework only hands a
      // `SessionProvider` to an entry that declares at least one non-root child seat, and
      // the chat column needs it to render the host conversation.
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            children: { 'docmate.ask.session': { kind: 'single', scope: 'session' } },
          },
          app.DocMateApp,
        ),
      );

      // The left-rail entry. The shell owns the click: it calls
      // `ctx.layout.selectPanel('docmate')`, which is exactly the key registered above.
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 45,
            label: '伴读',
          },
          app.DocMateIcon,
        ),
      );
    },
  };
}
