/* ===== 60-chat.js ===== */
/**
 * The right-hand companion column.
 *
 * It does **not** implement a chat. It embeds one: a real Harness Session is retained
 * through the Client `sessions` service and rendered with the host's own
 * `conversation.content` factory slot inside the framework-supplied `SessionProvider`.
 * Streaming, tool cards, approvals, the composer, history and persistence therefore all
 * come from the Harness — this file only owns the frame around them and the "pending
 * selection" strip that turns a highlight into a question.
 */
function createChat(React, util) {
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;
  const { cx, Icon, oneLine, api } = util;

  /** Filled from `apply` — the Client services the panel needs at render time. */
  const Host = { sessions: null, uiWorkspace: null };

  function setHostServices(services) {
    Host.sessions = services && services.sessions ? services.sessions : null;
    Host.uiWorkspace = services && services.uiWorkspace ? services.uiWorkspace : null;
  }

  function getUiWorkspace() {
    return Host.uiWorkspace;
  }

  function hasSessions() {
    return !!(Host.sessions && typeof Host.sessions.retain === 'function');
  }

  /**
   * 空白会话的起手牌。空面板是最糟的第一印象——用户打开文档只看到一片黑，不知道该问
   * 什么。三张牌都指向「这篇文档」而不是泛泛的聊天，点一下就直接发出去。
   * 问句都按「短回答」写：用户要的是快速回馈，不是一屏讲义。
   */
  const STARTERS = [
    {
      id: 'structure',
      label: '先看整体结构',
      question: '3 句话概括这篇文档，再列章节结构。',
    },
    {
      id: 'key',
      label: '这一节要记什么',
      question: '我现在读的这一节，必须记住的是什么？最多 3 条。',
    },
    {
      id: 'quiz',
      label: '出几道自测',
      question: '根据这篇文档出 3 道自测题，每题附一行答案。',
    },
  ];

  /**
   * 快速识图的刹车提示。
   *
   * 刹车本身在 Host 半：限步、限 token、拒工具、超时取消真实 turn。被拦下时这一轮以
   * `blocked` 结束，会话里不会留下任何解释——所以面板自己轮询 `GET /guard`，把
   * 「为什么停了、花了多少」讲清楚。**不能静默消失**，也不能假装什么都没发生。
   */
  const GUARD_TEXT = {
    steps: '识图轮次被刹住了：还没收住就跑到第 3 步，我没有再往下跑。',
    tokens: '识图轮次被刹住了：这一轮新增 token 已经超过预算。',
    timeout: '识图轮次被刹住了：45 秒还没答完，我把这一轮停了。',
    'max-tokens': '回答被单步输出上限截断了。',
    aborted: '这一轮被取消了。',
    error: '这一轮出错了。',
    'prompt-failed': '消息没发出去。',
  };

  function guardText(guard) {
    const reason = guard && guard.reason;
    const base = GUARD_TEXT[reason] || '识图轮次被刹住了。';
    if (reason !== 'max-tokens') return base;
    const limit = guard && guard.limits && guard.limits.maxOutputTokens;
    return limit ? '回答被单步输出上限截断了（' + limit + ' token）。' : base;
  }

  function shortTokens(value) {
    const number = Number(value) || 0;
    if (number >= 1000) return (number / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(number);
  }

  function guardStats(guard) {
    const usage = (guard && guard.usage) || {};
    const parts = [];
    if (guard && guard.steps) parts.push(guard.steps + ' 步');
    if (guard && guard.calls) parts.push(guard.calls + ' 次模型调用');
    if (usage.billed) parts.push(shortTokens(usage.billed) + ' token');
    if (guard && guard.denied) parts.push('拦下 ' + guard.denied + ' 次工具');
    if (guard && guard.elapsedMs) parts.push(Math.max(1, Math.round(guard.elapsedMs / 1000)) + 's');
    return parts.join(' · ');
  }

  function ChatPanel(props) {
    const sessionId = props.sessionId;
    const hostKit = props.hostKit;
    const pending = props.pending;
    const busy = props.busy;
    const error = props.error;
    const onSend = props.onSend;
    const onCancelPending = props.onCancelPending;
    const onNewSession = props.onNewSession;
    const [held, setHeld] = useState(null);
    const [draft, setDraft] = useState('');
    const inputRef = useRef(null);
    const [guard, setGuard] = useState(null);
    const guardSeenRef = useRef('');

    /* Retain exactly the session we render. Releasing on unmount / switch is what lets the
     * Host retire the generation; forgetting it leaks a retained reference forever. */
    useEffect(() => {
      if (!sessionId) {
        setHeld(null);
        return undefined;
      }
      const sessions = Host.sessions;
      if (!sessions || typeof sessions.retain !== 'function') {
        setHeld(null);
        return undefined;
      }
      let reference = null;
      let cancelled = false;
      try {
        reference = sessions.retain(sessionId, { source: 'docmate' });
      } catch (failure) {
        setHeld(null);
        if (props.onRetainFailed) props.onRetainFailed(String((failure && failure.message) || failure));
        return undefined;
      }
      // `retain()` hands back the reference immediately but the binding is only usable once
      // its initial history open settles. Rendering the host conversation before that makes
      // it look up a session the Client generation has not registered yet
      // ("uiConversation.binding: unknown session"), so wait for `ready` first.
      const ready = reference && reference.ready;
      if (ready && typeof ready.then === 'function') {
        ready.then(
          () => {
            if (!cancelled) setHeld({ id: sessionId, reference });
          },
          (failure) => {
            if (cancelled) return;
            setHeld(null);
            if (props.onRetainFailed) props.onRetainFailed(String((failure && failure.message) || failure));
          },
        );
      } else {
        setHeld({ id: sessionId, reference });
      }
      return () => {
        cancelled = true;
        // Release one tick later: the host conversation unmounts during this same commit,
        // and dropping the retained generation first makes it re-bind against a session the
        // Client no longer knows ("uiConversation.binding: unknown session").
        const releasing = reference;
        window.setTimeout(() => {
          try {
            if (releasing && typeof releasing.release === 'function') releasing.release();
          } catch (ignored) {
            /* the Host may already have dropped this generation */
          }
        }, 1500);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

    useEffect(() => {
      if (pending && inputRef.current) {
        try {
          inputRef.current.focus();
        } catch (ignored) {
          /* focus is a nicety */
        }
      }
    }, [pending]);

    /* 发出去之后盯一会儿这一轮的刹车状态。
     * `busy` 只覆盖「消息被接纳」那一小段（几十毫秒），所以用它的下降沿当发车信号，
     * 之后自己轮询 90 秒——足够覆盖 45 秒超时 + 收尾。 */
    const wasBusyRef = useRef(false);
    useEffect(() => {
      const was = wasBusyRef.current;
      wasBusyRef.current = !!busy;
      if (was === !!busy || busy || !sessionId) return undefined;
      let stopped = false;
      let timer = 0;
      const deadline = Date.now() + 90000;
      const poll = () => {
        if (stopped) return;
        api('/guard?session=' + encodeURIComponent(sessionId)).then(
          (payload) => {
            if (stopped) return;
            const next = payload && payload.guard ? payload.guard : null;
            if (next && next.state && next.state !== 'unknown') {
              if (next.state === 'tripped' && next.id !== guardSeenRef.current) {
                guardSeenRef.current = next.id;
                setGuard(next);
                return;
              }
              if (next.state === 'done') guardSeenRef.current = next.id;
            }
            if (Date.now() < deadline) timer = window.setTimeout(poll, 2000);
          },
          () => {
            if (!stopped && Date.now() < deadline) timer = window.setTimeout(poll, 3000);
          },
        );
      };
      timer = window.setTimeout(poll, 1200);
      return () => {
        stopped = true;
        window.clearTimeout(timer);
      };
    }, [busy, sessionId]);

    const live = held && held.id === sessionId ? held : null;
    const canEmbed = !!(hostKit && hostKit.SessionProvider && hostKit.renderFactorySlot);
    const sessionsReady = hasSessions();

    function submitDraft() {
      const question = draft.trim();
      if (!question || busy) return;
      setDraft('');
      onSend({ question, quote: pending });
    }

    return h(
      'aside',
      { className: 'dm-chat', 'aria-label': '伴随 AI 聊天' },
      h(
        'div',
        { className: 'dm-chat__head' },
        h('span', { className: 'dm-chat__dot' }),
        h(
          'span',
          { className: 'dm-chat__title' },
          '伴随 AI',
          props.docName ? h('span', { className: 'dm-chat__doc', title: props.docName }, props.docName) : null,
        ),
        h('span', { className: 'dm-spacer' }),
        onNewSession
          ? h(
              'button',
              {
                type: 'button',
                className: 'dm-btn dm-btn--icon',
                title: '新对话（另起一条会话）',
                onClick: onNewSession,
              },
              h(Icon, { name: 'plus' }),
            )
          : null,
      ),

      pending
        ? h(
            'div',
            { className: 'dm-chat__quote' },
            pending.shot
              ? h('img', { className: 'dm-chat__quote-shot', src: pending.shot.data, alt: '框选的截图' })
              : h(Icon, { name: 'quote', size: 14 }),
            h(
              'div',
              { className: 'dm-chat__quote-text' },
              pending.shot ? '框选的截图' : oneLine(pending.text, 400),
              h(
                'span',
                { className: 'dm-chat__quote-src' },
                '来自 ' + (pending.docName || '文档') + (pending.page ? ' · 第 ' + pending.page + ' 页' : ''),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dm-btn dm-btn--icon',
                title: '取消引用',
                onClick: onCancelPending,
              },
              h(Icon, { name: 'close', size: 14 }),
            ),
          )
        : null,

      h(
        'div',
        { className: 'dm-chat__body' },
        guard
          ? h(
              'div',
              {
                className: 'dm-chat__guard',
                role: 'status',
                style: {
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '8px',
                  margin: '0 0 8px',
                  padding: '8px 10px',
                  borderRadius: '8px',
                  border: '1px solid var(--dm-line)',
                  background: 'var(--dm-bg-1)',
                  color: 'var(--dm-text-2)',
                  fontSize: '11.5px',
                  lineHeight: '1.55',
                },
              },
              h(Icon, { name: 'spark', size: 13 }),
              h(
                'div',
                { style: { flex: '1 1 auto', minWidth: 0 } },
                h('div', { style: { color: 'var(--dm-text)', fontWeight: 600 } }, guardText(guard)),
                guardStats(guard)
                  ? h('div', { style: { marginTop: '2px', color: 'var(--dm-text-3)' } }, guardStats(guard))
                  : null,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dm-btn dm-btn--icon',
                  title: '知道了',
                  onClick: () => setGuard(null),
                },
                h(Icon, { name: 'close', size: 13 }),
              ),
            )
          : null,
        error
          ? h('div', { className: 'dm-chat__notice' }, h('b', null, '伴随聊天暂时不可用'), h('div', null, error))
          : null,
        !canEmbed
          ? h(
              'div',
              { className: 'dm-chat__notice' },
              h('b', null, '这个宿主没有把会话正文交给插件'),
              h('div', null, '面板需要 SessionProvider + renderFactorySlot 才能嵌入真实会话。'),
            )
          : !sessionsReady
            ? h(
                'div',
                { className: 'dm-chat__notice' },
                h('b', null, '拿不到会话服务'),
                h('div', null, '这个宿主没有把 sessions 交给插件，伴随聊天嵌不进来；左侧阅读区仍然可用。'),
              )
            : live
            ? h(
                React.Fragment,
                null,
                props.starter
                  ? h(
                      'div',
                      { className: 'dm-chat__starter' },
                      h(
                        'div',
                        { className: 'dm-chat__starter-title' },
                        props.docHasText === false ? '这篇没有文字层，框一块给我' : '我已经把整篇读完了',
                      ),
                      h(
                        'div',
                        { className: 'dm-chat__starter-hint' },
                        props.docHasText === false
                          ? '扫描件 / 图片划不了词：点下面的按钮，在正文里拖一个框，我就看图回答。'
                          : '选中正文任意一段，可以让我解释 / 总结 / 翻译；划下的线会一直留着。',
                      ),
                      props.docHasText === false
                        ? h(
                            'div',
                            { className: 'dm-chat__starter-chips' },
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dm-chat__chip',
                                disabled: busy,
                                onClick: () => {
                                  if (typeof props.onStartShot === 'function') props.onStartShot();
                                },
                              },
                              '开始框选',
                            ),
                          )
                        : h(
                            'div',
                            { className: 'dm-chat__starter-chips' },
                            STARTERS.map((item) =>
                              h(
                                'button',
                                {
                                  key: item.id,
                                  type: 'button',
                                  className: 'dm-chat__chip',
                                  disabled: busy,
                                  onClick: () => onSend({ question: item.question, quote: null }),
                                },
                                item.label,
                              ),
                            ),
                          ),
                    )
                  : null,
                h(
                  'div',
                  { className: 'dm-chat__host' },
                  h(
                    hostKit.SessionProvider,
                    { session: live.reference },
                    hostKit.renderFactorySlot('conversation.content', {
                      variant: 'embedded',
                      phase: 'active',
                      hero: false,
                    }),
                  ),
                ),
              )
            : h(
                'div',
                { className: 'dm-chat__notice' },
                h('span', { className: 'dm-spinner' }),
                ' 正在准备伴随会话…',
              ),
      ),

      pending
        ? h(
            'div',
            { className: 'dm-chat__ask' },
            h('input', {
              ref: inputRef,
              className: 'dm-chat__ask-input',
              placeholder: pending.shot ? '就这张图问点什么，回车发送…' : '就这段内容问点什么，回车发送…',
              value: draft,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submitDraft();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onCancelPending();
                }
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dm-btn dm-btn--solid',
                onClick: submitDraft,
                disabled: busy || draft.trim() === '',
              },
              h(Icon, { name: 'send', size: 14 }),
            ),
          )
        : null,
    );
  }

  return { ChatPanel, setHostServices, getUiWorkspace, hasSessions };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createChat };
