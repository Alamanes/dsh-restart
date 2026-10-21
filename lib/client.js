/**
 * dsh-restart — browser half.
 *
 * One surface: a small restart control parked in the top-right corner of the
 * frame, just left of the built-in right-panel toggle.
 *
 * Why `shell.overlay`: the conversation header seats only exist once a session
 * is open. A brand-new chat renders `headerBlank headerSessionless`, which
 * keeps the corner seat and the leading seat but not `header.utilities`, so a
 * control registered in `conversation.session.header.utilities` never appears
 * on the first screen. The overlay layer is mounted by the frame itself, is
 * present on every route, and its children are laid out in frame coordinates.
 *
 * The button owns no restart logic. It posts the current session id to the
 * host half and waits: roughly a second later the whole app goes away, so the
 * only durable state is the host's pending-session file.
 *
 * @module dsh-restart/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-restart',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Locale namespace for this plugin's copy; also the slot registration's `locale`. */
    const NS = 'dsh-restart'

    /** Host route that schedules the quit-and-relaunch. */
    const RESTART_ROUTE = '/dsh-restart/restart'

    /** Copy, in the shape `ctx.locale.register` takes. */
    const zh = {
      'button.label': '彻底重启 DSH',
      'button.pending': '正在关闭并重新启动…',
      'failed.network': '请求发不出去，重启未开始。',
      'failed.desktop': '当前不是桌面应用宿主，无法重启。',
      'failed.generic': '重启失败，请重试。',
    }
    const en = {
      'button.label': 'Restart DSH',
      'button.pending': 'Quitting and relaunching…',
      'failed.network': 'The request could not be sent; nothing was restarted.',
      'failed.desktop': 'This process is not the desktop app host, so it cannot restart.',
      'failed.generic': 'Restart failed. Try again.',
    }

    /** Stylesheet for the one plugin-owned control. */
    const STYLESHEET = `
.dsh-restart-seat { position: absolute; top: 11px; right: 48px; z-index: 1; display: flex; align-items: center; -webkit-app-region: no-drag; }
.dsh-restart-button { width: 28px; height: 28px; color: var(--dsw-alias-label-secondary); flex: none; padding: 0; }
.dsh-restart-button svg { width: 15px; height: 15px; }
.dsh-restart-button:disabled { opacity: .6; }
.dsh-restart-spin { animation: dsh-restart-spin .9s linear infinite; }
@keyframes dsh-restart-spin { to { transform: rotate(360deg); } }
`

    /**
     * The restart control.
     *
     * @param props - the restart hop from the host half, and the locale seat.
     * @returns the icon button seated in the frame's top-right corner.
     */
    function RestartButton({ restart, t }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      const press = () => {
        if (busy) return
        setBusy(true)
        setError(null)
        restart().catch((reason) => {
          setBusy(false)
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }

      const label = busy ? t('button.pending') : error !== null ? error : t('button.label')
      return h(
        'div',
        { className: 'dsh-restart-seat' },
        h(
          primitives.Tooltip,
          { label, side: 'bottom', delayMs: 400 },
          h(
            primitives.Button,
            {
              size: 'sm',
              className: 'dsh-restart-button',
              'aria-label': t('button.label'),
              disabled: busy,
              onClick: press,
            },
            h(primitives.IconRefreshOutlineRegular, { size: 15, className: busy ? 'dsh-restart-spin' : undefined }),
          ),
        ),
      )
    }

    /**
     * Install the surface.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-restart: dictionaries')

      const style = document.createElement('style')
      style.setAttribute('data-dsh-restart', '')
      style.textContent = STYLESHEET
      ctx.effect(() => {
        document.head.append(style)
        return () => style.remove()
      }, 'dsh-restart: stylesheet')

      /** The session currently occupying the main view, if any. */
      const currentSessionId = () => {
        try {
          return ctx.uiSession?.current?.getSnapshot?.()?.key
        } catch {
          return undefined
        }
      }

      /**
       * Ask the host to quit and relaunch the app.
       *
       * @returns resolution once the host accepted the request.
       * @throws when the request could not be sent or the host refused it.
       */
      const restart = async () => {
        const bind = ctx.locale.bind(NS)
        let response
        try {
          response = await fetch(RESTART_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSessionId() }),
            credentials: 'same-origin',
          })
        } catch {
          throw new Error(bind('failed.network'))
        }

        let payload = null
        try {
          payload = await response.json()
        } catch {
          // A body-less failure keeps its status-only verdict below.
        }

        if (!response.ok || payload === null || payload.ok !== true) {
          throw new Error(payload !== null && payload.reason === 'not-desktop' ? bind('failed.desktop') : bind('failed.generic'))
        }
        return payload
      }

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-restart.seat',
        order: 100,
        locale: NS,
        inject: () => ({ restart }),
      }, RestartButton))
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale', 'uiSession']
    return module.exports
  },
})
