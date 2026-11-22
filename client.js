/**
 * Composer switch for the per-session Computer Use grant.
 *
 * The host half (`index.js`) denies the `js` tool unless the session opted in;
 * this is the only place that opt-in can happen, so the control has to be
 * reachable from the conversation the user is looking at rather than from
 * Settings (a setting would be profile-wide, and the whole point is that a new
 * session starts with the desktop untouched).
 *
 * The state lives on the Host, not in the browser: two windows on the same
 * session must agree, and a reload must not silently re-grant. So the switch
 * reads and writes `GET/POST /plugins/dsh-zcode-cua/access` and keeps only a
 * display copy.
 *
 * Styling follows the host: no Harness client package is imported (that is
 * forbidden for plugins), only the theme's alias tokens, so the control tracks
 * light and dark like everything beside it.
 *
 * @module dsh-zcode-cua/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-zcode-cua',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ACCESS_PATH = '/plugins/dsh-zcode-cua/access';

    /** Endpoint URL for one session. */
    function accessUrl(sessionId) {
      return `${ACCESS_PATH}?session=${encodeURIComponent(sessionId)}`;
    }

    async function readGrant(sessionId, signal) {
      const response = await fetch(accessUrl(sessionId), {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error(`host answered ${response.status}`);
      const body = await response.json();
      return body?.granted === true;
    }

    async function writeGrant(sessionId, granted, signal) {
      const response = await fetch(accessUrl(sessionId), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ granted }),
        signal,
      });
      if (!response.ok) throw new Error(`host answered ${response.status}`);
      const body = await response.json();
      return body?.granted === true;
    }

    /**
     * The switch.
     *
     * Three states are visible, because "off" and "could not ask" must not look
     * alike: a switch that silently reads as off when the host route failed
     * would make the user click a control that does nothing.
     *
     *   off      — the tool is denied for this session
     *   on       — the tool may run in this session
     *   unknown  — the host has not answered yet (loading, or the route failed)
     */
    function AccessToggle(props) {
      const sessionId = props.sessionId;
      const [granted, setGranted] = React.useState(false);
      const [known, setKnown] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState('');

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        const controller = new AbortController();
        let live = true;
        readGrant(sessionId, controller.signal)
          .then((value) => {
            if (!live) return;
            setGranted(value);
            setKnown(true);
            setFailure('');
          })
          .catch((error) => {
            if (!live || controller.signal.aborted) return;
            setKnown(false);
            setFailure(String(error?.message ?? error));
          });
        return () => {
          live = false;
          controller.abort();
        };
      }, [sessionId]);

      const toggle = React.useCallback(() => {
        if (typeof sessionId !== 'string' || sessionId === '' || busy) return;
        const next = !granted;
        setBusy(true);
        setFailure('');
        writeGrant(sessionId, next)
          .then((value) => {
            setGranted(value);
            setKnown(true);
          })
          .catch((error) => {
            setKnown(false);
            setFailure(String(error?.message ?? error));
          })
          .finally(() => setBusy(false));
      }, [sessionId, granted, busy]);

      const usable = typeof sessionId === 'string' && sessionId !== '';
      const label = !known
        ? '电脑控制 · 状态未知'
        : granted
          ? '电脑控制 · 已开启'
          : '电脑控制 · 已关闭';
      const title = !usable
        ? '这个会话还没有 id，无法记录开关状态。'
        : failure !== ''
          ? `无法读写开关状态：${failure}`
          : granted
            ? '本会话可以操作桌面（点击、打字、截图）。点一下关闭。'
            : '本会话不能操作桌面。点一下开启；只对这个会话有效，DSH 重启后回到关闭。';

      // Colour comes from the token as TEXT, never as a fill behind white text.
      // `--dsw-alias-brand-primary` is a near-white accent in the dark theme, so
      // filling the pill with it and writing white on top made the label vanish
      // — measured on a real host, not guessed. Keeping the background
      // transparent and tinting the border, dot and label works in both themes,
      // because each token is defined per theme.
      const accent = granted
        ? 'var(--dsw-alias-brand-primary)'
        : 'var(--dsw-alias-label-secondary)';
      const border = granted
        ? 'var(--dsw-alias-brand-primary)'
        : 'var(--dsw-alias-border-l1)';
      const dot = granted
        ? 'var(--dsw-alias-state-success-primary)'
        : 'var(--dsw-alias-state-idle-primary)';

      return h(
        'button',
        {
          type: 'button',
          onClick: toggle,
          disabled: !usable || busy,
          title,
          'aria-pressed': granted,
          'data-dsh-zcode-cua-access': known ? (granted ? 'on' : 'off') : 'unknown',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 26,
            padding: '0 10px',
            margin: 0,
            border: `1px solid ${border}`,
            borderRadius: 999,
            background: 'transparent',
            color: accent,
            font: 'inherit',
            fontSize: 12,
            lineHeight: 1,
            cursor: usable && !busy ? 'pointer' : 'not-allowed',
            opacity: busy ? 0.6 : known ? 1 : 0.75,
            whiteSpace: 'nowrap',
            userSelect: 'none',
          },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: dot,
            flex: '0 0 auto',
          },
        }),
        label,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              // After the credits readouts (10) and the CLI live row (11): this
              // is a permission control, and it should sit at the far end of the
              // row rather than between two readouts.
              id: 'dsh-zcode-cua-access',
              order: 12,
            },
            AccessToggle,
          ),
        );
      },
    };
  },
});
