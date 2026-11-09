/* ===== 00-head.js ===== */
/* DocMate client half.
 *
 * Loaded by the Harness Web page through `window.__ModuleLoader__.load`, exactly like the
 * shipped decoration template: the factory runs at materialisation time and returns the
 * plugin face `{ inject, apply }`. No JSX, no bundler, no Harness client package imports —
 * `react` is the only module we take from the browser module table.
 *
 * Seats taken:
 *   · `sidebar.panellist` — the left-rail entry; clicking it makes the shell call
 *     `ctx.layout.selectPanel('docmate')`.
 *   · `main` (keyed, key `docmate`) — the whole centre panel: document tree, viewer, chat.
 *
 * The chat column embeds a *real* Harness session (SessionProvider + the
 * `conversation.content` factory slot), so streaming, tool cards, approvals and history all
 * come from the host. Our own code only adds the reading surface and the selection bridge.
 */

const PANEL_ID = 'docmate';
const API = '/api/docmate';
const LS_ROOT = 'docmate.root';
const LS_SESSION = 'docmate.session';
const LS_WIDTHS = 'docmate.widths';
