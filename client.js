/**
 * Browser half of the Polymarket Proxy panel.
 *
 * Registers the left-sidebar panel entry and the `main` page, reads the Host
 * snapshot over `/api/polymarket-agent/*`, and places guarded live orders and
 * position closes through the Host bridge. Positions and in-progress orders
 * have their own views; the radar list is filtered by category chips, and a
 * pasted polymarket.com event/market link is resolved by the Host and pinned
 * to the top of the list. Interface and market-title language follow the
 * DeepSeek Harness locale: Chinese for a Chinese UI, English otherwise.
 */
window.__ModuleLoader__.load({
  id: 'dsh-polymarket-proxy',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'polyAgent'
    const PANEL_ID = 'polymarket-agent'
    const API = '/api/polymarket-agent'
    // Exact registration URL, including its own referral query. Keep it out of
    // polyLink(), which would append a second `via` parameter.
    const REGISTER_URL = 'https://polymarket.com/perps?via=dEz1eSn'
    // Preview switch for an already-configured profile. It only affects the
    // guide shown when the Polymarket panel is opened; normal starts stay silent.
    const FORCE_GUIDE = (() => {
      try {
        return new URLSearchParams(window.location.search).get('polyGuide') === '1'
      } catch {
        return false
      }
    })()

    let translate = (key) => key
    const t = (key, params) => translate(key, params)

    // ------------------------------------------------------------- helpers

    const pct = (x, digits = 1) => `${(Number(x) * 100).toFixed(digits)}%`
    const cents = (x, digits = 1) => `${(Number(x) * 100).toFixed(digits)}¢`
    // Exchange prices often sit on a sub-cent tick; drop trailing zeros so a
    // 48¢ quote reads as 48¢ instead of 48.0¢ while 48.5¢ stays precise.
    const priceCents = (x) => {
      const n = Number(x)
      if (!Number.isFinite(n) || n <= 0) return '—'
      const value = n * 100
      const digits =
        Math.abs(value - Math.round(value)) < 1e-9 ? 0 : Math.abs(value * 10 - Math.round(value * 10)) < 1e-9 ? 1 : 2
      return `${value.toFixed(digits)}¢`
    }
    const usd = (x) => {
      const n = Number(x)
      if (!Number.isFinite(n)) return '—'
      return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    }
    const money = (x) => {
      const n = Number(x) || 0
      if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
      if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}k`
      return `$${n.toFixed(0)}`
    }
    const signed = (x) => `${Number(x) >= 0 ? '+' : ''}${Number(x).toFixed(2)}`
    const dateOnly = (iso) => String(iso ?? '').slice(0, 10)
    const days = (x) => {
      const n = Number(x)
      if (!Number.isFinite(n)) return '—'
      if (n < 1) return `${Math.max(1, Math.round(n * 24))}h`
      return `${n.toFixed(n < 10 ? 1 : 0)}d`
    }
    const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    const timeLabel = (iso, seconds = false) => {
      const date = new Date(iso ?? '')
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        ...(seconds ? { second: '2-digit' } : {}),
      })
    }

    const DEFAULT_VIA = 'deepseek'
    let via = DEFAULT_VIA
    const syncVia = (payload) => {
      if (payload?.via === undefined) return
      via = String(payload.via ?? '').trim() || DEFAULT_VIA
    }
    const polyLink = (path) => {
      const href = `https://polymarket.com${path}`
      return `${href}${href.includes('?') ? '&' : '?'}via=${encodeURIComponent(via)}`
    }

    // A pasted polymarket.com event/market link is a lookup, not a text filter.
    const POLY_LINK_RE = /^(?:https?:\/\/)?(?:www\.)?polymarket\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(event|market)\/([^/?#\s]+)/i
    const POLY_PATH_RE = /^\/?(event|market)\/([^/?#\s]+)/i
    const polyLinkTarget = (value) => {
      const text = String(value ?? '').trim()
      if (!text) return null
      const match = text.match(POLY_LINK_RE) ?? text.match(POLY_PATH_RE)
      return match ? { kind: match[1].toLowerCase(), slug: match[2] } : null
    }
    // Category order mirrors the host taxonomy; the counters come from the scan.
    const CATEGORY_KEYS = ['sports', 'crypto', 'weather', 'elections', 'tech', 'economy', 'world', 'politics', 'culture', 'other']

    function api(pathname, init) {
      return fetch(API + pathname, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) {
          const error = new Error(payload?.error || `HTTP ${response.status}`)
          error.payload = payload
          throw error
        }
        syncVia(payload?.via !== undefined ? payload : payload?.onboarding)
        return payload
      })
    }

    const orderErrorText = (code, t, live) => {
      const raw = String(code ?? '')
      if (raw === 'order-cap') return t('errorOrderCap', { max: usd(live?.limits?.maxOrderUsd ?? 0) })
      if (raw === 'daily-cap') return t('errorDailyCap', { left: usd(live?.remainingToday ?? 0) })
      if (raw.startsWith('below-min-size') || raw === 'amount-required') return t('errorMinSize')
      if (raw === 'no-ask' || raw === 'no-bid') return t('errorNoBook')
      if (raw === 'trading-disabled') return t('tradingDisabled')
      if (raw === 'position-missing') return t('errorPositionMissing')
      if (raw === 'position-redeemable') return t('errorPositionRedeemable')
      if (raw === 'order-not-found' || raw === 'order-not-open' || raw === 'cancel-rejected' || raw === 'order-id-required') {
        return t('cancelFailed')
      }
      if (raw === 'bridge-missing' || raw === 'approvals-missing') return t('bridgeNotReady', { reason: raw })
      return t('errorGeneric', { error: raw })
    }

    const reasonText = (live, t) => {
      if (!live) return t('configNeeded')
      if (!live.configured?.key || !live.configured?.wallet) return t('configNeeded')
      if (!live.enabled) return t('tradingDisabled')
      if (live.reason === 'approvals-missing') return t('approvalsMissing')
      if (!live.ready) return t('bridgeNotReady', { reason: live.reason ?? live.error ?? '' })
      return null
    }

    // ------------------------------------------------------- panel language
    //
    // The panel follows the DeepSeek Harness language: Chinese when that UI is
    // Chinese, English for every other language. The Host needs the same answer
    // before it sweeps Gamma, otherwise a non-Chinese UI would still list
    // Chinese market titles, so the module reports it on load and on a switch.
    let marketLocale = 'en'
    let syncedLocale = null
    let scanDirty = false
    let localeProbe = () => {}
    const localeWatchers = new Set()

    const isChineseLocale = (snapshot) => {
      const active = String(snapshot?.active ?? '').toLowerCase()
      return active === 'zh' || active.startsWith('zh-')
    }

    const notifyLocale = (changed) => {
      for (const watcher of localeWatchers) {
        try {
          watcher(marketLocale, changed)
        } catch (error) {
          console.error('polymarket-agent locale listener:', error)
        }
      }
    }

    function syncLocale(snapshot) {
      const next = isChineseLocale(snapshot) ? 'zh' : 'en'
      const switched = next !== marketLocale
      marketLocale = next
      if (syncedLocale === next) {
        if (switched) notifyLocale(false)
        return
      }
      syncedLocale = next
      api('/locale', { method: 'POST', body: JSON.stringify({ locale: next }) })
        .then((payload) => {
          if (payload?.changed) {
            // The cached radar is in the previous language; the next load has to
            // force a sweep so the list matches the interface again.
            scanDirty = true
            notifyLocale(true)
          } else if (switched) {
            notifyLocale(false)
          }
        })
        .catch(() => {
          // Retry on the next locale change or panel mount.
          if (syncedLocale === next) syncedLocale = null
        })
    }

    // ----------------------------------------------------------- components

    function Chip({ children, tone }) {
      return h('span', { className: `pa-chip${tone ? ` pa-chip--${tone}` : ''}` }, children)
    }

    function Stat({ label, value, hint }) {
      return h(
        'div',
        { className: 'pa-stat' },
        h('div', { className: 'pa-stat-label' }, label),
        h('div', { className: 'pa-stat-value' }, value),
        hint ? h('div', { className: 'pa-stat-hint' }, hint) : null,
      )
    }

    function Modal({ title, subtitle, close, children, wide, className }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          // A zoomed screenshot owns Escape; closing the dialog underneath it
          // at the same time would be surprising.
          if (document.querySelector('.pa-lightbox')) return
          close?.()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [close])
      return h(
        'div',
        { className: 'pa-backdrop', onClick: (event) => event.target === event.currentTarget && close?.() },
        h(
          'div',
          { className: `pa-modal${wide ? ' pa-modal--wide' : ''}${className ? ` ${className}` : ''}`, role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { className: 'pa-modal-head' },
            h('h2', { className: 'pa-modal-title' }, title),
            h('button', { className: 'pa-btn pa-btn--ghost pa-btn--icon', type: 'button', onClick: close, title: t('close') }, '✕'),
          ),
          subtitle ? h('p', { className: 'pa-modal-sub' }, subtitle) : null,
          children,
        ),
      )
    }

    function Toast({ message }) {
      if (!message) return null
      return h('div', { className: 'pa-toast' }, message)
    }

    /**
     * Account guide shown by the Polymarket panel itself. The panel decides
     * whether to mount it from its first `/state` snapshot, so it is checked
     * only when the plugin is opened — never on plain Harness startup. The
     * prompt is suppressed once a private key and an account wallet are both
     * configured; `onContinue` closes it and reveals the setup wizard.
     */
    function AccountGuide({ onContinue }) {
      return h(
        'div',
        { className: 'pa-guide-backdrop' },
        h(
          'div',
          {
            className: 'pa-guide',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'pa-guide-title',
            'aria-describedby': 'pa-guide-copy',
          },
          h('img', {
            className: 'pa-guide-logo',
            src: `${API}/asset/polymarket-logo.png`,
            alt: 'Polymarket',
            draggable: false,
          }),
          h('h2', { id: 'pa-guide-title', className: 'pa-guide-question' }, t('guideQuestion')),
          h('p', { id: 'pa-guide-copy', className: 'pa-guide-copy' }, t('guideCopy')),
          h(
            'div',
            { className: 'pa-guide-actions' },
            h(
              'a',
              {
                className: 'pa-guide-primary',
                href: REGISTER_URL,
                target: '_blank',
                rel: 'noopener noreferrer',
                autoFocus: true,
              },
              t('guideRegister'),
            ),
            h('button', { className: 'pa-guide-secondary', type: 'button', onClick: onContinue }, t('guideHaveAccount')),
          ),
          h('p', { className: 'pa-guide-note' }, t('guideNote')),
        ),
      )
    }

    function AutoScan({ sweep, settings, t, onChange, disabled }) {
      const [now, setNow] = useState(Date.now())
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [])
      if (!sweep) return null
      const next = sweep.nextAt ? Date.parse(sweep.nextAt) : 0
      const left = next ? Math.max(0, Math.ceil((next - now) / 1000)) : null
      return h(
        'div',
        { className: 'pa-auto', title: t('sweepRuns', { n: sweep.runs ?? 0, ms: sweep.lastMs ?? 0 }) },
        h(
          'select',
          {
            className: 'pa-select',
            value: settings?.refreshSeconds ?? sweep.intervalSeconds,
            disabled,
            'aria-label': t('sweepInterval'),
            onChange: (event) => onChange(Number(event.target.value)),
          },
          [300, 900, 1800, 3600, 7200].map((value) => h('option', { key: value, value }, t(`interval${value}`))),
        ),
        h(
          'span',
          { className: 'pa-stamp' },
          sweep.running ? t('sweeping') : left === null ? t('autoIdle') : t('nextSweep', { t: clock(left) }),
        ),
      )
    }

    // ----------------------------------------------------------- onboarding

    const SETUP_STEPS = [
      ['key', 'obStepKey'],
      ['wallet', 'obStepWallet'],
      ['relayer', 'obStepRelayer'],
      ['verify', 'obStepVerify'],
    ]
    const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
    const PRIVATE_KEY_RE = /^(?:0x)?[0-9a-fA-F]{64}$/
    const isAddress = (value) => ADDRESS_RE.test(String(value ?? '').trim())
    const isPrivateKey = (value) => PRIVATE_KEY_RE.test(String(value ?? '').trim())
    const shortAddress = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—')
    const sourceText = (source, t) => {
      if (!source) return t('sourceNone')
      // The Host only resolves credentials from the DSH store now; keep the
      // helper tolerant of an older provider label.
      return t('sourceCredentials')
    }
    const capsOf = (limits, fallback) => ({
      enabled: Boolean(limits?.enabled ?? fallback?.enabled ?? true),
      maxOrderUsd: Number(limits?.maxOrderUsd ?? fallback?.maxOrderUsd ?? 25),
      dailyUsd: Number(limits?.dailyUsd ?? fallback?.dailyUsd ?? 100),
    })

    /**
     * Four labelled stages instead of anonymous dots. `step` is 1-based, so the
     * first stage lights up exactly one marker and finished stages show a tick.
     */
    function SetupSteps({ step, t }) {
      return h(
        'ol',
        { className: 'pa-steps' },
        SETUP_STEPS.map(([key, label], index) => {
          const number = index + 1
          const state = number < step ? 'done' : number === step ? 'active' : 'todo'
          return h(
            'li',
            {
              key,
              className: `pa-step pa-step--${state}`,
              'aria-current': number === step ? 'step' : undefined,
            },
            h('span', { className: 'pa-step-dot' }, state === 'done' ? '✓' : number),
            h('span', { className: 'pa-step-label' }, t(label)),
          )
        }),
      )
    }

    function Lightbox({ src, alt, t, close }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.stopImmediatePropagation()
          close()
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [close])
      return h(
        'div',
        {
          className: 'pa-lightbox',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': alt,
          onClick: (event) => event.target === event.currentTarget && close(),
        },
        h('button', { className: 'pa-lightbox-close', type: 'button', onClick: close, 'aria-label': t('close') }, '✕'),
        h('img', { className: 'pa-lightbox-img', src, alt }),
        h('p', { className: 'pa-lightbox-hint' }, t('obZoomClose')),
      )
    }

    function Shot({ file, t }) {
      const [failed, setFailed] = useState(false)
      const [zoom, setZoom] = useState(false)
      const src = `${API}/asset/${file}`
      if (failed) return h('div', { className: 'pa-shot pa-shot--missing' }, t('obShotMissing', { file }))
      return h(
        React.Fragment,
        null,
        h(
          'button',
          { className: 'pa-shot-btn', type: 'button', onClick: () => setZoom(true), title: t('obZoom') },
          h('img', { className: 'pa-shot', src, alt: t('obZoomAlt'), onError: () => setFailed(true) }),
          h('span', { className: 'pa-shot-hint' }, t('obZoomHint')),
        ),
        zoom ? h(Lightbox, { src, alt: t('obZoomAlt'), t, close: () => setZoom(false) }) : null,
      )
    }

    /**
     * First-run wizard and the reconfigure flow. Secrets go straight to the
     * Host over loopback and are stored by DSH's credential service; they never
     * linger in panel state after a successful save. There is no `.env` step.
     */
    function Onboarding({ initial, live: liveProp, t, onDone, embedded, startAt }) {
      const [step, setStep] = useState(startAt ?? (initial?.done ? 4 : 1))
      const [key, setKey] = useState('')
      const [showKey, setShowKey] = useState(false)
      const [wallet, setWallet] = useState(initial?.wallet ?? initial?.configured?.wallet ?? '')
      const [relayerKey, setRelayerKey] = useState('')
      const [relayerAddress, setRelayerAddress] = useState(initial?.relayerAddress ?? '')
      const [vaultAck, setVaultAck] = useState(false)
      const vaultAckRef = useRef(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [view, setView] = useState(initial ?? { configured: {} })
      const [live, setLive] = useState(liveProp ?? { ready: false })
      const [caps, setCaps] = useState(() => capsOf(liveProp?.limits))

      const configured = view.configured ?? {}
      const keyValue = String(key ?? '').trim()
      const walletValue = String(wallet ?? '').trim()
      const keyInvalid = keyValue !== '' && !isPrivateKey(keyValue)
      // The save button stays clickable so it can point at the unchecked
      // acknowledgement instead of silently staying gray.
      const needsVaultAck = keyValue !== '' && !vaultAck
      const walletInvalid = walletValue !== '' && !isAddress(walletValue)
      const detectedWallet = view.wallet ?? configured.wallet ?? ''
      const detectedRelayerAddress = view.relayerAddress ?? ''
      const approved = Boolean(live.approvals?.fully)
      const ready = Boolean(configured.key && configured.wallet)
      const relayerKeyValue = relayerKey.trim()
      const relayerAddressValue = relayerAddress.trim()
      const relayerReady = configured.relayer
        ? !relayerKeyValue || (relayerKeyValue.length >= 8 && isAddress(relayerAddressValue))
        : (approved && !relayerKeyValue && !relayerAddressValue) ||
          (relayerKeyValue.length >= 8 && isAddress(relayerAddressValue))

      const run = (task) => {
        setBusy(true)
        setError(null)
        return task
          .then((payload) => {
            if (payload?.onboarding) setView(payload.onboarding)
            if (payload?.live) setLive(payload.live)
            return payload
          })
          .catch((err) => {
            const message = String(err.message ?? err)
            setError(message === 'not-found' ? t('obHostStale') : message)
            return null
          })
          .finally(() => setBusy(false))
      }

      const refresh = () =>
        run(api('/onboarding').then((payload) => ({ onboarding: payload, live: payload.live }))).then((payload) => {
          if (!payload?.onboarding) return
          if (payload.onboarding.caps) setCaps(capsOf(payload.onboarding.caps))
          if (payload.onboarding.wallet) setWallet((current) => current || payload.onboarding.wallet)
          if (payload.onboarding.relayerAddress) {
            setRelayerAddress((current) => current || payload.onboarding.relayerAddress)
          }
        })

      const saveKey = () => {
        if (keyInvalid) {
          setError(t('obKeyInvalid'))
          return Promise.resolve()
        }
        if (!keyValue) {
          setStep(2)
          return Promise.resolve()
        }
        if (!vaultAck) {
          setError(t('obVaultAckRequired'))
          try {
            vaultAckRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            vaultAckRef.current?.focus({ preventScroll: true })
          } catch {}
          return Promise.resolve()
        }
        return run(api('/credentials', { method: 'POST', body: JSON.stringify({ privateKey: keyValue }) })).then(
          (payload) => {
            if (!payload?.onboarding?.configured?.key) return
            setKey('')
            setShowKey(false)
            setStep(2)
          },
        )
      }

      const saveWallet = () => {
        if (!isAddress(walletValue)) {
          setError(t('obWalletInvalid'))
          return Promise.resolve()
        }
        const unchanged =
          configured.wallet && walletValue.toLowerCase() === String(detectedWallet).toLowerCase()
        if (unchanged) {
          setStep(3)
          return Promise.resolve()
        }
        return run(api('/credentials', { method: 'POST', body: JSON.stringify({ wallet: walletValue }) })).then(
          (payload) => {
            if (payload?.ok) setStep(3)
          },
        )
      }

      const saveRelayer = () => {
        const keyText = relayerKey.trim()
        const addressText = relayerAddress.trim()
        if (!keyText && !addressText) {
          if (configured.relayer || live.approvals?.fully) {
            setStep(4)
          } else {
            setError(t('obRelayerRequired'))
          }
          return Promise.resolve()
        }
        if (keyText && keyText.length < 8) {
          setError(t('obRelayerKeyInvalid'))
          return Promise.resolve()
        }
        if (!isAddress(addressText)) {
          setError(t('obRelayerAddressInvalid'))
          return Promise.resolve()
        }
        if (!keyText) {
          if (!configured.relayer) {
            setError(t('obRelayerIncomplete'))
            return Promise.resolve()
          }
          if (addressText.toLowerCase() === String(detectedRelayerAddress).toLowerCase()) {
            setStep(4)
            return Promise.resolve()
          }
          return run(api('/credentials', { method: 'POST', body: JSON.stringify({ relayerAddress: addressText }) })).then(
            (payload) => {
              if (payload?.ok) setStep(4)
            },
          )
        }
        return run(
          api('/credentials', {
            method: 'POST',
            body: JSON.stringify({ relayerKey: keyText, relayerAddress: addressText }),
          }),
        ).then((payload) => {
          if (payload?.ok) {
            setRelayerKey('')
            setStep(4)
          }
        })
      }

      const approve = () =>
        run(api('/approve', { method: 'POST', body: '{}' })).then((payload) => {
          if (payload && !payload.ok) setError(`${payload.stage ?? 'approve'}: ${payload.error ?? 'failed'}`)
        })

      const finish = () =>
        run(api('/onboarding', { method: 'POST', body: JSON.stringify({ action: 'finish', caps }) })).then(
          (payload) => {
            if (payload?.ok) onDone?.(payload)
            else if (payload) setError(payload.error === 'onboarding-incomplete' ? t('obIncomplete') : String(payload.error ?? 'failed'))
          },
        )

      const skip = () =>
        run(api('/onboarding', { method: 'POST', body: JSON.stringify({ action: 'skip' }) })).then((payload) => {
          if (payload?.ok) onDone?.(payload)
        })

      const goBack = () => {
        if (step <= 1) return
        setStep(step - 1)
      }

      const failed = error ? h('p', { className: 'pa-warn' }, t('obError', { error })) : null

      const keyStep = h(
        'section',
        { className: 'pa-ob-step' },
        h('h2', { className: 'pa-ob-h2' }, t('obKeyTitle')),
        h(
          'div',
          { className: 'pa-ob-copy' },
          h('p', null, t('obKeyWhy')),
          h(
            'div',
            { className: `pa-vault${needsVaultAck ? ' pa-vault--attention' : ''}` },
            h('div', { className: 'pa-vault-title' }, t('obVaultTitle')),
            h('p', null, t('obVaultWhy')),
            h(
              'label',
              { className: 'pa-check pa-vault-check' },
              h('input', {
                ref: vaultAckRef,
                type: 'checkbox',
                checked: vaultAck,
                onChange: (event) => setVaultAck(event.target.checked),
              }),
              h('span', null, t('obVaultAck')),
            ),
            needsVaultAck ? h('p', { className: 'pa-vault-hint' }, t('obVaultAckNeeded')) : null,
          ),
          h('p', null, t('obKeyWhere')),
          h(
            'p',
            null,
            h('a', { className: 'pa-link', href: polyLink('/settings'), target: '_blank', rel: 'noopener noreferrer' }, t('obKeyLink')),
          ),
        ),
        h(Shot, { file: 'private-key.png', t }),
        h(
          'div',
          { className: 'pa-note pa-note--warn' },
          h('div', { className: 'pa-note-title' }, t('obKeyRiskTitle')),
          h('p', null, t('obKeyWarning')),
        ),
        h(
          'div',
          { className: 'pa-field-block' },
          h(
            'div',
            { className: 'pa-field-label' },
            h('span', null, t('obKeyInput')),
            h(Chip, { tone: configured.key ? 'green' : 'warn' }, configured.key ? t('configured') : t('required')),
          ),
          h(
            'div',
            { className: 'pa-secret' },
            h('input', {
              className: 'pa-input pa-mono',
              type: showKey ? 'text' : 'password',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: configured.key ? t('obKeyKeep') : t('obKeyPlaceholder'),
              value: key,
              onChange: (event) => setKey(event.target.value),
              'aria-label': t('obKeyInput'),
            }),
            h(
              'button',
              { className: 'pa-btn pa-btn--ghost', type: 'button', disabled: busy, onClick: () => setShowKey((value) => !value) },
              showKey ? t('hide') : t('show'),
            ),
          ),
          h(
            'p',
            { className: `pa-hint pa-hint--left${keyInvalid ? ' pa-warn' : ''}` },
            keyInvalid ? t('obKeyInvalid') : configured.key ? t('obKeySavedHint') : t('obKeyFormat'),
          ),
          h('p', { className: 'pa-hint pa-hint--left' }, t('obKeyStorageHint')),
        ),
        failed,
        h(
          'div',
          { className: 'pa-ob-nav' },
          h(
            'button',
            {
              className: 'pa-btn pa-btn--primary',
              type: 'button',
              disabled: busy || keyInvalid || (!configured.key && !keyValue),
              onClick: saveKey,
            },
            keyValue ? t('obKeySave') : t('obNext'),
          ),
          !embedded
            ? h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', disabled: busy, onClick: skip }, t('obLater'))
            : null,
        ),
      )

      const walletStep = h(
        'section',
        { className: 'pa-ob-step' },
        h('h2', { className: 'pa-ob-h2' }, t('obWalletTitle')),
        h(
          'div',
          { className: 'pa-ob-copy' },
          h('p', null, t('obWalletWhy')),
          h('p', null, t('obWalletWhere')),
          h(
            'p',
            null,
            h('a', { className: 'pa-link', href: polyLink('/profile'), target: '_blank', rel: 'noopener noreferrer' }, t('obWalletLink')),
          ),
        ),
        h(Shot, { file: 'wallet-address.png', t }),
        h(
          'div',
          { className: 'pa-field-block' },
          h(
            'div',
            { className: 'pa-field-label' },
            h('span', null, t('obWalletInput')),
            h(Chip, { tone: configured.wallet ? 'green' : 'warn' }, configured.wallet ? t('configured') : t('required')),
          ),
          h('input', {
            className: 'pa-input pa-mono',
            type: 'text',
            spellCheck: false,
            placeholder: '0x…',
            value: wallet,
            onChange: (event) => setWallet(event.target.value),
            'aria-label': t('obWalletInput'),
          }),
          detectedWallet && detectedWallet.toLowerCase() !== walletValue.toLowerCase()
            ? h(
                'button',
                {
                  className: 'pa-btn pa-btn--ghost pa-btn--sm pa-align-left',
                  type: 'button',
                  onClick: () => setWallet(detectedWallet),
                },
                t('obWalletUseDetected', { wallet: shortAddress(detectedWallet) }),
              )
            : null,
          h(
            'p',
            { className: `pa-hint pa-hint--left${walletInvalid ? ' pa-warn' : ''}` },
            walletInvalid
              ? t('obWalletInvalid')
              : detectedWallet
                ? t('obWalletDetected', { wallet: detectedWallet })
                : t('obWalletFormat'),
          ),
        ),
        failed,
        h(
          'div',
          { className: 'pa-ob-nav' },
          h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', disabled: busy, onClick: goBack }, t('obBack')),
          h(
            'button',
            { className: 'pa-btn pa-btn--primary', type: 'button', disabled: busy || !isAddress(walletValue), onClick: saveWallet },
            t('obNext'),
          ),
          !embedded && !configured.wallet
            ? h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', disabled: busy, onClick: skip }, t('obLater'))
            : null,
        ),
      )

      const relayerStep = h(
        'section',
        { className: 'pa-ob-step' },
        h('h2', { className: 'pa-ob-h2' }, t('obRelayerTitle')),
        h(
          'div',
          { className: 'pa-ob-copy' },
          h('p', null, t('obRelayerWhy')),
          h('p', null, t('obRelayerWhere')),
          h(
            'p',
            null,
            h('a', { className: 'pa-link', href: polyLink('/settings'), target: '_blank', rel: 'noopener noreferrer' }, t('obRelayerLink')),
          ),
        ),
        h(Shot, { file: 'relayer-key.png', t }),
        h(
          'div',
          { className: 'pa-field-block' },
          h(
            'div',
            { className: 'pa-field-label' },
            h('span', null, t('obRelayerKey')),
            h(
              'span',
              { className: 'pa-stamp' },
              configured.relayer ? t('configured') : approved ? t('obApproved') : t('required'),
            ),
          ),
          h('input', {
            className: 'pa-input pa-mono',
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: configured.relayer ? t('obRelayerKeyKeep') : t('obRelayerKeyPlaceholder'),
            value: relayerKey,
            onChange: (event) => setRelayerKey(event.target.value),
            'aria-label': t('obRelayerKey'),
          }),
        ),
        h(
          'div',
          { className: 'pa-field-block' },
          h('div', { className: 'pa-field-label' }, h('span', null, t('obRelayerAddress'))),
          h('input', {
            className: 'pa-input pa-mono',
            type: 'text',
            spellCheck: false,
            placeholder: '0x…',
            value: relayerAddress,
            onChange: (event) => setRelayerAddress(event.target.value),
            'aria-label': t('obRelayerAddress'),
          }),
          configured.relayer
            ? h('p', { className: 'pa-hint pa-hint--left pa-ok' }, t('obRelayerSaved'))
            : approved
              ? h('p', { className: 'pa-hint pa-hint--left' }, t('obRelayerApprovedHint'))
              : h('p', { className: 'pa-hint pa-hint--left' }, t('obRelayerRequiredHint')),
        ),
        failed,
        h(
          'div',
          { className: 'pa-ob-nav' },
          h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', disabled: busy, onClick: goBack }, t('obBack')),
          h(
            'button',
            { className: 'pa-btn pa-btn--primary', type: 'button', disabled: busy || !relayerReady, onClick: saveRelayer },
            t('obNext'),
          ),
        ),
      )

      const verifyStep = h(
        'section',
        { className: 'pa-ob-step' },
        h('h2', { className: 'pa-ob-h2' }, t('obVerifyTitle')),
        h(
          'div',
          { className: 'pa-ob-summary' },
          h(
            'div',
            { className: 'pa-kv' },
            h('span', null, t('obKeyConfigured')),
            h('span', null, configured.key ? `${t('configured')} · ${sourceText(view.sources?.privateKey, t)}` : t('notConfigured')),
          ),
          h(
            'div',
            { className: 'pa-kv' },
            h('span', null, t('obAccount')),
            h('span', { className: 'pa-mono' }, live.wallet || detectedWallet || '—'),
          ),
          h('div', { className: 'pa-kv' }, h('span', null, t('obWalletType')), h('span', null, live.walletType ?? '—')),
          h(
            'div',
            { className: 'pa-kv' },
            h('span', null, t('obCash')),
            h('span', null, live.cash === null || live.cash === undefined ? '—' : usd(live.cash)),
          ),
          h(
            'div',
            { className: 'pa-kv' },
            h('span', null, t('obApprovals')),
            h('span', { className: approved ? 'pa-ok' : 'pa-warn' }, approved ? t('obApproved') : t('obNotApproved')),
          ),
          h(
            'div',
            { className: 'pa-kv' },
            h('span', null, t('obRelayerConfigured')),
            h('span', null, configured.relayer ? t('configured') : t('notConfigured')),
          ),
        ),
        live.error ? h('p', { className: 'pa-warn' }, String(live.error)) : null,
        ready && !approved
          ? h(
              'div',
              { className: 'pa-ob-callout' },
              h('p', null, t('obApproveWhy')),
              h('button', { className: 'pa-btn pa-btn--primary', type: 'button', disabled: busy, onClick: approve }, busy ? t('obWorking') : t('obApprove')),
            )
          : null,
        ready && approved ? h('p', { className: 'pa-ok' }, t('obApprovedDone')) : null,
        h(
          'div',
          { className: 'pa-settings-card pa-settings-card--flat' },
          h('h3', null, t('obCapsTitle')),
          h(
            'label',
            { className: 'pa-check' },
            h('input', { type: 'checkbox', checked: Boolean(caps.enabled), onChange: (event) => setCaps({ ...caps, enabled: event.target.checked }) }),
            h('span', null, t('obCapsEnable')),
          ),
          h(
            'div',
            { className: 'pa-settings-numbers' },
            h(
              'label',
              { className: 'pa-settings-number' },
              h('span', null, t('obCapOrder')),
              h('input', {
                className: 'pa-input',
                type: 'number',
                min: 1,
                step: 1,
                value: caps.maxOrderUsd,
                onChange: (event) => setCaps({ ...caps, maxOrderUsd: Number(event.target.value) }),
              }),
            ),
            h(
              'label',
              { className: 'pa-settings-number' },
              h('span', null, t('obCapDaily')),
              h('input', {
                className: 'pa-input',
                type: 'number',
                min: 1,
                step: 1,
                value: caps.dailyUsd,
                onChange: (event) => setCaps({ ...caps, dailyUsd: Number(event.target.value) }),
              }),
            ),
          ),
        ),
        failed,
        h(
          'div',
          { className: 'pa-ob-nav' },
          h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', disabled: busy, onClick: goBack }, t('obBack')),
          h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', disabled: busy, onClick: refresh }, t('obCheckAgain')),
          h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', disabled: busy, onClick: () => setStep(1) }, t('obRestart')),
          h('button', { className: 'pa-btn pa-btn--primary', type: 'button', disabled: busy, onClick: finish }, t('obFinish')),
        ),
      )

      const steps = [keyStep, walletStep, relayerStep, verifyStep]
      const body = steps[Math.max(1, Math.min(step, 4)) - 1]

      return h(
        'div',
        { className: `pa-ob${embedded ? ' pa-ob--embedded' : ''}` },
        h('header', { className: 'pa-ob-head' }, h(SetupSteps, { step, t })),
        body,
      )
    }

    /**
     * The settings surface. It deliberately does not reuse the onboarding
     * chrome: one close button on the dialog, status at the top, and plain
     * inputs for every credential so nobody has to edit a file by hand.
     */
    /** Settings dialog: the same guided 1–4 steps, with a single close button. */
    function SettingsModal({ onboarding, live, t, close, onSaved }) {
      const [confirming, setConfirming] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      const logout = () => {
        setBusy(true)
        setError(null)
        return api('/logout', { method: 'POST', body: '{}' })
          .then((payload) => {
            if (!payload?.ok) throw new Error(payload?.error ?? 'logout-failed')
            onSaved?.(payload)
            close?.()
          })
          .catch((err) => setError(String(err?.message ?? err)))
          .finally(() => setBusy(false))
      }

      return h(
        Modal,
        { title: t('settings'), subtitle: t('settingsHint'), close, wide: true },
        h(Onboarding, {
          initial: onboarding,
          live,
          t,
          embedded: true,
          startAt: 1,
          onDone: (payload) => {
            onSaved?.(payload)
            close?.()
          },
        }),
        h(
          'div',
          { className: 'pa-danger-zone' },
          h('h3', null, t('settingsDangerTitle')),
          h('p', { className: 'pa-hint pa-hint--left' }, t('settingsLogoutWhy')),
          error ? h('p', { className: 'pa-warn' }, t('settingsLogoutFailed', { error })) : null,
          confirming
            ? h(
                'div',
                { className: 'pa-danger-actions' },
                h('span', { className: 'pa-hint' }, t('settingsLogoutConfirm')),
                h(
                  'button',
                  { className: 'pa-btn pa-btn--danger', type: 'button', disabled: busy, onClick: logout },
                  t('settingsLogoutConfirmBtn'),
                ),
                h(
                  'button',
                  { className: 'pa-btn pa-btn--ghost', type: 'button', disabled: busy, onClick: () => setConfirming(false) },
                  t('cancel'),
                ),
              )
            : h(
                'div',
                { className: 'pa-danger-actions' },
                h(
                  'button',
                  { className: 'pa-btn pa-btn--danger', type: 'button', onClick: () => setConfirming(true) },
                  t('settingsLogout'),
                ),
              ),
        ),
      )
    }

    // --------------------------------------------------------------- deposit

    function DepositModal({ portfolio, deposit, close, t }) {
      const [info, setInfo] = useState(deposit ?? null)
      const [loading, setLoading] = useState(!(deposit?.address || deposit?.savedAddress))
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [copied, setCopied] = useState('')
      const [manualOpen, setManualOpen] = useState(false)
      const [manual, setManual] = useState('')

      const wallet = info?.wallet ?? portfolio?.wallet ?? null
      const address = info?.address ?? null
      const source = info?.source ?? null
      const savedAddress = info?.savedAddress ?? null
      const evidence = info?.evidence ?? null
      const qr = info?.qr ?? null
      const bridge = evidence?.bridge ?? null
      const legacy = info?.walletType === 'POLY_PROXY' || info?.walletType === 'GNOSIS_SAFE'

      // `/state` already carries the cheap view; this refresh also runs the
      // public deposit-history lookup when no address has been saved yet.
      useEffect(() => {
        let alive = true
        api('/deposit')
          .then((payload) => {
            if (!alive || !payload) return
            setInfo((current) => ({ ...(current ?? {}), ...payload }))
          })
          .catch(() => {})
          .finally(() => {
            if (alive) setLoading(false)
          })
        return () => {
          alive = false
        }
      }, [])

      const sourceLabel = (value) => {
        if (value === 'history') return t('depositSourceHistory')
        if (value === 'wallet') return t('depositSourceWallet')
        if (value === 'manual') return t('depositSourceManual')
        return t('depositSourceUnknown')
      }

      const errorText = (err) => {
        const code = String(err?.message ?? err)
        if (code === 'invalid-address') return t('depositInvalidAddress')
        return `${t('depositSaveFailed')} ${code}`
      }

      const copy = (value, key) => {
        if (!value) return
        Promise.resolve(navigator.clipboard?.writeText(value))
          .then(() => {
            setCopied(key)
            setTimeout(() => setCopied(''), 1800)
          })
          .catch(() => setCopied(''))
      }

      const apply = (payload) => {
        const next = payload?.deposit ?? payload
        if (next) setInfo((current) => ({ ...(current ?? {}), ...next }))
      }

      const run = (task) => {
        setBusy(true)
        setError(null)
        setNotice(null)
        return task
          .then((payload) => {
            apply(payload)
            return payload
          })
          .catch((err) => {
            setError(errorText(err))
            return null
          })
          .finally(() => setBusy(false))
      }

      const refresh = () =>
        run(api('/deposit?refresh=1')).then((payload) => {
          if (payload) setNotice(t('depositRefreshed'))
        })

      const saveManual = () =>
        run(api('/deposit/address', { method: 'POST', body: JSON.stringify({ address: manual }) })).then((payload) => {
          if (!payload?.ok) return
          setManualOpen(false)
          setManual('')
          setNotice(t('depositSaved'))
        })

      const clear = () =>
        run(api('/deposit/address', { method: 'POST', body: JSON.stringify({ address: '' }) })).then((payload) => {
          if (payload?.ok) setNotice(t('depositCleared'))
        })

      const actions = (extra) => h('div', { className: 'pa-deposit-actions' }, ...extra)
      const openPage = h(
        'a',
        { className: 'pa-btn pa-btn--primary', href: polyLink('/portfolio'), target: '_blank', rel: 'noopener noreferrer' },
        t('depositOpenPage'),
      )

      const amountText = (value) => {
        const n = Number(value)
        if (!Number.isFinite(n) || n <= 0) return ''
        return n.toLocaleString('en-US', { maximumFractionDigits: n >= 1 ? 2 : 4 })
      }
      // One compact affordance per transaction leg; the only "view" links the
      // modal shows now live inline on the bridge line.
      const txLink = (href) =>
        href
          ? h(
              'a',
              { className: 'pa-deposit-tx', href, target: '_blank', rel: 'noopener noreferrer' },
              t('depositViewTx'),
            )
          : null
      const hasBridge = Boolean(bridge?.origin && bridge?.destination)
      const evidenceBits = []
      const assetText = evidence?.asset ? ` ${evidence.asset}` : ''
      const networkText = evidence?.network ? ` (${evidence.network})` : ''
      const amountBit = evidence?.amount
        ? `${amountText(evidence.amount)}${assetText}`
        : evidence?.asset ?? ''
      if (amountBit) evidenceBits.push(`${amountBit}${networkText}`)
      else if (evidence?.network) evidenceBits.push(evidence.network)
      if (evidence?.at) evidenceBits.push(timeLabel(evidence.at))
      // Plain sentence (no link) while the bridge line already carries the two
      // per-leg links; standalone it keeps the one link to the settled tx.
      const evidenceLine = evidence?.txHash
        ? h(
            'p',
            { className: 'pa-hint pa-hint--left' },
            `${t('depositEvidence')}${evidenceBits.length ? ` · ${evidenceBits.join(' · ')}` : ''}`,
            hasBridge ? null : ' ',
            hasBridge ? null : txLink(`https://polygonscan.com/tx/${evidence.txHash}`),
          )
        : null

      const explorerTx = (chainId, hash) => {
        const base = {
          1: 'https://etherscan.io/tx/',
          10: 'https://optimistic.etherscan.io/tx/',
          56: 'https://bscscan.com/tx/',
          137: 'https://polygonscan.com/tx/',
          8453: 'https://basescan.org/tx/',
          42161: 'https://arbiscan.io/tx/',
          43114: 'https://snowtrace.io/tx/',
        }[Number(chainId)] ?? 'https://polygonscan.com/tx/'
        return base + hash
      }
      const originKnown = Boolean(bridge?.origin?.chain && bridge.origin.chain !== '未知')
      const originText = originKnown
        ? `${bridge.origin.chain}${bridge.origin.amount ? ` · ${amountText(bridge.origin.amount)}` : ''}${bridge.origin.asset ? ` ${bridge.origin.asset}` : ''}`
        : `（${t('depositUnknown')}）`
      const viaText = bridge?.protocol === 'Direct' ? '→' : `→ ${bridge?.protocol ?? 'Relay'} →`
      // One line, two inline view links: source leg 【查看】 → bridge → arrival
      // leg 【查看】. This replaced the former 源链交易 / 到账交易 tail links.
      const bridgeLine = hasBridge
        ? h(
            'div',
            { className: 'pa-deposit-bridge' },
            h(
              'span',
              { className: 'pa-deposit-bridge-leg' },
              h('span', null, originKnown ? `${t('depositOrigin')} ${originText}` : `${t('depositOrigin')}${originText}`),
              bridge.origin.txHash ? txLink(explorerTx(bridge.origin.chainId, bridge.origin.txHash)) : null,
            ),
            h('span', { className: 'pa-deposit-bridge-via' }, viaText),
            h(
              'span',
              { className: 'pa-deposit-bridge-leg' },
              h(
                'span',
                null,
                `${t('depositDestination')} ${bridge.destination.chain} · ${amountText(bridge.destination.amount)} ${bridge.destination.asset}`,
              ),
              bridge.destination.txHash ? txLink(explorerTx(bridge.destination.chainId, bridge.destination.txHash)) : null,
            ),
          )
        : null

      const addressCard = !address && loading
        ? h(
            'div',
            { className: 'pa-deposit-hero' },
            h('div', { className: 'pa-deposit-hero-title' }, t('depositLoading')),
          )
        : address
        ? h(
            'div',
            { className: 'pa-deposit-card' },
            h(
              'div',
              { className: 'pa-deposit-body' },
              h(
                'div',
                { className: 'pa-deposit-main' },
                h(
                  'div',
                  { className: 'pa-deposit-card-head' },
                  h('span', { className: 'pa-deposit-card-label' }, t('depositAddress')),
                  h(
                    'span',
                    { className: `pa-deposit-badge${source === 'history' || source === 'wallet' ? ' pa-deposit-badge--ok' : ''}` },
                    sourceLabel(source),
                  ),
                ),
                h(
                  'div',
                  { className: 'pa-deposit-field' },
                  h('code', { className: 'pa-deposit-address' }, address),
                  h(
                    'button',
                    { className: 'pa-btn pa-btn--sm', type: 'button', onClick: () => copy(address, 'address') },
                    copied === 'address' ? t('copied') : t('copy'),
                  ),
                ),
                source === 'wallet' ? h('p', { className: 'pa-hint pa-hint--left' }, t('depositWalletSourceHint')) : null,
                evidenceLine,
                bridgeLine,
                source === 'manual' && wallet && String(address).toLowerCase() === String(wallet).toLowerCase()
                  ? h('p', { className: 'pa-warn' }, t('depositAddressSameWallet'))
                  : null,
                h('p', { className: 'pa-hint pa-hint--left' }, t('depositAddressNote')),
              ),
              qr
                ? h(
                    'div',
                    { className: 'pa-deposit-qr' },
                    h('img', { src: qr, alt: t('depositQrAlt'), width: 156, height: 156 }),
                    h('span', { className: 'pa-deposit-qr-hint' }, t('depositQrHint')),
                  )
                : null,
            ),
            actions([
              openPage,
              savedAddress
                ? null
                : h('button', { className: 'pa-btn pa-btn--sm', type: 'button', disabled: busy, onClick: refresh }, t('depositRefresh')),
              h(
                'button',
                { className: 'pa-btn pa-btn--sm', type: 'button', onClick: () => { setManual(savedAddress ?? ''); setManualOpen(true); setError(null) } },
                savedAddress ? t('depositManualEdit') : t('depositManual'),
              ),
              savedAddress
                ? h('button', { className: 'pa-btn pa-btn--sm pa-btn--ghost', type: 'button', disabled: busy, onClick: clear }, t('depositManualClear'))
                : null,
            ]),
          )
        : h(
            'div',
            { className: 'pa-deposit-hero' },
            h('div', { className: 'pa-deposit-hero-title' }, t('depositAddressMissing')),
            h('p', { className: 'pa-hint pa-hint--left' }, t('depositAddressMissingHint')),
            legacy ? h('p', { className: 'pa-warn' }, t('depositLegacyHint')) : null,
            actions([
              openPage,
              h('button', { className: 'pa-btn', type: 'button', onClick: () => { setManualOpen(true); setError(null) } }, t('depositManual')),
              h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', disabled: busy, onClick: refresh }, t('depositRefresh')),
            ]),
          )

      return h(
        Modal,
        { title: t('depositTitle'), subtitle: t('depositSub'), close, t, wide: true },
        h(
          'div',
          { className: 'pa-deposit' },
          addressCard,
          manualOpen
            ? h(
                'div',
                { className: 'pa-deposit-form' },
                h('h3', null, t('depositManual')),
                h('p', { className: 'pa-hint pa-hint--left' }, t('depositManualHint')),
                h('input', {
                  className: 'pa-input pa-mono',
                  type: 'text',
                  spellCheck: false,
                  placeholder: '0x…',
                  value: manual,
                  onChange: (event) => setManual(event.target.value),
                }),
                actions([
                  h(
                    'button',
                    { className: 'pa-btn pa-btn--primary', type: 'button', disabled: busy || manual.trim() === '', onClick: saveManual },
                    t('depositManualSave'),
                  ),
                  h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', onClick: () => { setManualOpen(false); setError(null) } }, t('cancel')),
                ]),
              )
            : null,
          error ? h('p', { className: 'pa-warn' }, error) : null,
          notice ? h('p', { className: 'pa-ok' }, notice) : null,
        ),
      )
    }

    // ------------------------------------------------------------------ bets

    function BetModal({ state, live, close, submit, t }) {
      const target = state.target
      const side = state.side
      const book = state.book
      const caps = live?.limits ?? {}
      const bestAsk = Number(book?.bestAsk ?? side.price) || Number(side.price) || 0
      const bestBid = Number(book?.bestBid) || 0
      const tickSize = Number(book?.tickSize) > 0 ? Number(book.tickSize) : 0.01
      const minOrderSize = Number(book?.minOrderSize) > 0 ? Number(book.minOrderSize) : 5
      const [mode, setMode] = useState('market')
      const [amount, setAmount] = useState(10)
      const [limitPrice, setLimitPrice] = useState(() => bestAsk || 0.5)
      const [shareCount, setShareCount] = useState(minOrderSize)
      const [showBook, setShowBook] = useState(false)
      const [sending, setSending] = useState(false)
      const [error, setError] = useState(null)
      const priceTouched = useRef(false)
      const sharesTouched = useRef(false)

      useEffect(() => {
        if (!priceTouched.current && bestAsk > 0) setLimitPrice(bestAsk)
      }, [bestAsk])

      useEffect(() => {
        if (!sharesTouched.current && minOrderSize > 0) setShareCount(minOrderSize)
      }, [minOrderSize])

      const snapPrice = useCallback(
        (value) => {
          const step = tickSize > 0 ? tickSize : 0.01
          const raw = Number(value)
          if (!Number.isFinite(raw)) return 0
          const stepped = Math.floor((raw + 1e-9) / step) * step
          const decimals = Math.min(6, Math.max(0, String(step).split('.')[1]?.length ?? 0))
          // The exchange rejects 1.00; the maximum is one tick below it.
          const maxPrice = Number((1 - step).toFixed(decimals))
          return Number(Math.min(maxPrice, Math.max(0, stepped)).toFixed(decimals))
        },
        [tickSize],
      )

      const limit = snapPrice(limitPrice)
      const now = Number(amount) || 0
      const quantity = Number(shareCount) || 0
      const marketPrice = bestAsk > 0 ? bestAsk : Number(side.price) || 0
      const estShares = marketPrice > 0 ? now / marketPrice : 0
      const limitTotal = Number((quantity * limit).toFixed(4))
      const notional = mode === 'market' ? now : limitTotal
      const payout = mode === 'market' ? estShares : quantity
      const remaining = Number(live?.remainingToday ?? 0)
      const availableCash = Number(live?.cash ?? 0)
      const maxOrderUsd = Number(caps.maxOrderUsd ?? 0)
      const minMarketUsd = Math.max(1, minOrderSize * marketPrice)
      const minSharesForTotal = limit > 0 ? Math.max(minOrderSize, Math.ceil((1 / limit) * 100 - 1e-9) / 100) : minOrderSize

      // Opening limit mode should land on a valid ticket; a 5-share order is
      // below $1 on most cheap outcomes. Only auto-bump while the user has not
      // edited the field, so a deliberate smaller entry can still show a hint.
      useEffect(() => {
        if (mode !== 'limit' || sharesTouched.current) return
        setShareCount((current) => Math.max(current, minSharesForTotal))
      }, [mode, minSharesForTotal])

      const tooSmall =
        mode === 'market'
          ? now + 1e-9 < minMarketUsd
          : quantity + 1e-9 < minSharesForTotal || limitTotal + 1e-9 < 1
      const priceInvalid = mode === 'limit' && !(limit >= tickSize && limit < 1)
      const overCap = notional > maxOrderUsd + 1e-9
      const overDaily = notional > remaining + 1e-9
      const overCash = notional > availableCash + 1e-9
      const crossing = mode === 'limit' && bestAsk > 0 && limit + 1e-9 >= bestAsk
      const reason = reasonText(live, t)
      const canSubmit =
        !sending &&
        !reason &&
        !tooSmall &&
        !priceInvalid &&
        !overCap &&
        !overDaily &&
        !overCash &&
        notional > 0 &&
        (mode === 'market' ? marketPrice > 0 : limit > 0) &&
        Boolean(target?.question)

      const priceStep = (delta) => {
        priceTouched.current = true
        setLimitPrice((current) => snapPrice((Number(current) || 0) + delta))
      }
      const shareStep = (delta) => {
        sharesTouched.current = true
        setShareCount((current) => Math.max(0, Number(((Number(current) || 0) + delta).toFixed(2))))
      }
      const useBookPrice = (value) => {
        priceTouched.current = true
        setLimitPrice(snapPrice(value))
        setMode('limit')
      }
      const chip = (label, onClick, key) =>
        h('button', { className: 'pa-quick-btn', type: 'button', key, onClick }, label)
      const levels = (rows, tone, empty) =>
        rows.length
          ? rows.slice(0, 5).map((row, index) =>
              h(
                'button',
                {
                  className: `pa-bet-book-level pa-bet-book-level--${tone}`,
                  key: `${tone}-${row.price}-${index}`,
                  type: 'button',
                  title: t('useLimitPrice', { price: priceCents(row.price) }),
                  onClick: () => useBookPrice(row.price),
                },
                h('span', null, priceCents(row.price)),
                h('span', null, Number(row.size).toFixed(2)),
              ),
            )
          : h('div', { className: 'pa-bet-book-empty' }, empty)

      return h(
        Modal,
        { title: t('betTitle'), close, t },
        h(
          'div',
          { className: 'pa-bet-market' },
          target.icon
            ? h('img', { className: 'pa-bet-icon', src: target.icon, alt: '', loading: 'lazy' })
            : h('div', { className: 'pa-bet-icon pa-bet-icon--empty' }, '📈'),
          h(
            'div',
            { className: 'pa-bet-market-copy' },
            h('div', { className: 'pa-bet-question' }, target.question),
            h(
              'div',
              { className: 'pa-bet-outcome' },
              h('span', { className: 'pa-bet-outcome-dot' }),
              `${target.groupLabel ? `${target.groupLabel} · ` : ''}${side.label}`,
            ),
          ),
          h('div', { className: 'pa-bet-quote' }, priceCents(marketPrice)),
        ),
        h(
          'div',
          { className: 'pa-bet-toolbar' },
          h(
            'div',
            { className: 'pa-seg', role: 'tablist', 'aria-label': t('orderType') },
            h(
              'button',
              {
                className: `pa-seg-btn${mode === 'market' ? ' pa-seg-btn--on' : ''}`,
                type: 'button',
                role: 'tab',
                'aria-selected': mode === 'market',
                onClick: () => { setMode('market'); setError(null) },
              },
              t('marketOrder'),
            ),
            h(
              'button',
              {
                className: `pa-seg-btn${mode === 'limit' ? ' pa-seg-btn--on' : ''}`,
                type: 'button',
                role: 'tab',
                'aria-selected': mode === 'limit',
                onClick: () => { setMode('limit'); setError(null) },
              },
              t('limitOrder'),
            ),
          ),
          h(
            'button',
            {
              className: `pa-book-toggle${showBook ? ' pa-book-toggle--on' : ''}`,
              type: 'button',
              'aria-expanded': showBook,
              onClick: () => setShowBook((value) => !value),
            },
            `${t('orderBook')}${bestBid > 0 || bestAsk > 0 ? ` · ${priceCents(bestBid)} / ${priceCents(bestAsk)}` : ''} ${showBook ? '▴' : '▾'}`,
          ),
        ),
        showBook
          ? h(
              'div',
              { className: 'pa-bet-book' },
              h(
                'div',
                { className: 'pa-bet-book-side' },
                h('div', { className: 'pa-bet-book-title' }, t('asks')),
                levels(book?.asks ?? [], 'ask', t('noBook')),
              ),
              h(
                'div',
                { className: 'pa-bet-book-side' },
                h('div', { className: 'pa-bet-book-title' }, t('bids')),
                levels(book?.bids ?? [], 'bid', t('noBook')),
              ),
            )
          : null,
        h(
          'div',
          { className: 'pa-bet-panel' },
          mode === 'market'
            ? h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'pa-bet-label' },
                  h('span', null, t('amount')),
                  h('span', null, `${t('availableCash')} ${usd(availableCash)}`),
                ),
                h(
                  'label',
                  { className: 'pa-bet-amount' },
                  h('span', { className: 'pa-bet-amount-unit' }, '$'),
                  h('input', {
                    type: 'number',
                    min: 0,
                    step: 1,
                    inputMode: 'decimal',
                    value: amount,
                    onChange: (event) => setAmount(Number(event.target.value)),
                    'aria-label': t('amountUsd'),
                  }),
                ),
                h(
                  'div',
                  { className: 'pa-quick-row' },
                  [1, 5, 10, 100].map((value) =>
                    chip(`+$${value}`, () => setAmount((current) => Number(((Number(current) || 0) + value).toFixed(2))), value),
                  ),
                  h(
                    'button',
                    {
                      className: 'pa-quick-btn',
                      type: 'button',
                      onClick: () => setAmount(Math.min(maxOrderUsd, remaining, Number(live?.cash ?? remaining))),
                    },
                    t('max'),
                  ),
                ),
                h('p', { className: 'pa-bet-hint' }, t('marketHint')),
                h(
                  'div',
                  { className: 'pa-bet-summary' },
                  h(
                    'div',
                    { className: 'pa-bet-summary-row' },
                    h('span', null, t('estAvgPrice')),
                    h('strong', null, priceCents(marketPrice)),
                  ),
                  h(
                    'div',
                    { className: 'pa-bet-summary-row' },
                    h('span', null, t('estShares')),
                    h('strong', null, estShares.toFixed(2)),
                  ),
                  h(
                    'div',
                    { className: 'pa-bet-summary-row' },
                    h('span', null, t('dailyLeft')),
                    h('strong', null, usd(remaining)),
                  ),
                ),
              )
            : h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'pa-bet-field-row' },
                  h('span', null, t('limitPrice')),
                  h(
                    'div',
                    { className: 'pa-stepper' },
                    h('button', { className: 'pa-stepper-btn', type: 'button', onClick: () => priceStep(-tickSize), 'aria-label': t('lowerPrice') }, '−'),
                    h(
                      'label',
                      { className: 'pa-stepper-field' },
                      h('input', {
                        type: 'number',
                        min: 0,
                        step: Number((tickSize * 100).toFixed(4)),
                        inputMode: 'decimal',
                        value: Number((limitPrice * 100).toFixed(2)),
                        onChange: (event) => {
                          priceTouched.current = true
                          setLimitPrice(Number(event.target.value) / 100)
                        },
                        onBlur: () => setLimitPrice((current) => snapPrice(current)),
                        'aria-label': t('limitPrice'),
                      }),
                      h('span', null, '¢'),
                    ),
                    h('button', { className: 'pa-stepper-btn', type: 'button', onClick: () => priceStep(tickSize), 'aria-label': t('higherPrice') }, '+'),
                  ),
                ),
                h(
                  'div',
                  { className: 'pa-bet-field-row' },
                  h(
                    'span',
                    null,
                    t('shares'),
                    h('small', { className: 'pa-bet-subhint' }, `${t('minimum')} ${minSharesForTotal.toFixed(2)}`),
                  ),
                  h('input', {
                    className: 'pa-input pa-input--num pa-input--right',
                    type: 'number',
                    min: 0,
                    step: 0.01,
                    inputMode: 'decimal',
                    value: shareCount,
                    onChange: (event) => {
                      sharesTouched.current = true
                      setShareCount(Number(event.target.value))
                    },
                    'aria-label': t('shares'),
                  }),
                ),
                h(
                  'div',
                  { className: 'pa-quick-row' },
                  [-100, -10, 10, 100].map((value) =>
                    chip(`${value > 0 ? '+' : ''}${value}`, () => shareStep(value), value),
                  ),
                ),
                h('p', { className: 'pa-bet-hint' }, t('limitHint')),
                h(
                  'div',
                  { className: 'pa-bet-summary' },
                  h(
                    'div',
                    { className: 'pa-bet-summary-row' },
                    h('span', null, t('orderTotal')),
                    h('strong', null, usd(limitTotal)),
                  ),
                  h(
                    'div',
                    { className: 'pa-bet-summary-row' },
                    h('span', null, t('validUntil')),
                    h('strong', null, t('gtc')),
                  ),
                  h(
                    'div',
                    { className: 'pa-bet-summary-row' },
                    h('span', null, t('dailyLeft')),
                    h('strong', null, usd(remaining)),
                  ),
                ),
                h(
                  'div',
                  { className: `pa-bet-state${crossing ? ' pa-bet-state--live' : ''}` },
                  h('span', { className: 'pa-bet-state-dot' }),
                  crossing ? t('crossingNow') : t('restingOrder'),
                ),
              ),
        ),
        h(
          'div',
          { className: 'pa-payout' },
          h(
            'div',
            { className: 'pa-payout-copy' },
            h('div', { className: 'pa-payout-label' }, `💵 ${t('youWin')}`),
            h('div', { className: 'pa-payout-note' }, mode === 'market' ? t('payoutNoteMarket') : t('payoutNoteLimit')),
          ),
          h('div', { className: 'pa-payout-value' }, usd(payout)),
        ),
        reason ? h('p', { className: 'pa-warn' }, reason) : null,
        mode === 'market' && tooSmall ? h('p', { className: 'pa-warn' }, t('minHint', { min: minMarketUsd.toFixed(2) })) : null,
        mode === 'limit' && tooSmall
          ? h('p', { className: 'pa-warn' }, t('minSharesHint', { min: minSharesForTotal.toFixed(2) }))
          : null,
        priceInvalid ? h('p', { className: 'pa-warn' }, t('limitPriceInvalid', { tick: priceCents(tickSize) })) : null,
        overCap ? h('p', { className: 'pa-warn' }, t('priceCap', { max: usd(maxOrderUsd) })) : null,
        overDaily ? h('p', { className: 'pa-warn' }, t('dailyCapHint', { left: usd(remaining) })) : null,
        overCash ? h('p', { className: 'pa-warn' }, t('overCash', { cash: usd(availableCash) })) : null,
        error ? h('p', { className: 'pa-warn' }, error) : null,
        h(
          'div',
          { className: 'pa-modal-actions' },
          h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', onClick: close, disabled: sending }, t('cancel')),
          h(
            'button',
            {
              className: 'pa-btn pa-btn--yes',
              type: 'button',
              disabled: !canSubmit,
              onClick: () => {
                setSending(true)
                setError(null)
                const payload =
                  mode === 'market'
                    ? { orderType: 'market', amountUsd: now, maxPrice: marketPrice }
                    : { orderType: 'limit', price: limit, shares: quantity }
                Promise.resolve(submit(payload))
                  .catch((err) => setError(orderErrorText(err.message ?? err, t, live)))
                  .finally(() => setSending(false))
              },
            },
            sending ? t('sending') : mode === 'market' ? t('confirmBet') : t('placeLimit'),
          ),
        ),
      )
    }

    function CloseModal({ state, close, submit, t, live }) {
      const position = state.position
      const [shares, setShares] = useState(position.size)
      const [sending, setSending] = useState(false)
      const [error, setError] = useState(null)
      const max = position.size
      const valid = Number(shares) > 0 && Number(shares) <= max + 1e-9
      return h(
        Modal,
        { title: t('closeTitle'), subtitle: `${position.title} · ${position.outcome}`, close, t },
        h('div', { className: 'pa-kv' }, h('span', null, t('size')), h('span', null, `${max.toFixed(4)}`)),
        h('div', { className: 'pa-kv' }, h('span', null, t('currentPrice')), h('span', null, cents(position.currentPrice))),
        h(
          'label',
          { className: 'pa-field' },
          h('span', null, t('sharesToClose')),
          h('input', {
            className: 'pa-input pa-input--num',
            type: 'number',
            min: 0,
            max,
            step: 0.01,
            value: shares,
            onChange: (event) => setShares(Number(event.target.value)),
          }),
        ),
        h('div', { className: 'pa-kv' }, h('span', null, t('estimatedProceeds')), h('span', null, usd(Number(shares) * position.currentPrice))),
        h('p', { className: 'pa-hint pa-hint--left' }, t('closeSub')),
        error ? h('p', { className: 'pa-warn' }, error) : null,
        h(
          'div',
          { className: 'pa-modal-actions' },
          h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', onClick: close, disabled: sending }, t('cancel')),
          h(
            'button',
            {
              className: 'pa-btn pa-btn--danger',
              type: 'button',
              disabled: sending || !valid,
              onClick: () => {
                setSending(true)
                setError(null)
                Promise.resolve(submit({ shares: Number(shares) }))
                  .catch((err) => setError(String(err.message ?? err)))
                  .finally(() => setSending(false))
              },
            },
            sending ? t('sending') : t('closeConfirm'),
          ),
        ),
      )
    }

    // ------------------------------------------------------------- positions

    function PositionsView({ portfolio, live, t, onBack, onClosePosition, onRefresh }) {
      const [tab, setTab] = useState('current')
      const current = portfolio?.positions ?? []
      const history = portfolio?.history ?? []
      return h(
        'div',
        { className: 'pa-view' },
        h(
          'div',
          { className: 'pa-view-head' },
          h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', onClick: onBack }, `← ${t('back')}`),
          h('h2', { className: 'pa-h2' }, t('positionsTitle')),
          h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', onClick: onRefresh }, t('refresh')),
        ),
        h(
          'div',
          { className: 'pa-stats pa-stats--three' },
          h(Stat, { label: t('positionsValue'), value: portfolio?.value === null ? '—' : usd(portfolio?.value ?? 0) }),
          h(Stat, { label: t('cash'), value: portfolio?.cash === null ? '—' : usd(portfolio?.cash ?? 0) }),
          h(Stat, { label: t('total'), value: portfolio?.total === null ? '—' : usd(portfolio?.total ?? 0) }),
        ),
        h(
          'div',
          { className: 'pa-tabs' },
          h(
            'button',
            { className: `pa-tab${tab === 'current' ? ' pa-tab--on' : ''}`, type: 'button', onClick: () => setTab('current') },
            t('currentPositions'),
            h('span', { className: 'pa-tab-count' }, current.length),
          ),
          h(
            'button',
            { className: `pa-tab${tab === 'history' ? ' pa-tab--on' : ''}`, type: 'button', onClick: () => setTab('history') },
            t('history'),
            h('span', { className: 'pa-tab-count' }, history.length),
          ),
        ),
        tab === 'current'
          ? h(
              'div',
              { className: 'pa-table' },
              h(
                'div',
                { className: 'pa-grid pa-grid--positions pa-grid--head' },
                h('div', null, t('colMarket')),
                h('div', null, t('outcome')),
                h('div', null, t('size')),
                h('div', null, t('avgPrice')),
                h('div', null, t('currentPrice')),
                h('div', null, t('marketValue')),
                h('div', null, t('pnl')),
                h('div', null, ''),
              ),
              current.length === 0
                ? portfolio?.errors?.length
                  ? h(
                      'div',
                      { className: 'pa-empty pa-empty--inline' },
                      `${t('positionsUnavailable')} `,
                      h('button', { className: 'pa-btn pa-btn--ghost pa-btn--sm', type: 'button', onClick: onRefresh }, t('retry')),
                    )
                  : h('div', { className: 'pa-empty pa-empty--inline' }, t('noPositions'))
                : current.map((position) =>
                    h(
                      'div',
                      { className: 'pa-grid pa-grid--positions pa-row', key: `${position.tokenId}` },
                      h(
                        'div',
                        { className: 'pa-pos-title' },
                        position.icon ? h('img', { className: 'pa-icon-img', src: position.icon, alt: '', loading: 'lazy' }) : null,
                        h(
                          'div',
                          { className: 'pa-pos-copy' },
                          h('span', { className: 'pa-title', title: position.title }, position.title),
                          h(
                            'span',
                            { className: 'pa-sub' },
                            position.redeemable ? h(Chip, { tone: 'warn' }, t('redeemable')) : null,
                            h('span', { className: 'pa-sub-text' }, `${position.avgPrice ? cents(position.avgPrice) : '—'} → ${cents(position.currentPrice)}`),
                          ),
                        ),
                      ),
                      h('div', { className: 'pa-num' }, position.outcome || '—'),
                      h('div', { className: 'pa-num' }, position.size.toFixed(2)),
                      h('div', { className: 'pa-num' }, cents(position.avgPrice)),
                      h('div', { className: 'pa-num' }, cents(position.currentPrice)),
                      h('div', { className: 'pa-num pa-num--strong' }, usd(position.currentValue)),
                      h(
                        'div',
                        { className: `pa-num ${position.percentPnl >= 0 ? 'pa-num--green' : 'pa-num--red'}` },
                        `${position.percentPnl >= 0 ? '+' : ''}${position.percentPnl.toFixed(1)}%`,
                      ),
                      h(
                        'div',
                        { className: 'pa-actions' },
                        position.redeemable
                          ? h(
                              'a',
                              { className: 'pa-btn pa-btn--ghost pa-btn--sm', href: polyLink('/portfolio'), target: '_blank', rel: 'noopener noreferrer' },
                              t('redeemHint'),
                            )
                          : h(
                              'button',
                              { className: 'pa-btn pa-btn--danger pa-btn--sm', type: 'button', disabled: !live?.ready, onClick: () => onClosePosition(position) },
                              t('closePosition'),
                            ),
                      ),
                    ),
                  ),
              portfolio?.stale ? h('p', { className: 'pa-hint pa-hint--left' }, t('staleHint')) : null,
              portfolio?.errors?.length ? h('p', { className: 'pa-hint pa-hint--left' }, portfolio.errors.join(' · ')) : null,
            )
          : h(
              'div',
              { className: 'pa-table' },
              h(
                'div',
                { className: 'pa-grid pa-grid--history pa-grid--head' },
                h('div', null, t('when')),
                h('div', null, t('colMarket')),
                h('div', null, t('type')),
                h('div', null, t('outcome')),
                h('div', null, t('price')),
                h('div', null, t('size')),
                h('div', null, t('amount')),
              ),
              history.length === 0
                ? h('div', { className: 'pa-empty pa-empty--inline' }, t('noHistory'))
                : history.map((row, index) =>
                    h(
                      'div',
                      { className: 'pa-grid pa-grid--history pa-row', key: `${row.txHash ?? index}-${index}` },
                      h('div', { className: 'pa-stamp' }, timeLabel(row.at)),
                      h('div', { className: 'pa-title', title: row.title }, row.title),
                      h('div', { className: 'pa-num' }, row.type),
                      h('div', { className: 'pa-num' }, row.outcome ?? (row.side ?? '—')),
                      h('div', { className: 'pa-num' }, row.price ? cents(row.price) : '—'),
                      h('div', { className: 'pa-num' }, row.size ? row.size.toFixed(2) : '—'),
                      h('div', { className: 'pa-num pa-num--strong' }, row.usdc ? usd(row.usdc) : '—'),
                    ),
                  ),
            ),
      )
    }

    // ---------------------------------------------------------------- orders

    /** Orders the venue has not finished yet: resting limit or still posting. */
    const isActiveOrder = (order) => order?.status === 'pending' || order?.status === 'open'

    function OrdersView({ orders, live, t, onBack, onRefresh, onCancel, onBrowse }) {
      const pendingUsd = Number(live?.pendingUsd ?? 0)
      return h(
        'div',
        { className: 'pa-view' },
        h(
          'div',
          { className: 'pa-view-head' },
          h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', onClick: onBack }, `← ${t('back')}`),
          h('h2', { className: 'pa-h2' }, t('ordersTitle')),
          orders.length
            ? h('span', { className: 'pa-stamp' }, `${orders.length} ${t('ordersUnit')} · ${t('ordersPending')} ${usd(pendingUsd)}`)
            : null,
          h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', onClick: onRefresh }, t('refresh')),
        ),
        h(
          'div',
          { className: 'pa-table' },
          h(
            'div',
            { className: 'pa-grid pa-grid--orders pa-grid--head' },
            h('div', null, t('colMarket')),
            h('div', null, t('price')),
            h('div', null, t('size')),
            h('div', null, t('amount')),
            h('div', null, t('when')),
            h('div', null, ''),
          ),
          orders.length === 0
            ? h(
                'div',
                { className: 'pa-empty pa-empty--inline' },
                h('span', null, t('noOpenOrders')),
                h('button', { className: 'pa-btn pa-btn--ghost pa-btn--sm', type: 'button', onClick: onBrowse }, t('ordersBrowse')),
              )
            : orders.map((order) => {
                const sell = order.kind === 'SELL'
                const filled = Number(order.filledShares ?? 0)
                const total = Number(order.shares ?? 0)
                const partial = order.status === 'open' && filled > 0
                const sizeText =
                  total > 0 ? (partial ? `${filled.toFixed(2)} / ${total.toFixed(2)}` : total.toFixed(2)) : filled > 0 ? filled.toFixed(2) : '—'
                const side = sell
                  ? `${t('orderSell')} ${order.label ?? ''}`.trim()
                  : `${t('orderBuy')} ${order.label || order.outcome || ''}`.trim()
                const type = sell ? null : order.orderType === 'limit' ? t('orderTypeLimit') : t('orderTypeMarket')
                return h(
                  'div',
                  { className: 'pa-grid pa-grid--orders pa-row', key: order.id },
                  h(
                    'div',
                    { className: 'pa-pos-copy' },
                    h('span', { className: 'pa-title', title: order.title || side }, order.title || side),
                    h(
                      'span',
                      { className: 'pa-sub' },
                      h(Chip, { tone: 'blue' }, t(`order_${order.status}`)),
                      h(Chip, null, side),
                      type ? h(Chip, null, type) : null,
                    ),
                  ),
                  h('div', { className: 'pa-num' }, cents(order.price)),
                  h('div', { className: 'pa-num' }, sizeText),
                  h('div', { className: 'pa-num pa-num--strong' }, usd(order.notional)),
                  h('div', { className: 'pa-stamp' }, timeLabel(order.at)),
                  h(
                    'div',
                    { className: 'pa-actions' },
                    order.status === 'open' && order.orderId
                      ? h(
                          'button',
                          {
                            className: 'pa-btn pa-btn--sm pa-btn--ghost',
                            type: 'button',
                            onClick: () => onCancel?.(order),
                          },
                          t('cancelOrder'),
                        )
                      : null,
                  ),
                )
              }),
        ),
        orders.length ? h('p', { className: 'pa-hint pa-hint--left' }, t('ordersHint')) : null,
      )
    }

    // ---------------------------------------------------------------- detail

    function SideButtons({ market, t, onBet, disabled }) {
      return h(
        'div',
        { className: 'pa-side-buttons' },
        market.sides.map((side, index) =>
          h(
            'button',
            {
              key: side.token,
              className: `pa-btn pa-btn--sm ${index === 0 ? 'pa-btn--yes' : 'pa-btn--no'}`,
              type: 'button',
              disabled,
              onClick: () => onBet(market, side, index),
            },
            `${side.label} ${cents(side.price)}`,
          ),
        ),
      )
    }

    function EventDetail({ detail, loading, t, onBack, onBet, live }) {
      const event = detail?.event
      const markets = detail?.markets ?? []
      const [openRules, setOpenRules] = useState({})
      const [contextTab, setContextTab] = useState('rules')
      if (loading || !event) {
        return h(
          'div',
          { className: 'pa-view' },
          h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', onClick: onBack }, `← ${t('back')}`),
          h('div', { className: 'pa-empty' }, t('loading')),
        )
      }
      const reason = reasonText(live, t)
      return h(
        'div',
        { className: 'pa-view' },
        h(
          'div',
          { className: 'pa-view-head' },
          h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', onClick: onBack }, `← ${t('back')}`),
          h('span', { className: 'pa-stamp' }, t('marketDetail')),
          h(
            'a',
            { className: 'pa-btn pa-view-open', href: detail.link || polyLink(`/event/${event.slug}`), target: '_blank', rel: 'noopener noreferrer' },
            t('openMarket'),
            h('span', { className: 'pa-open-arrow', 'aria-hidden': true }, '↗'),
          ),
        ),
        h(
          'div',
          { className: 'pa-detail-head' },
          event.icon ? h('img', { className: 'pa-detail-icon', src: event.icon, alt: '', loading: 'lazy' }) : null,
          h(
            'div',
            { className: 'pa-detail-copy' },
            h('h2', { className: 'pa-detail-title' }, event.title),
            h(
              'div',
              { className: 'pa-sub' },
              event.category ? h(Chip, null, t(`cat_${event.category}`)) : null,
              event.newMarket ? h(Chip, { tone: 'green' }, t('badgeNew')) : null,
              event.negRisk ? h(Chip, { tone: 'warn' }, t('badgeNegRisk')) : null,
              h(Chip, null, `${event.marketCount} ${t('outcomes')}`),
              h('span', { className: 'pa-sub-text' }, `${t('ends')} ${dateOnly(event.endDate)} · ${event.closed ? t('badgeEnded') : days(event.days)}`),
              h('span', { className: 'pa-sub-text' }, `${t('vol24h')} ${money(event.volume24h)}`),
            ),
          ),
        ),
        reason ? h('p', { className: 'pa-warn pa-banner' }, reason) : null,
        h(
          'div',
          { className: 'pa-panel' },
          h(
            'div',
            { className: 'pa-section-head' },
            h(
              'div',
              { className: 'pa-tabs', role: 'tablist' },
              h(
                'button',
                {
                  className: `pa-tab${contextTab === 'rules' ? ' pa-tab--on' : ''}`,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': contextTab === 'rules',
                  onClick: () => setContextTab('rules'),
                },
                t('rulesTitle'),
              ),
              h(
                'button',
                {
                  className: `pa-tab${contextTab === 'background' ? ' pa-tab--on' : ''}`,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': contextTab === 'background',
                  onClick: () => setContextTab('background'),
                },
                t('backgroundTitle'),
              ),
            ),
            h('span', { className: 'pa-context-note' }, t('englishSource')),
          ),
          h(
            'div',
            { className: 'pa-tabpanel', role: 'tabpanel' },
            contextTab === 'rules'
              ? h(
                  React.Fragment,
                  null,
                  h('p', { className: 'pa-context-text' }, detail.rules || t('noRules')),
                  detail.event?.resolutionSource
                    ? h('p', { className: 'pa-context-source' }, `${t('resolutionSource')} ${detail.event.resolutionSource}`)
                    : null,
                )
              : h('p', { className: 'pa-context-text' }, detail.background || t('noBackground')),
          ),
        ),
        h(
          'div',
          { className: 'pa-panel' },
          h('div', { className: 'pa-section-head' }, h('h3', { className: 'pa-h3' }, `${t('outcomes')} · ${markets.length}`)),
          h(
            'div',
            { className: 'pa-market-list' },
            markets.length === 0
              ? h('div', { className: 'pa-empty pa-empty--inline' }, t('noMarkets'))
              : markets.map((market) =>
                  h(
                    'div',
                    {
                      className: `pa-market-card${detail.marketSlug && market.slug === detail.marketSlug ? ' pa-market-card--focus' : ''}`,
                      key: market.id,
                    },
                    h(
                      'div',
                      { className: 'pa-market-copy' },
                      h(
                        'div',
                        { className: 'pa-market-head' },
                        h('div', { className: 'pa-title', title: market.question }, market.question),
                        h(
                          'div',
                          { className: 'pa-market-meta' },
                          market.groupLabel ? h(Chip, null, market.groupLabel) : null,
                          h('span', { className: 'pa-meta-item' }, `${t('ends')} ${dateOnly(market.endDate)}`),
                          h('span', { className: 'pa-meta-item' }, `${t('vol24h')} ${money(market.volume24h)}`),
                        ),
                      ),
                      market.rules
                        ? h(
                            'details',
                            { className: 'pa-market-rules', open: Boolean(openRules[market.id]), onToggle: (event_) => setOpenRules({ ...openRules, [market.id]: event_.target.open }) },
                            h('summary', null, t('marketRules')),
                            h('p', { className: 'pa-context-text' }, market.rules),
                          )
                        : null,
                    ),
                    h(SideButtons, { market, t, onBet, disabled: Boolean(reason) || !live?.ready }),
                  ),
                ),
          ),
        ),
      )
    }

    function EventRow({ event, t, onOpen }) {
      return h(
        'div',
        { className: `pa-grid pa-grid--events pa-row${event.pinned ? ' pa-row--pinned' : ''}` },
        h(
          'button',
          { className: 'pa-title-cell', type: 'button', onClick: onOpen },
          event.icon ? h('img', { className: 'pa-icon-img', src: event.icon, alt: '', loading: 'lazy' }) : null,
          h(
            'span',
            { className: 'pa-title-copy' },
            h('span', { className: 'pa-title', title: event.title }, event.title),
            h(
              'span',
              { className: 'pa-sub' },
              event.pinned ? h(Chip, { tone: 'blue' }, t('badgeLink')) : null,
              event.category ? h(Chip, null, t(`cat_${event.category}`)) : null,
              event.closed ? h(Chip, { tone: 'warn' }, t('badgeEnded')) : null,
              event.pinned && !event.inRadar && !event.closed ? h(Chip, null, t('badgeOutside')) : null,
              event.newMarket ? h(Chip, { tone: 'green' }, t('badgeNew')) : null,
              event.negRisk ? h(Chip, { tone: 'warn' }, t('badgeNegRisk')) : null,
              (event.top ?? []).slice(0, 2).map((market) =>
                h(
                  'span',
                  { className: 'pa-preview', key: market.id },
                  `${(market.groupLabel || market.question).slice(0, 26)} ${market.sides
                    .map((side) => `${side.label} ${(side.price * 100).toFixed(1)}¢`)
                    .join(' / ')}`,
                ),
              ),
            ),
          ),
        ),
        h('div', { className: 'pa-num' }, event.closed ? t('badgeEnded') : days(event.days)),
        h('div', { className: 'pa-num' }, event.marketCount),
        h('div', { className: 'pa-num' }, money(event.volume24h)),
        h(
          'div',
          { className: 'pa-actions' },
          h('button', { className: 'pa-btn pa-btn--ghost pa-btn--sm', type: 'button', onClick: onOpen }, t('details')),
          h(
            'a',
            { className: 'pa-btn pa-btn--ghost pa-btn--icon', href: polyLink(`/event/${event.slug}`), target: '_blank', rel: 'noopener noreferrer', title: 'Polymarket' },
            '↗',
          ),
        ),
      )
    }

    // ----------------------------------------------------------------- panel

    function PanelBody() {
      const [data, setData] = useState(null)
      const [scan, setScan] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [view, setView] = useState({ name: 'list' })
      const [detail, setDetail] = useState(null)
      const [detailLoading, setDetailLoading] = useState(false)
      const [modal, setModal] = useState(null)
      const [toast, setToast] = useState(null)
      const [query, setQuery] = useState('')
      const [tab, setTab] = useState('all')
      const [category, setCategory] = useState('all')
      const [link, setLink] = useState(null)
      const [visible, setVisible] = useState(60)
      const [forceSetup, setForceSetup] = useState(false)
      const [guideDismissed, setGuideDismissed] = useState(false)
      const toastTimer = useRef(null)

      const flash = useCallback((message) => {
        setToast(message)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 4500)
      }, [])

      const load = useCallback((force) => {
        setBusy(true)
        setError(null)
        // A language switch invalidated the cached radar: the next read has to
        // force a sweep, whatever the caller asked for.
        const refreshNow = Boolean(force || scanDirty)
        scanDirty = false
        return Promise.all([
          api(`/markets${refreshNow ? '?refresh=1' : ''}`),
          api('/state'),
        ])
          .then(([markets, state]) => {
            setScan(markets)
            setData(state)
          })
          .catch((err) => setError(String(err.message ?? err)))
          .finally(() => setBusy(false))
      }, [])

      useEffect(() => {
        load(false)
        return () => {
          if (toastTimer.current) clearTimeout(toastTimer.current)
        }
      }, [load])

      // Reload the radar when the interface language (and with it the market
      // title language) changes while the panel stays open.
      useEffect(() => {
        const watcher = () => load(false)
        localeWatchers.add(watcher)
        // Re-announce the language in case the Host route was not ready when
        // the module loaded (for example right after a plugin reload).
        localeProbe()
        return () => {
          localeWatchers.delete(watcher)
        }
      }, [load])

      // A pasted event/market link is resolved by the Host straight from Gamma,
      // so an event outside the radar sweep still shows up as a row.
      const linkText = polyLinkTarget(query) ? query.trim() : ''
      useEffect(() => {
        if (!linkText) {
          setLink(null)
          return
        }
        let cancelled = false
        setLink({ text: linkText, loading: true })
        const timer = setTimeout(() => {
          api(`/resolve?url=${encodeURIComponent(linkText)}`)
            .then((payload) => {
              if (cancelled) return
              if (payload?.found) {
                setLink({
                  text: linkText,
                  event: payload.event,
                  inRadar: payload.inRadar,
                  closed: payload.closed,
                  kind: payload.kind,
                  marketSlug: payload.marketSlug ?? '',
                })
              } else {
                setLink({ text: linkText, error: payload?.error ?? 'event-not-found' })
              }
            })
            .catch((err) => {
              if (cancelled) return
              setLink({ text: linkText, error: err?.payload?.error ?? String(err?.message ?? err) })
            })
        }, 350)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [linkText])

      // Refresh the portfolio/order strip periodically; the radar refreshes on
      // its own schedule (nextAt) and on demand.
      useEffect(() => {
        const timer = setInterval(() => {
          api('/state')
            .then((state) => setData(state))
            .catch(() => {})
        }, 45_000)
        return () => clearInterval(timer)
      }, [])

      useEffect(() => {
        const next = scan?.sweep?.nextAt ? Date.parse(scan.sweep.nextAt) : 0
        if (!next) return
        const timer = setInterval(() => {
          if (!scan?.sweep?.running && Date.now() >= next + 5000) {
            api('/markets')
              .then((markets) => {
                setScan(markets)
                return api('/state')
              })
              .then((state) => setData(state))
              .catch(() => {})
          }
        }, 20_000)
        return () => clearInterval(timer)
      }, [scan?.sweep?.nextAt, scan?.sweep?.running])

      const refreshPortfolio = useCallback(() => {
        return api('/state')
          .then((state) => setData(state))
          .catch(() => {})
      }, [])

      const openEvent = useCallback((event) => {
        setView({ name: 'detail' })
        setDetail({ event })
        setDetailLoading(true)
        // A pinned market link opens through the market so the detail view can
        // highlight the outcome the link named.
        const lookup = event.marketSlug || event.slug
        api(`/event?slug=${encodeURIComponent(lookup)}`)
          .then((payload) => setDetail(payload))
          .catch(() => setDetail({ event }))
          .finally(() => setDetailLoading(false))
      }, [])

      const openBet = useCallback(
        (market, side, index) => {
          const outcome = side.label
          const recognized = market.yes !== null && (index === 0 || index === 1)
          const yesIndex = market.sides.findIndex((item) => /^(yes|是)$/i.test(String(item.label).trim()))
          const key = recognized && yesIndex >= 0 ? (yesIndex === index ? 'YES' : 'NO') : 'SIDE'
          setModal({ type: 'bet', target: market, side, outcome: key })
          api(`/book?tokenId=${encodeURIComponent(side.token)}`)
            .then((book) => setModal((current) => (current?.type === 'bet' ? { ...current, book } : current)))
            .catch(() => {})
        },
        [],
      )

      const submitBet = useCallback(
        ({ orderType, amountUsd, maxPrice, price, shares }) => {
          const body = {
            tokenId: modal.side.token,
            orderType,
            title: modal.target.question,
            outcome: modal.outcome,
            label: modal.side.label,
          }
          if (orderType === 'limit') {
            body.price = price
            body.shares = shares
          } else {
            body.amountUsd = amountUsd
            body.maxPrice = maxPrice
          }
          return api('/order', {
            method: 'POST',
            body: JSON.stringify(body),
          }).then((payload) => {
            if (!payload?.ok) throw new Error(payload?.error ?? 'order-failed')
            setModal(null)
            flash(orderType === 'limit' ? t('limitQueued') : t('betQueued'))
            pollOrders()
          })
        },
        [modal, flash],
      )

      const cancelBuy = useCallback(
        (order) => {
          if (!order?.orderId) return Promise.resolve()
          return api('/cancel', {
            method: 'POST',
            body: JSON.stringify({ orderId: order.orderId }),
          })
            .then((payload) => {
              if (!payload?.ok) throw new Error(payload?.error ?? 'cancel-failed')
              flash(t('orderCanceled'))
              return api('/state').then((state) => setData(state))
            })
            .catch((err) => {
              flash(orderErrorText(err.message ?? err, t, data?.live))
              return api('/state').then((state) => setData(state)).catch(() => {})
            })
        },
        [flash, data?.live],
      )

      const pollOrders = useCallback(() => {
        let tries = 0
        const tick = () => {
          tries += 1
          api('/state')
            .then((state) => {
              setData(state)
              const active = (state.live?.orders ?? []).some(
                (order) => order.status === 'pending' || order.status === 'open',
              )
              if (active && tries < 40) setTimeout(tick, 2000)
              else api('/portfolio?refresh=1').then(refreshPortfolio).catch(() => {})
            })
            .catch(() => {})
        }
        setTimeout(tick, 1200)
      }, [refreshPortfolio])

      const openClose = useCallback((position) => setModal({ type: 'close', position }), [])

      const submitClose = useCallback(
        ({ shares }) => {
          return api('/close', {
            method: 'POST',
            body: JSON.stringify({ tokenId: modal.position.tokenId, shares }),
          }).then((payload) => {
            if (!payload?.ok) throw new Error(payload?.error ?? 'order-failed')
            setModal(null)
            flash(t('closeQueued'))
            pollOrders()
          })
        },
        [modal, flash, pollOrders],
      )

      const changeInterval = useCallback(
        (seconds) => {
          setScan((current) => (current ? { ...current, settings: { ...current.settings, refreshSeconds: seconds } } : current))
          setData((current) => (current ? { ...current, settings: { ...current.settings, refreshSeconds: seconds } } : current))
          api('/settings', { method: 'POST', body: JSON.stringify({ refreshSeconds: seconds }) })
            .then(() => {
              flash(t('intervalSaved', { m: Math.round(seconds / 60) }))
              return api('/markets')
            })
            .then((markets) => setScan(markets))
            .catch(() => {})
        },
        [flash],
      )

      if (!data && !error) {
        return h('div', { className: 'pa-page' }, h('div', { className: 'pa-empty' }, t('loading')))
      }
      if (error && !data) {
        return h(
          'div',
          { className: 'pa-page' },
          h(
            'div',
            { className: 'pa-empty' },
            h('h2', null, t('loadFailed')),
            h('p', null, error),
            h('button', { className: 'pa-btn', type: 'button', onClick: () => load(false) }, t('retry')),
          ),
        )
      }

      const onboarding = data?.onboarding ?? { done: true, configured: {} }
      const configured = onboarding.configured ?? {}
      // The guide is evaluated from the panel snapshot, so it is checked only
      // while this plugin is open — never when the Harness itself starts.
      const guide =
        !guideDismissed && data && (FORCE_GUIDE || !(configured.key && configured.wallet))
          ? h(AccountGuide, {
              onContinue: () => {
                setGuideDismissed(true)
                setForceSetup(true)
              },
            })
          : null
      if (forceSetup || !onboarding.done) {
        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'pa-page' },
            h('style', null, CSS),
            h(
              'div',
              { className: 'pa-ob-wrap' },
              h(Onboarding, {
                initial: forceSetup ? { ...onboarding, done: false } : onboarding,
                live: data.live,
                t,
                onDone: () => {
                  setForceSetup(false)
                  load(false)
                },
              }),
            ),
          ),
          guide,
        )
      }

      const portfolio = data?.portfolio ?? {}
      const live = data?.live ?? {}
      const activeOrders = (live.orders ?? []).filter(isActiveOrder)
      const settings = data?.settings ?? scan?.settings ?? {}
      const sweep = scan?.sweep ?? data?.sweep ?? {}
      const events = scan?.events ?? []
      const counts = { all: events.length }
      for (const event of events) {
        const key = event.category ?? 'other'
        counts[key] = (counts[key] ?? 0) + 1
      }
      const categories = [['all', t('catAll'), counts.all]].concat(
        CATEGORY_KEYS.filter((key) => counts[key]).map((key) => [key, t(`cat_${key}`), counts[key]]),
      )
      const scoped = category === 'all' ? events : events.filter((event) => event.category === category)
      const needle = linkText ? '' : query.trim().toLowerCase()
      const filtered = scoped.filter((event) => {
        if (needle && !event.keywords?.includes(needle) && !event.title.toLowerCase().includes(needle)) return false
        if (tab === 'new') return event.newMarket
        if (tab === 'ending') return event.days <= 7
        return true
      })
      const ordered = (tab === 'ending' ? filtered.slice().sort((a, b) => a.days - b.days) : filtered).slice(0, visible)
      // The linked event stays visible whatever the category, tab or text says;
      // at most it is already in the visible rows.
      const pinned = link?.event
        ? { ...link.event, pinned: true, inRadar: link.inRadar, closed: link.closed, kind: link.kind, marketSlug: link.marketSlug }
        : null
      const rows = pinned
        ? [pinned, ...ordered.filter((event) => event.slug !== pinned.slug)]
        : ordered
      const reason = reasonText(live, t)

      const hero = h(
        'header',
        { className: 'pa-hero' },
        h(
          'div',
          { className: 'pa-hero-main' },
          h('h1', { className: 'pa-h1' }, t('title')),
          h('p', { className: 'pa-lede' }, t('lede')),
        ),
        h(
          'div',
          { className: 'pa-hero-actions' },
          h('button', { className: 'pa-btn pa-btn--primary', type: 'button', onClick: () => setModal({ type: 'deposit' }) }, t('deposit')),
          h('button', { className: 'pa-btn', type: 'button', onClick: () => { setView({ name: 'positions' }); refreshPortfolio() } }, t('positions')),
          h(
            'button',
            {
              className: 'pa-btn',
              type: 'button',
              onClick: () => {
                setView({ name: 'orders' })
                refreshPortfolio()
              },
            },
            t('ordersNav'),
            activeOrders.length ? h('span', { className: 'pa-btn-count' }, activeOrders.length) : null,
          ),
          h('button', { className: 'pa-btn pa-btn--ghost', type: 'button', onClick: () => setModal({ type: 'settings' }) }, t('settings')),
        ),
        h(
          'div',
          { className: 'pa-stats' },
          h(Stat, { label: t('portfolio'), value: portfolio.value === null || portfolio.value === undefined ? '—' : usd(portfolio.value), hint: t('portfolioHint') }),
          h(Stat, { label: t('cash'), value: portfolio.cash === null || portfolio.cash === undefined ? '—' : usd(portfolio.cash), hint: t('cashHint') }),
          h(Stat, { label: t('total'), value: portfolio.total === null || portfolio.total === undefined ? '—' : usd(portfolio.total), hint: t('totalHint') }),
          h(Stat, {
            label: t('wallet'),
            value: portfolio.wallet ? `${portfolio.wallet.slice(0, 6)}…${portfolio.wallet.slice(-4)}` : t('noWallet'),
            hint: live.walletType ?? '—',
          }),
        ),
      )

      let body
      if (view.name === 'positions') {
        body = h(PositionsView, {
          portfolio,
          live,
          t,
          onBack: () => setView({ name: 'list' }),
          onClosePosition: openClose,
          onRefresh: () => api('/portfolio?refresh=1').then(refreshPortfolio).catch(() => {}),
        })
      } else if (view.name === 'orders') {
        body = h(OrdersView, {
          orders: activeOrders,
          live,
          t,
          onBack: () => setView({ name: 'list' }),
          onBrowse: () => setView({ name: 'list' }),
          onCancel: cancelBuy,
          onRefresh: refreshPortfolio,
        })
      } else if (view.name === 'detail') {
        body = h(EventDetail, {
          detail,
          loading: detailLoading,
          t,
          live,
          onBack: () => setView({ name: 'list' }),
          onBet: openBet,
        })
      } else {
        body = h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'pa-radar' },
            h(
              'div',
              { className: 'pa-radar-head' },
              h('div', null,
                h('h2', { className: 'pa-h2' }, t('radarTitle')),
                h('span', { className: 'pa-stamp' }, `${t('updated')} ${scan?.generatedAt ? timeLabel(scan.generatedAt, true) : '—'} · ${scan?.counts?.markets ?? 0} ${t('markets')} · ${events.length} ${t('events')} · ${eventNewCount(events)} ${t('newEvents')}`),
              ),
              h(
                'div',
                { className: 'pa-toolbar' },
                h(AutoScan, { sweep, settings, t, onChange: changeInterval, disabled: busy }),
                h('button', { className: 'pa-btn', type: 'button', disabled: busy, onClick: () => load(true) }, busy ? t('scanning') : t('refresh')),
              ),
            ),
            reason ? h('p', { className: 'pa-warn pa-banner' }, reason) : null,
            h(
              'div',
              { className: 'pa-toolbar' },
              h(
                'div',
                { className: 'pa-tabs' },
                [
                  ['all', t('tabAll'), scoped.length],
                  ['new', t('tabNew'), scoped.filter((event) => event.newMarket).length],
                  ['ending', t('tabEnding'), scoped.filter((event) => event.days <= 7).length],
                ].map(([key, label, count]) =>
                  h(
                    'button',
                    {
                      key,
                      className: `pa-tab${tab === key ? ' pa-tab--on' : ''}`,
                      type: 'button',
                      onClick: () => {
                        setTab(key)
                        setVisible(60)
                      },
                    },
                    label,
                    h('span', { className: 'pa-tab-count' }, count),
                  ),
                ),
              ),
              h('input', {
                className: 'pa-input pa-input--search',
                type: 'search',
                placeholder: t('search'),
                value: query,
                onChange: (event) => {
                  setQuery(event.target.value)
                  setVisible(60)
                },
              }),
            ),
            h(
              'div',
              { className: 'pa-cats' },
              categories.map(([key, label, count]) =>
                h(
                  'button',
                  {
                    key,
                    className: `pa-cat${category === key ? ' pa-cat--on' : ''}`,
                    type: 'button',
                    onClick: () => {
                      setCategory(key)
                      setVisible(60)
                    },
                  },
                  label,
                  h('span', { className: 'pa-cat-count' }, count),
                ),
              ),
            ),
            link?.loading ? h('p', { className: 'pa-hint pa-hint--left' }, t('linkResolving')) : null,
            link?.error ? h('p', { className: 'pa-warn pa-banner' }, t('linkNotFound')) : null,
            link?.event ? h('p', { className: 'pa-hint pa-hint--left' }, t('linkResolved')) : null,
            scan?.errors?.length ? h('p', { className: 'pa-hint pa-hint--left' }, scan.errors.join(' · ')) : null,
            h(
              'div',
              { className: 'pa-table' },
              h(
                'div',
                { className: 'pa-grid pa-grid--events pa-grid--head' },
                h('div', null, t('colEvent')),
                h('div', null, t('colEnds')),
                h('div', null, t('colOutcomes')),
                h('div', null, t('colVol24h')),
                h('div', null, ''),
              ),
              rows.length === 0
                ? h('div', { className: 'pa-empty pa-empty--inline' }, t('noRows'))
                : rows.map((event) => h(EventRow, { key: event.id, event, t, onOpen: () => openEvent(event) })),
            ),
            filtered.length > ordered.length
              ? h(
                  'div',
                  { className: 'pa-more' },
                  h('span', { className: 'pa-stamp' }, t('shown', { shown: ordered.length, total: filtered.length })),
                  h(
                    'button',
                    { className: 'pa-btn', type: 'button', onClick: () => setVisible((value) => value + 60) },
                    t('showMore'),
                  ),
                )
              : null,
          ),
        )
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'pa-page' },
          h('style', null, CSS),
          hero,
          body,
          modal?.type === 'deposit' ? h(DepositModal, { portfolio, deposit: data?.deposit, close: () => setModal(null), t }) : null,
          modal?.type === 'settings'
            ? h(SettingsModal, {
                onboarding,
                live: data.live,
                t,
                close: () => setModal(null),
                onSaved: () => load(false),
              })
            : null,
          modal?.type === 'bet' ? h(BetModal, { state: modal, live, close: () => setModal(null), submit: submitBet, t }) : null,
          modal?.type === 'close' ? h(CloseModal, { state: modal, close: () => setModal(null), submit: submitClose, t, live }) : null,
          h(Toast, { message: toast }),
        ),
        guide,
      )
    }

    function eventNewCount(events) {
      return events.filter((event) => event.newMarket).length
    }

    // ------------------------------------------------------------------- icon

    function PanelIcon({ size = 20 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 2, y: 2, width: 20, height: 20, rx: 6, fill: 'currentColor', opacity: 0.14 }),
        h('rect', { x: 6.5, y: 11, width: 3.2, height: 7, rx: 1.2, fill: 'currentColor' }),
        h('rect', { x: 14.3, y: 6, width: 3.2, height: 12, rx: 1.2, fill: 'currentColor' }),
        h('circle', { cx: 17.9, cy: 6, r: 2.1, fill: 'currentColor' }),
        h('path', { d: 'M6 8.2 10.4 6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', opacity: 0.7 }),
      )
    }

    // -------------------------------------------------------------------- css

    const CSS = `
.pa-page { display:flex; flex-direction:column; height:100%; min-height:0; overflow-y:auto; overscroll-behavior:contain; padding:24px 30px 64px; gap:16px;
  color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); font-size:13px; line-height:1.5; }
.pa-page > * { flex:0 0 auto; }
.pa-hero { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:14px 20px; align-items:start;
  background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:14px; padding:16px 18px; }
.pa-hero-main { min-width:0; }
.pa-h1 { margin:0; font-size:20px; font-weight:650; letter-spacing:-.01em; }
.pa-lede { margin:5px 0 0; max-width:70ch; color:var(--dsw-alias-label-secondary); font-size:12.5px; }
.pa-hero-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
.pa-stats { grid-column:1 / -1; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; }
.pa-stats--three { grid-template-columns:repeat(3,minmax(0,1fr)); }
.pa-stat { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:11px; padding:10px 12px; }
.pa-hero .pa-stat { background:var(--dsw-alias-bg-layer-2); }
.pa-stat-label { color:var(--dsw-alias-label-secondary); font-size:11.5px; }
.pa-stat-value { font-size:19px; font-weight:650; margin-top:2px; font-variant-numeric:tabular-nums; }
.pa-stat-hint { color:var(--dsw-alias-label-secondary); font-size:10.5px; margin-top:2px; }
.pa-radar { display:flex; flex-direction:column; gap:12px; }
.pa-radar-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }
.pa-stamp { color:var(--dsw-alias-label-secondary); font-size:11.5px; white-space:nowrap; }
.pa-h2 { margin:0; font-size:15px; font-weight:650; }
.pa-h3 { margin:0; font-size:13px; font-weight:600; }
.pa-toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.pa-tabs { display:flex; gap:2px; padding:3px; border-radius:10px; background:var(--dsw-alias-bg-layer-2); }
.pa-tab { display:inline-flex; align-items:center; gap:6px; border:0; background:transparent; color:var(--dsw-alias-label-secondary);
  font:inherit; font-size:12.5px; padding:5px 10px; border-radius:7px; cursor:pointer; }
.pa-tab:hover { color:var(--dsw-alias-label-primary); }
.pa-tab--on { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); box-shadow:0 1px 2px rgba(0,0,0,.16); }
.pa-tab-count { font-size:11px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.pa-cats { display:flex; flex-wrap:wrap; gap:6px; }
.pa-cat { display:inline-flex; align-items:center; gap:5px; font:inherit; font-size:12px; padding:4px 10px; border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); cursor:pointer; white-space:nowrap; }
.pa-cat:hover { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-border-l2); }
.pa-cat--on { background:var(--dsw-alias-label-primary); border-color:transparent; color:var(--dsw-alias-bg-base); font-weight:600; }
.pa-cat-count { font-size:10.5px; opacity:.72; font-variant-numeric:tabular-nums; }
.pa-input { box-sizing:border-box; font:inherit; font-size:12.5px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:6px 9px; outline:none; }
.pa-input:focus { border-color:var(--dsw-alias-brand-primary); }
.pa-input--search { flex:1 1 220px; min-width:160px; }
.pa-input--num { width:90px; text-align:right; font-variant-numeric:tabular-nums; }
.pa-auto { display:inline-flex; align-items:center; gap:8px; }
.pa-select { box-sizing:border-box; font:inherit; font-size:12px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:4px 6px; outline:none; cursor:pointer; }
.pa-select:disabled { opacity:.5; cursor:not-allowed; }
.pa-table { border:1px solid var(--dsw-alias-border-l1); border-radius:12px; overflow:hidden; background:var(--dsw-alias-bg-layer-1); }
.pa-grid { display:grid; align-items:center; gap:10px; padding:0 14px; }
.pa-grid--events { grid-template-columns:minmax(0,2.6fr) 56px 64px 78px 126px; }
.pa-grid--positions { grid-template-columns:minmax(0,2.2fr) 60px 64px 66px 66px 78px 66px 86px; }
.pa-grid--orders { grid-template-columns:minmax(0,2.4fr) 64px 84px 88px 96px 72px; }
.pa-grid--orders .pa-stamp { text-align:right; }
.pa-grid--history { grid-template-columns:minmax(96px,1.1fr) minmax(0,2.2fr) 70px 64px 58px 62px 72px; }
.pa-grid--head { height:34px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary);
  font-size:11px; text-transform:uppercase; letter-spacing:.04em; border-bottom:1px solid var(--dsw-alias-border-l1); }
.pa-grid--head > div { text-align:right; }
.pa-grid--head > div:first-child { text-align:left; }
.pa-row { border-bottom:1px solid var(--dsw-alias-border-l1); min-height:54px; }
.pa-row:last-child { border-bottom:0; }
.pa-row:hover { background:var(--dsw-alias-bg-layer-2); }
.pa-row--pinned { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent); }
.pa-row--pinned:hover { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.pa-title-cell { display:flex; align-items:center; gap:10px; text-align:left; background:transparent; border:0; padding:8px 0;
  font:inherit; color:inherit; cursor:pointer; min-width:0; width:100%; }
.pa-title-copy { display:flex; flex-direction:column; gap:3px; min-width:0; }
.pa-title { font-weight:500; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
.pa-sub { display:flex; align-items:center; gap:6px; flex-wrap:wrap; min-width:0; }
.pa-sub-text { color:var(--dsw-alias-label-secondary); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
.pa-icon-img { width:34px; height:34px; border-radius:8px; object-fit:cover; flex:0 0 auto; background:var(--dsw-alias-bg-layer-2); }
.pa-num { text-align:right; font-variant-numeric:tabular-nums; font-size:12.5px; color:var(--dsw-alias-label-secondary); }
.pa-num--strong { color:var(--dsw-alias-label-primary); font-weight:600; font-size:13px; }
.pa-num--green { color:var(--dsw-alias-state-success-primary); font-weight:600; }
.pa-num--red { color:var(--dsw-alias-state-error-primary); font-weight:600; }
.pa-actions { display:flex; align-items:center; justify-content:flex-end; gap:6px; }
.pa-quote { display:inline-flex; align-items:center; justify-content:flex-end; gap:5px; border:1px solid transparent; border-radius:8px;
  background:transparent; padding:5px 7px; font:inherit; cursor:pointer; white-space:nowrap; }
.pa-quote:hover { background:var(--dsw-alias-bg-layer-1); border-color:var(--dsw-alias-border-l1); }
.pa-quote-label { font-size:10.5px; color:var(--dsw-alias-label-secondary); }
.pa-quote--a .pa-quote-price { color:var(--dsw-alias-state-success-primary); font-weight:600; font-variant-numeric:tabular-nums; }
.pa-quote--b .pa-quote-price { color:var(--dsw-alias-state-error-primary); font-weight:600; font-variant-numeric:tabular-nums; }
.pa-btn { font:inherit; font-size:12.5px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); padding:5px 11px; cursor:pointer; white-space:nowrap; }
.pa-btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2); }
.pa-btn:disabled { opacity:.5; cursor:not-allowed; }
.pa-btn--yes { background:var(--dsw-alias-state-success-primary); border-color:transparent; color:#04120a; font-weight:600; }
.pa-btn--danger { background:var(--dsw-alias-state-error-primary); border-color:transparent; color:#fff; font-weight:600; }
.pa-btn--no { background:var(--dsw-alias-state-error-primary); border-color:transparent; color:#fff; font-weight:600; }
.pa-btn--sm { padding:4px 9px; font-size:12px; }
.pa-btn--ghost { background:transparent; }
.pa-btn--primary { background:var(--dsw-alias-label-primary); border-color:transparent; color:var(--dsw-alias-bg-base); font-weight:600; }
a.pa-btn { display:inline-flex; align-items:center; justify-content:center; text-decoration:none; }
.pa-btn--icon { padding:5px 8px; line-height:1; }
.pa-btn-count { display:inline-flex; align-items:center; justify-content:center; min-width:16px; height:16px; margin-left:6px;
  vertical-align:middle; padding:0 4px; border-radius:999px; background:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-bg-base); font-size:10.5px; font-weight:650; line-height:1; font-variant-numeric:tabular-nums; }
.pa-chip { display:inline-flex; align-items:center; gap:4px; border-radius:999px; padding:1px 7px; font-size:10.5px;
  border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.pa-chip--green { border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); color:var(--dsw-alias-state-success-primary); }
.pa-chip--warn { border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 50%, transparent); color:var(--dsw-alias-state-warn-primary); }
.pa-chip--red { border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, transparent); color:var(--dsw-alias-state-error-primary); }
.pa-chip--blue { border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); color:var(--dsw-alias-brand-primary); }
.pa-view { display:flex; flex-direction:column; gap:14px; }
.pa-view-head { display:flex; align-items:center; gap:12px; }
.pa-view-head .pa-h2 { flex:1; }
.pa-view-open { margin-left:auto; display:inline-flex; align-items:center; gap:6px; color:var(--dsw-alias-brand-primary);
  border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent); }
.pa-view-head .pa-view-open:hover { border-color:var(--dsw-alias-brand-primary);
  background:color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); }
.pa-open-arrow { font-size:12px; line-height:1; opacity:.85; }
.pa-tabpanel { display:flex; flex-direction:column; gap:8px; }
.pa-detail-head { display:flex; align-items:flex-start; gap:14px; }
.pa-detail-icon { width:56px; height:56px; border-radius:12px; object-fit:cover; flex:0 0 auto; background:var(--dsw-alias-bg-layer-2); }
.pa-detail-copy { display:flex; flex-direction:column; gap:6px; min-width:0; }
.pa-detail-title { margin:0; font-size:19px; font-weight:650; line-height:1.35; }
.pa-detail-event { margin:0; color:var(--dsw-alias-label-secondary); font-size:12.5px; }
.pa-sides { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.pa-side-card { display:flex; flex-direction:column; gap:8px; align-items:stretch; text-align:center;
  border:1px solid var(--dsw-alias-border-l1); border-radius:12px; padding:12px; background:var(--dsw-alias-bg-layer-1); }
.pa-side-card--on { border-color:var(--dsw-alias-brand-primary); box-shadow:0 0 0 1px var(--dsw-alias-brand-primary) inset; }
.pa-side-pick { font:inherit; font-size:12.5px; font-weight:600; color:var(--dsw-alias-label-secondary); background:transparent; border:0; cursor:pointer; }
.pa-side-price { font-size:26px; font-weight:700; font-variant-numeric:tabular-nums; }
.pa-detail-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.pa-panel { border:1px solid var(--dsw-alias-border-l1); border-radius:12px; padding:12px 14px; background:var(--dsw-alias-bg-layer-1);
  display:flex; flex-direction:column; gap:8px; }
.pa-section-head { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
.pa-book { display:flex; flex-direction:column; gap:6px; }
.pa-book-head, .pa-book-cols { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.pa-book-head { font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--dsw-alias-label-secondary); }
.pa-book-col { display:flex; flex-direction:column; gap:3px; }
.pa-book-row { display:flex; justify-content:space-between; gap:10px; font-size:11.5px; }
.pa-book-foot { display:flex; justify-content:space-between; gap:12px; font-size:11.5px; color:var(--dsw-alias-label-secondary);
  border-top:1px solid var(--dsw-alias-border-l1); padding-top:6px; }
.pa-book-empty { color:var(--dsw-alias-label-secondary); font-size:12px; padding:16px 0; text-align:center; }
.pa-context-text { margin:0; font-size:12px; line-height:1.65; white-space:pre-line; color:var(--dsw-alias-label-primary); }
.pa-context-source { margin:0; font-size:11px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.pa-context-note { font-weight:400; font-size:10px; color:var(--dsw-alias-label-secondary); opacity:.8; }
.pa-pos-title { display:flex; align-items:center; gap:10px; min-width:0; }
.pa-pos-copy { display:flex; flex-direction:column; gap:2px; min-width:0; }
.pa-warn { margin:0; color:var(--dsw-alias-state-warn-primary); font-size:12px; }
.pa-banner { border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); border-radius:9px;
  padding:8px 11px; background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); }
.pa-hint { margin-top:8px; max-width:60ch; color:var(--dsw-alias-label-secondary); font-size:12px; text-align:center; }
.pa-hint--left { text-align:left; max-width:none; margin:6px 0 0; }
.pa-link { color:var(--dsw-alias-brand-primary); text-decoration:none; }
.pa-link:hover { text-decoration:underline; }
.pa-mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.pa-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px;
  padding:80px 20px; color:var(--dsw-alias-label-secondary); height:100%; }
.pa-empty--inline { padding:40px 20px; height:auto; }
.pa-more { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.pa-toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%); z-index:60; max-width:min(560px,90vw);
  background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary); border:1px solid var(--dsw-alias-border-l2);
  border-radius:10px; padding:9px 14px; font-size:12.5px; box-shadow:0 10px 30px rgba(0,0,0,.28); }
.pa-guide-backdrop { position:fixed; inset:0; z-index:70; pointer-events:auto; display:flex; align-items:center; justify-content:center;
  padding:20px; background:radial-gradient(80% 60% at 50% 0%, rgba(46,92,255,.24), transparent 70%), rgba(6,10,20,.64);
  backdrop-filter:blur(5px); -webkit-backdrop-filter:blur(5px); }
.pa-guide { box-sizing:border-box; width:min(400px,100%); display:flex; flex-direction:column; align-items:center; gap:9px;
  padding:24px 24px 20px; text-align:center; background:#2E5CFF; color:#fff;
  border:1px solid rgba(255,255,255,.18); border-radius:18px; box-shadow:0 30px 90px rgba(6,14,60,.55); }
.pa-guide-logo { display:block; width:200px; max-width:72%; height:auto; margin:2px 0 9px; }
.pa-guide-question { margin:0; font-size:18px; font-weight:700; line-height:1.35; letter-spacing:-.01em; color:#fff; }
.pa-guide-copy { margin:0; max-width:33ch; color:rgba(255,255,255,.82); font-size:12.5px; line-height:1.65; }
.pa-guide-actions { display:flex; flex-direction:column; gap:8px; width:100%; margin-top:7px; }
.pa-guide-primary, .pa-guide-secondary { box-sizing:border-box; display:flex; align-items:center; justify-content:center;
  width:100%; height:42px; border-radius:10px; font:inherit; font-size:13.5px; text-decoration:none; cursor:pointer; }
.pa-guide-primary { border:1px solid #fff; color:#0B1220; font-weight:700; background:#fff;
  box-shadow:0 8px 22px rgba(7,16,60,.28); transition:background .12s ease, box-shadow .12s ease, transform .12s ease; }
.pa-guide-primary:hover { background:#F1F5FF; box-shadow:0 10px 26px rgba(7,16,60,.36); }
.pa-guide-primary:active { transform:translateY(1px); }
.pa-guide-primary:focus-visible { outline:2px solid #fff; outline-offset:3px; }
.pa-guide-secondary { border:1px solid rgba(255,255,255,.5); background:rgba(255,255,255,.10); color:#fff;
  font-weight:600; transition:background .12s ease, border-color .12s ease; }
.pa-guide-secondary:hover { background:rgba(255,255,255,.19); border-color:rgba(255,255,255,.78); }
.pa-guide-secondary:focus-visible { outline:2px solid #fff; outline-offset:3px; }
.pa-guide-note { margin:1px 0 0; max-width:34ch; color:rgba(255,255,255,.68); font-size:11.5px; line-height:1.55; }
@media (max-width: 460px) {
  .pa-guide { padding:20px 18px 17px; border-radius:16px; }
  .pa-guide-logo { width:170px; }
  .pa-guide-question { font-size:17px; }
}
.pa-backdrop { position:fixed; inset:0; z-index:50; background:rgba(0,0,0,.44); display:flex; align-items:center; justify-content:center; padding:24px; }
.pa-modal { width:min(500px,100%); max-height:88vh; overflow-y:auto; background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l2);
  border-radius:14px; padding:18px 20px; display:flex; flex-direction:column; gap:11px; box-shadow:0 24px 60px rgba(0,0,0,.4); }
.pa-modal--wide { width:min(760px,100%); }
.pa-modal--settings { padding-bottom:0; }
.pa-modal-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.pa-modal-title { margin:0; font-size:16px; font-weight:650; }
.pa-modal-sub { margin:0; color:var(--dsw-alias-label-secondary); font-size:12.5px; overflow-wrap:anywhere; }
.pa-kv { display:flex; justify-content:space-between; gap:16px; font-size:12.5px; }
.pa-kv > span:first-child { color:var(--dsw-alias-label-secondary); }
.pa-kv > span:last-child { text-align:right; max-width:62%; overflow-wrap:anywhere; }

.pa-bet-market { display:flex; align-items:center; gap:11px; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1);
  border-radius:12px; background:var(--dsw-alias-bg-layer-1); }
.pa-bet-icon { width:44px; height:44px; border-radius:9px; object-fit:cover; flex:0 0 auto; background:var(--dsw-alias-bg-layer-2); }
.pa-bet-icon--empty { display:flex; align-items:center; justify-content:center; font-size:20px; }
.pa-bet-market-copy { flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }
.pa-bet-question { font-size:12px; line-height:1.4; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.pa-bet-outcome { display:flex; align-items:center; gap:6px; font-size:15px; font-weight:650; }
.pa-bet-outcome-dot { width:7px; height:7px; border-radius:999px; background:var(--dsw-alias-state-success-primary);
  box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent); }
.pa-bet-quote { margin-left:auto; color:var(--dsw-alias-state-success-primary); font-size:21px; font-weight:700;
  font-variant-numeric:tabular-nums; white-space:nowrap; }
.pa-bet-toolbar { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.pa-seg { display:inline-flex; padding:3px; border-radius:9px; background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1); }
.pa-seg-btn { border:0; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12.5px;
  padding:5px 14px; border-radius:7px; cursor:pointer; }
.pa-seg-btn--on { background:var(--dsw-alias-label-primary); color:var(--dsw-alias-bg-base); font-weight:650; }
.pa-book-toggle { border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-secondary);
  font:inherit; font-size:11.5px; padding:5px 9px; border-radius:8px; cursor:pointer; }
.pa-book-toggle:hover, .pa-book-toggle--on { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2); }
.pa-bet-book { display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:9px 10px 10px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
.pa-bet-book-side { min-width:0; }
.pa-bet-book-title { margin-bottom:3px; font-size:10.5px; letter-spacing:.04em; text-transform:uppercase;
  color:var(--dsw-alias-label-secondary); }
.pa-bet-book-level { display:flex; justify-content:space-between; gap:8px; width:100%; border:0; background:transparent;
  color:var(--dsw-alias-label-primary); font:inherit; font-size:11.5px; padding:3px 4px; border-radius:6px; cursor:pointer;
  font-variant-numeric:tabular-nums; }
.pa-bet-book-level:hover { background:var(--dsw-alias-bg-layer-2); }
.pa-bet-book-level--ask span:first-child { color:var(--dsw-alias-state-error-primary); }
.pa-bet-book-level--bid span:first-child { color:var(--dsw-alias-state-success-primary); }
.pa-bet-book-level span:last-child { color:var(--dsw-alias-label-secondary); }
.pa-bet-book-empty { padding:8px 4px; color:var(--dsw-alias-label-secondary); font-size:11px; }
.pa-bet-panel { display:flex; flex-direction:column; gap:9px; }
.pa-bet-label { display:flex; align-items:baseline; justify-content:space-between; gap:10px; font-size:12.5px;
  color:var(--dsw-alias-label-secondary); }
.pa-bet-amount { display:flex; align-items:baseline; gap:4px; padding:0 2px; border-bottom:1px solid var(--dsw-alias-border-l2); }
.pa-bet-amount-unit { color:var(--dsw-alias-label-secondary); font-size:24px; }
.pa-bet-amount input { flex:1; width:100%; min-width:0; border:0; outline:none; background:transparent;
  color:var(--dsw-alias-label-primary); font:inherit; font-size:36px; font-weight:650; text-align:right;
  font-variant-numeric:tabular-nums; padding:3px 0 5px; appearance:textfield; }
.pa-bet-hint { margin:0; color:var(--dsw-alias-label-secondary); font-size:11.5px; line-height:1.5; }
.pa-quick-row { display:flex; justify-content:flex-end; gap:6px; flex-wrap:wrap; }
.pa-quick-btn { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary); border-radius:999px; padding:4px 10px; font:inherit; font-size:11.5px;
  cursor:pointer; font-variant-numeric:tabular-nums; }
.pa-quick-btn:hover { border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); }
.pa-bet-summary { display:flex; flex-direction:column; gap:5px; padding-top:8px;
  border-top:1px solid var(--dsw-alias-border-l1); }
.pa-bet-summary-row { display:flex; justify-content:space-between; gap:12px; font-size:12px;
  color:var(--dsw-alias-label-secondary); }
.pa-bet-summary-row strong { color:var(--dsw-alias-label-primary); font-weight:600; font-variant-numeric:tabular-nums; }
.pa-bet-field-row { display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:12.5px; }
.pa-bet-field-row > span { display:flex; flex-direction:column; gap:2px; color:var(--dsw-alias-label-secondary); }
.pa-bet-subhint { font-size:10.5px; opacity:.8; }
.pa-bet-field-row .pa-input--num { width:92px; }
.pa-stepper { display:grid; grid-template-columns:30px 92px 30px; gap:5px; align-items:center; }
.pa-stepper-btn { display:inline-flex; align-items:center; justify-content:center; height:30px; border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary); font:inherit; font-size:15px; line-height:1; cursor:pointer; }
.pa-stepper-btn:hover { border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); }
.pa-stepper-field { position:relative; display:block; }
.pa-stepper-field input { box-sizing:border-box; width:100%; height:30px; border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; text-align:right; padding:0 21px 0 8px;
  outline:none; font-variant-numeric:tabular-nums; appearance:textfield; }
.pa-stepper-field input:focus { border-color:var(--dsw-alias-brand-primary); }
.pa-stepper-field span { position:absolute; right:8px; top:50%; transform:translateY(-50%);
  color:var(--dsw-alias-label-secondary); font-size:12px; pointer-events:none; }
.pa-bet-state { display:inline-flex; align-items:center; gap:6px; align-self:flex-end; padding:3px 8px;
  border-radius:999px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary);
  font-size:10.5px; }
.pa-bet-state--live { color:var(--dsw-alias-state-success-primary);
  border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 42%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 9%, transparent); }
.pa-bet-state-dot { width:6px; height:6px; border-radius:999px; background:currentColor; }
.pa-payout { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:13px 14px;
  border-radius:12px; border:1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 34%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
.pa-payout-copy { display:flex; flex-direction:column; gap:3px; min-width:0; }
.pa-payout-label { font-size:14px; font-weight:650; }
.pa-payout-note { color:var(--dsw-alias-label-secondary); font-size:10.5px; line-height:1.45; }
.pa-payout-value { color:var(--dsw-alias-state-success-primary); font-size:34px; font-weight:700;
  letter-spacing:-.02em; font-variant-numeric:tabular-nums; white-space:nowrap; }
.pa-field { display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:12.5px; }
.pa-check { display:flex; align-items:flex-start; gap:8px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.pa-modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:4px; }
.pa-deposit { display:flex; flex-direction:column; gap:10px; }
.pa-deposit-field { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px; border-radius:10px;
  background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); }
.pa-deposit-label { font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.pa-deposit-address { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; overflow-wrap:anywhere; flex:1 1 220px; }
.pa-deposit-hero { display:flex; flex-direction:column; gap:8px; padding:12px; border-radius:11px;
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, transparent);
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, transparent); }
.pa-deposit-hero-title { font-size:13.5px; font-weight:650; }
.pa-deposit-card { display:flex; flex-direction:column; gap:8px; padding:12px; border-radius:11px;
  background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); }
.pa-deposit-body { display:flex; align-items:flex-start; gap:14px; flex-wrap:wrap; }
.pa-deposit-main { flex:1 1 280px; min-width:0; display:flex; flex-direction:column; gap:8px; }
.pa-deposit-qr { display:flex; flex-direction:column; align-items:center; gap:6px; padding:8px; border-radius:10px; background:#fff; }
.pa-deposit-qr img { width:156px; height:156px; display:block; image-rendering:pixelated; }
.pa-deposit-qr-hint { font-size:11px; color:#4b5563; }
.pa-deposit-bridge { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:7px 9px; border-radius:8px;
  background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1);
  font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.pa-deposit-bridge-via { color:var(--dsw-alias-label-tertiary); }
.pa-deposit-bridge-leg { display:inline-flex; align-items:center; gap:6px; min-width:0; }
.pa-deposit-tx { flex:0 0 auto; font-size:10.5px; line-height:1.45; padding:0 6px; border-radius:6px; text-decoration:none;
  color:var(--dsw-alias-label-secondary); border:1px solid var(--dsw-alias-border-l2); }
.pa-deposit-tx:hover { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-border-l3); text-decoration:none; }
.pa-deposit-card-head { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.pa-deposit-card-label { font-size:12.5px; font-weight:600; }
.pa-deposit-badge { font-size:10.5px; padding:1px 7px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-secondary); }
.pa-deposit-badge--ok { color:var(--dsw-alias-state-success-primary);
  border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); }
.pa-deposit-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.pa-deposit-form { display:flex; flex-direction:column; gap:8px; padding:11px; border-radius:10px;
  background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); }
.pa-deposit-form h3 { margin:0; font-size:13px; font-weight:600; }
.pa-deposit-form .pa-input { width:100%; }
.pa-ok { margin:0; font-size:12px; color:var(--dsw-alias-state-success-primary); }
.pa-ob-wrap { width:min(720px,100%); margin:0 auto; }
.pa-ob { display:flex; flex-direction:column; gap:16px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1);
  border-radius:14px; padding:18px 20px; }
.pa-ob--embedded { background:transparent; border:0; border-radius:0; padding:0; gap:14px; }
.pa-ob-head { display:flex; align-items:center; gap:12px; }
.pa-steps { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; list-style:none; margin:0; padding:0; }
.pa-step { display:flex; align-items:center; gap:7px; min-width:0; color:var(--dsw-alias-label-secondary); font-size:11.5px; }
.pa-step-dot { width:22px; height:22px; border-radius:999px; display:inline-flex; align-items:center; justify-content:center;
  flex:0 0 auto; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1);
  font-size:11px; font-weight:600; line-height:1; }
.pa-step-label { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pa-step--active { color:var(--dsw-alias-label-primary); font-weight:600; }
.pa-step--active .pa-step-dot { background:var(--dsw-alias-label-primary); border-color:transparent; color:var(--dsw-alias-bg-base); }
.pa-step--done .pa-step-dot { color:var(--dsw-alias-state-success-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 52%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.pa-ob-step { display:flex; flex-direction:column; gap:12px; }
.pa-ob .pa-input { width:100%; }
.pa-ob .pa-input--num { width:96px; }
.pa-ob-h2 { margin:0; font-size:17px; font-weight:650; }
.pa-ob-copy { display:flex; flex-direction:column; gap:8px; color:var(--dsw-alias-label-secondary); font-size:13px; line-height:1.6; }
.pa-ob-copy p { margin:0; }
.pa-vault { display:flex; flex-direction:column; gap:7px; padding:10px 12px; border-radius:10px;
  background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); }
.pa-vault p { margin:0; }
.pa-vault-title { font-size:12.5px; font-weight:600; color:var(--dsw-alias-label-primary); }
.pa-vault-check { margin-top:1px; }
.pa-vault--attention { border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 48%, transparent); }
.pa-vault-hint { font-size:11.5px; line-height:1.5; color:var(--dsw-alias-state-warn-primary); }
.pa-danger-zone { display:flex; flex-direction:column; gap:8px; margin-top:18px; padding-top:14px;
  border-top:1px solid var(--dsw-alias-border-l1); }
.pa-danger-zone h3 { margin:0; font-size:13px; font-weight:600; color:var(--dsw-alias-state-error-primary); }
.pa-danger-zone p { margin:0; }
.pa-danger-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.pa-ob-nav { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.pa-ob-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.pa-ob-grid { display:flex; flex-direction:column; gap:6px; }
.pa-ob-summary { display:flex; flex-direction:column; gap:6px; padding:11px 12px; border-radius:10px;
  background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); }
.pa-ob-callout { display:flex; flex-direction:column; gap:8px; padding:10px 12px; border-radius:10px;
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); }
.pa-ob-callout p { margin:0; font-size:12px; color:var(--dsw-alias-label-primary); }
.pa-field-block { display:flex; flex-direction:column; gap:5px; }
.pa-field-label { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px;
  color:var(--dsw-alias-label-secondary); }
.pa-align-left { align-self:flex-start; }
.pa-note { display:flex; flex-direction:column; gap:3px; padding:9px 11px; border-radius:9px; font-size:11.5px; line-height:1.55; }
.pa-note p { margin:0; }
.pa-note--warn { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent);
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, transparent); }
.pa-note-title { font-weight:600; color:var(--dsw-alias-state-warn-primary); }
.pa-secret { display:flex; align-items:stretch; gap:6px; }
.pa-secret .pa-input { flex:1 1 auto; width:auto; min-width:0; }
.pa-secret .pa-btn { flex:0 0 auto; }
.pa-shot-btn { position:relative; display:block; width:100%; padding:0; border:0; background:transparent;
  border-radius:10px; cursor:zoom-in; text-align:left; }
.pa-shot { display:block; width:100%; max-height:250px; object-fit:contain; border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px; background:var(--dsw-alias-bg-layer-2); transition:border-color .15s ease; }
.pa-shot-btn:hover .pa-shot { border-color:var(--dsw-alias-border-l3); }
.pa-shot-hint { position:absolute; right:8px; bottom:8px; padding:2px 7px; border-radius:999px;
  background:rgba(0,0,0,.58); color:#fff; font-size:10.5px; line-height:1.5; pointer-events:none; }
.pa-shot--missing { display:flex; align-items:center; justify-content:center; min-height:90px; padding:12px;
  border-style:dashed; border-radius:10px; color:var(--dsw-alias-label-secondary); font-size:12px; text-align:center; }
.pa-lightbox { position:fixed; inset:0; z-index:80; display:flex; align-items:center; justify-content:center;
  padding:28px; background:rgba(0,0,0,.82); cursor:zoom-out; }
.pa-lightbox-img { display:block; max-width:min(1240px,96vw); max-height:90vh; width:auto; height:auto;
  object-fit:contain; border-radius:10px; background:#fff; box-shadow:0 24px 80px rgba(0,0,0,.55); cursor:default; }
.pa-lightbox-close { position:absolute; top:16px; right:18px; width:34px; height:34px; border-radius:999px;
  border:1px solid rgba(255,255,255,.28); background:rgba(0,0,0,.45); color:#fff; font:inherit; font-size:16px;
  line-height:1; cursor:pointer; }
.pa-lightbox-close:hover { background:rgba(0,0,0,.68); }
.pa-lightbox-hint { position:absolute; left:50%; bottom:18px; transform:translateX(-50%); margin:0;
  color:rgba(255,255,255,.72); font-size:11.5px; pointer-events:none; }
.pa-settings { display:flex; flex-direction:column; gap:12px; }
.pa-settings-card { display:flex; flex-direction:column; gap:9px; padding:12px 14px; border:1px solid var(--dsw-alias-border-l1);
  border-radius:12px; background:var(--dsw-alias-bg-layer-1); }
.pa-settings-card--flat { padding:0; border:0; border-radius:0; background:transparent; }
.pa-settings-card--muted { background:transparent; border-style:dashed; }
.pa-settings-card-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.pa-settings-card h3 { margin:0; font-size:13.5px; font-weight:650; }
.pa-settings-lede { margin:0; color:var(--dsw-alias-label-secondary); font-size:11.5px; line-height:1.55; }
.pa-settings-code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; overflow-wrap:anywhere;
  color:var(--dsw-alias-label-secondary); }
.pa-settings-kv { display:flex; flex-direction:column; gap:5px; }
.pa-settings-field { display:flex; flex-direction:column; gap:5px; }
.pa-settings-field .pa-input { width:100%; }
.pa-settings-details { display:flex; flex-direction:column; gap:7px; border-top:1px solid var(--dsw-alias-border-l1); padding-top:9px; }
.pa-settings-details summary { display:flex; align-items:center; justify-content:space-between; gap:8px;
  cursor:pointer; font-size:12.5px; font-weight:600; }
.pa-settings-numbers { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.pa-settings-number { display:flex; flex-direction:column; gap:4px; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.pa-settings-number .pa-input { width:100%; text-align:right; font-variant-numeric:tabular-nums; }
.pa-settings-inline-actions { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.pa-settings-footer { position:sticky; bottom:0; z-index:1; display:flex; align-items:center; justify-content:space-between;
  gap:10px; flex-wrap:wrap; padding:10px 0 16px; border-top:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-overlay); }
@media (max-width: 640px) {
  .pa-steps { grid-template-columns:repeat(4,auto); }
  .pa-step-label { display:none; }
  .pa-settings-numbers { grid-template-columns:1fr; }
  .pa-lightbox { padding:12px; }
}
.pa-preview { font-size:10.5px; color:var(--dsw-alias-label-secondary); border:1px solid var(--dsw-alias-border-l1);
  border-radius:6px; padding:0 5px; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pa-side-buttons { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
.pa-market-list { display:flex; flex-direction:column; }
.pa-market-card { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:14px; align-items:center;
  padding:9px 0; border-top:1px solid var(--dsw-alias-border-l1); }
.pa-market-card:first-child { border-top:0; }
.pa-market-card--focus { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary); padding-left:8px; }
.pa-market-copy { display:flex; flex-direction:column; gap:3px; min-width:0; }
.pa-market-head { display:flex; align-items:baseline; gap:14px; min-width:0; }
.pa-market-head .pa-title { flex:1 1 auto; min-width:0; }
.pa-market-meta { flex:0 0 auto; display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-left:auto;
  color:var(--dsw-alias-label-secondary); font-size:11px; white-space:nowrap; }
.pa-meta-item { font-variant-numeric:tabular-nums; }
.pa-market-rules summary { cursor:pointer; font-size:11px; color:var(--dsw-alias-label-secondary); margin-top:2px; }
.pa-market-rules p { margin:4px 0 0; }
@media (max-width: 900px) {
  .pa-stats { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .pa-grid--events { grid-template-columns:minmax(0,1fr) 48px 56px 62px 96px; }
  .pa-detail-grid { grid-template-columns:1fr; }
  .pa-market-head { flex-direction:column; align-items:flex-start; gap:4px; }
  .pa-market-meta { margin-left:0; flex-wrap:wrap; white-space:normal; }
}
`

    // A throwing render would blank the slot entry; keep the panel alive and
    // surface the message instead of disappearing.
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        console.error('polymarket-agent panel crashed:', error)
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'pa-page' },
            h(
              'div',
              { className: 'pa-empty' },
              h('h2', null, 'Panel error'),
              h('p', null, String(this.state.error?.message ?? this.state.error)),
            ),
          )
        }
        return this.props.children
      }
    }

    function Panel() {
      return h(React.Fragment, null, h(PanelBoundary, null, h(PanelBody, null)))
    }

    // ------------------------------------------------------------------- dict

    const DICT = {
      zh: {
        panel: 'Polymarket Proxy',
        title: 'Polymarket Proxy',
        lede: '你的 Polymarket 资产与盘口面板：顶部是资产组合、现金和充值地址；下面是自动雷达扫描到的盘口，点开即可下注；持仓页可以平仓。',
        loading: '正在读取…',
        loadFailed: '加载失败',
        retry: '重试',
        refresh: '刷新',
        scanning: '扫描中…',
        updated: '更新于',
        close: '关闭',
        cancel: '取消',
        back: '返回',
        portfolio: '资产组合',
        cash: '现金余额',
        positionsValue: '持仓市值',
        total: '总资产',
        wallet: '钱包',
        portfolioHint: '持仓总额',
        cashHint: '可下单余额',
        totalHint: '现金 + 持仓',
        deposit: '充值',
        positions: '持仓',
        settings: '设置',
        settingsHint: '账户、密钥、授权与限额',
        settingsDangerTitle: '注销与清除',
        settingsLogoutWhy: '换账号或不再使用时，可以注销本机凭据。会删除本机保存的钱包、私钥、Relayer 和本地订单记录，并回到初始配置；Polymarket 上的持仓、挂单和链上历史不会被删除，挂单也不会被取消；换账号前请先在 Polymarket 处理。',
        settingsLogout: '注销凭据',
        settingsLogoutConfirm: '确认注销本机凭据并清空本地订单记录？此操作不可撤销。',
        settingsLogoutConfirmBtn: '确认注销',
        settingsLogoutFailed: '注销失败：{error}',
        filterTitle: '关键词过滤',
        filterStats: '当前 {count} 个关键词；最近一次扫描隐藏了 {hidden} 个事件。一行一个词，改完点「刷新」生效。',
        filterNoFile: '尚未创建（下次扫描时自动生成）',
        filterError: '关键词文件读取失败：{error}',

        depositTitle: '充值',
        depositSub:
          '充值 USDT / USDC 到下面这个地址即可。充值过的账户会自动识别地址；新账号从未充值过，请到官网获取充值地址。',
        address: '钱包地址',
        copy: '复制',
        copied: '已复制',
        depositAddress: 'Polymarket 充值地址',
        noWallet: '未配置钱包',
        depositAddressMissing: '暂时没有识别到充值地址',
        depositAddressMissingHint:
          '插件会从链上充值记录自动识别；新账户首次充值前没有记录。打开网页 Deposit 弹窗，把里面的地址复制粘贴一次即可，插件会记住。',
        depositSourceHistory: '链上记录识别',
        depositSourceWallet: '账户钱包',
        depositSourceManual: '手动填写',
        depositSourceUnknown: '未识别',
        depositLoading: '正在识别充值地址…',
        depositWalletSourceHint: '你的账户本身就是 Deposit Wallet，所以充值地址就是账户钱包。',
        depositEvidence: '识别依据：上次到账',
        depositOrigin: '来源',
        depositDestination: '到账',
        depositUnknown: '未知',
        depositQrAlt: '充值地址二维码',
        depositQrHint: '手机扫码获取地址',
        depositViewTx: '查看',
        depositAddressNote: '以网页 Deposit 弹窗为准；不一致就手动填写。',
        depositAddressSameWallet:
          '这是账户钱包（交易钱包），网页标注为 API 专用。如果网页 Deposit 弹窗显示的不是它，请用「手动填写」覆盖。',
        depositLegacyHint: '旧版 Proxy 账户：网页的 Deposit 流程会显示专属充值地址；插件不会从私钥猜地址，识别不到时粘贴一次即可。',
        depositOpenPage: '打开 Polymarket 充值页',
        depositManual: '手动填写地址',
        depositManualEdit: '修改地址',
        depositManualHint: '打开 polymarket.com → Deposit，复制弹窗里的地址。它可能不是账户钱包地址。',
        depositManualSave: '保存地址',
        depositManualClear: '清除手动地址',
        depositInvalidAddress: '地址格式不对，应为 0x 开头的 40 位十六进制。',
        depositSaved: '已保存，优先使用手动地址。',
        depositCleared: '已清除手动地址，恢复自动识别。',
        depositSaveFailed: '操作失败：',
        depositRefreshed: '已重新识别充值地址。',
        depositRefresh: '重新识别',

        positionsTitle: '我的持仓',
        currentPositions: '当前持仓',
        history: '历史记录',
        noPositions: '还没有持仓。打开一个盘口下注后，仓位会出现在这里。',
        noHistory: '还没有成交记录。',
        positionsUnavailable: '持仓数据暂时获取失败（接口限流）。',
        staleHint: '接口暂时不可用，显示的是上次成功获取的数据。',
        colMarket: '市场',
        outcome: '结果',
        size: '份数',
        avgPrice: '均价',
        currentPrice: '现价',
        marketValue: '市值',
        pnl: '盈亏',
        closePosition: '平仓',
        redeemable: '可赎回',
        redeemHint: '去赎回',
        closeTitle: '平仓确认',
        closeSub: '平仓会用市价卖单立即吃掉买盘，成交价可能略低于当前价。',
        sharesToClose: '卖出份数',
        estimatedProceeds: '预计到账',
        closeConfirm: '确认平仓',
        closeQueued: '平仓单已提交，正在撮合',
        closeFailed: '平仓失败',
        when: '时间',
        type: '类型',
        amount: '金额',
        ordersTitle: '进行中的订单',
        ordersNav: '订单',
        ordersUnit: '笔进行中',
        ordersPending: '待成交',
        noOpenOrders: '当前没有进行中的订单。',
        ordersBrowse: '去看盘口',
        ordersHint: '挂单中的限价单会一直挂在盘口，直到成交或撤单；市价单只会在这里短暂出现。',
        order_pending: '执行中',
        order_filled: '已成交',
        order_failed: '失败',
        orderBuy: '买入',
        orderSell: '卖出',

        radarTitle: '盘口雷达',
        markets: '个盘口',
        newMarkets: '个新盘口',
        nextSweep: '下次扫描 {t}',
        sweeping: '扫描中…',
        autoIdle: '等待下一轮',
        sweepRuns: '已自动扫描 {n} 次，上一轮 {ms} ms',
        sweepInterval: '自动雷达间隔',
        interval300: '每 5 分钟',
        interval900: '每 15 分钟',
        interval1800: '每 30 分钟',
        interval3600: '每 1 小时',
        interval7200: '每 2 小时',
        intervalSaved: '自动雷达已改为每 {m} 分钟',
        search: '搜索事件、盘口或标签，也可粘贴 Polymarket 链接…',
        tabAll: '全部',
        tabNew: '新盘口',
        tabEnding: '7 天内到期',
        noRows: '没有符合当前筛选的盘口。换个分类、清空搜索，或直接粘贴 Polymarket 事件链接。',
        noMarkets: '这个事件当前没有可交易的结果市场（可能已结束或已下架）。',
        colEnds: '结束',
        colEvent: '事件',
        colOutcomes: '盘口数',
        colVol24h: '24h 量',
        events: '个事件',
        newEvents: '个新事件',
        outcomes: '个选项',
        marketRules: '市场规则（英文）',
        previewMore: '等',
        details: '详情',
        showMore: '显示更多',
        shown: '已显示 {shown} / {total}',
        buy: '买',
        ends: '结束',
        vol24h: '24h',
        badgeNew: '新',
        badgeNegRisk: '互斥多选',
        catAll: '全部分类',
        cat_sports: '体育',
        cat_crypto: '加密',
        cat_weather: '天气',
        cat_elections: '选举',
        cat_tech: '科技',
        cat_economy: '经济',
        cat_world: '国际',
        cat_politics: '政治',
        cat_culture: '文化',
        cat_other: '其他',
        badgeLink: '链接',
        badgeEnded: '已结束',
        badgeOutside: '不在雷达',
        linkResolving: '正在解析链接…',
        linkResolved: '链接里的事件已固定在列表顶部，点开即可查看盘口。',
        linkNotFound: '链接里没有可交易的盘口：事件可能已下架、链接写错，或没有可下注的二元盘口。',

        marketDetail: '盘口详情',
        marketInfo: '盘口信息',
        orderBook: '订单簿',
        bids: '买盘',
        asks: '卖盘',
        bestBid: '买一',
        bestAsk: '卖一',
        noBook: '当前没有可成交的挂单',
        liquidity: '流动性',
        spread: '价差',
        volume: '总成交',
        event: '事件',
        rulesTitle: '规则',
        eventRules: '事件说明',
        backgroundTitle: '背景',
        englishSource: '英文原文',
        noRules: '这个盘口没有提供规则文本。',
        noBackground: '暂无背景资料。',
        resolutionSource: '结算来源',
        openMarket: '打开 Polymarket',
        marketNotFound: '找不到这个盘口',

        betTitle: '下注确认',
        betSub: '',
        price: '价格',
        maxOrder: '单笔上限',
        dailyLeft: '今日剩余',
        amountUsd: '金额（USD）',
        estShares: '预计份数',
        confirmBet: '确认下注',
        sending: '提交中…',
        betQueued: '订单已提交，正在撮合',
        betFailed: '下单失败',
        orderType: '订单类型',
        marketOrder: '市价',
        limitOrder: '限价',
        marketHint: '按当前卖一价尽快成交；实际成交价可能更优。',
        limitHint: '限价单会一直挂在盘口，直到成交或手动撤销。',
        limitPrice: '限价',
        lowerPrice: '降低价格',
        higherPrice: '提高价格',
        shares: '份额',
        minimum: '最少',
        orderTotal: '总计',
        validUntil: '有效期',
        gtc: '直到成交/撤销（GTC）',
        estAvgPrice: '预估均价',
        availableCash: '可用',
        max: '最大',
        youWin: '赢取',
        payoutNoteMarket: '按预计份数 × 每份 $1 估算，未扣手续费。',
        payoutNoteLimit: '按份数 × 每份 $1 估算，未扣手续费。',
        crossingNow: '预计立即成交',
        restingOrder: '挂单等待成交',
        minSharesHint: '至少 {min} 份，且总额不低于 $1。',
        limitPriceInvalid: '价格必须是有效的 {tick} 档位，且低于 $1。',
        placeLimit: '挂限价单',
        limitQueued: '限价单已提交，挂单中',
        useLimitPrice: '使用 {price} 作为限价',
        orderTypeLimit: '限价',
        orderTypeMarket: '市价',
        order_open: '挂单中',
        order_canceled: '已撤销',
        cancelOrder: '撤单',
        orderCanceled: '限价单已撤销',
        cancelFailed: '撤单失败',
        minHint: '最小 ${min}：Polymarket 拒收低于 $1 的市价买单，且每笔至少 5 份。',
        priceCap: '超过单笔上限 {max}',
        dailyCapHint: '超过今日剩余额度 {left}',
        overCash: '超过可用现金 {cash}',
        configNeeded: '还没有配置 Polymarket 账户：打开「设置」填写私钥和账户钱包地址。',
        tradingDisabled: '下单已在设置里关闭。',
        approvalsMissing: '账户还缺少交易授权：打开「设置」完成一键授权。',
        bridgeNotReady: '交易桥未就绪：{reason}',
        openSettings: '打开设置',
        errorOrderCap: '超过单笔上限 {max}',
        errorDailyCap: '超过今日剩余额度（{left}）',
        errorMinSize: '金额低于最小下单额（至少 $1 且不少于 5 份）',
        errorNoBook: '这个方向当前没有可成交的挂单',
        errorPositionMissing: '找不到这个持仓，可能已经卖出',
        errorPositionRedeemable: '这个持仓已结算，请到 Polymarket 赎回',
        errorGeneric: '下单失败：{error}',

        sourceCredentials: '本机凭据',
        sourceNone: '未配置',
        configured: '已配置',
        required: '必填',
        notConfigured: '未配置',
        show: '显示',
        hide: '隐藏',

        guideQuestion: '你注册过 Polymarket 账号吗？',
        guideCopy: '还没有账号就先注册一个；已经有账号可以直接继续配置。',
        guideRegister: '前往注册',
        guideHaveAccount: '已有账号',
        guideNote: '注册完成后回到这里，点「已有账号」继续。',

        obLater: '稍后配置',
        obNext: '下一步',
        obBack: '上一步',
        obCheckAgain: '刷新状态',
        obWorking: '处理中…',
        obError: '出错了：{error}',
        obShotMissing: '截图待补充：把 {file} 放进 plugin/assets 目录',
        obZoom: '点击放大截图',
        obZoomHint: '点击放大',
        obZoomAlt: 'Polymarket 设置截图',
        obZoomClose: '点击空白处或按 Esc 关闭',
        obStepKey: '私钥',
        obStepWallet: '钱包',
        obStepRelayer: 'Relayer',
        obStepVerify: '授权',
        obKeyTitle: '签名私钥',
        obKeyWhy: '为什么需要私钥：下单必须由你的账户私钥签名，不然无法下单购买，私钥只保存在本机 DSH 凭据库中，不会上传。',
        obVaultTitle: 'DSH 凭据库是什么',
        obVaultWhy: 'DSH 凭据库是 DSH 管理的本机凭据文件（$DSH_HOME/.credentials.yaml），权限 0600，位于项目工作区之外。插件只通过它读写钱包、私钥和 Relayer key，不会主动写进 .env、state.json 或日志，也不会被 DSH 的工作区快照带走。它是本机明文 YAML，不是硬件钱包；安全性取决于这台机器的账户权限和磁盘加密，大额资金建议使用独立钱包或硬件钱包。',
        obVaultAck: '我已了解 DSH 凭据库的工作方式',
        obVaultAckRequired: '请先勾选“我已了解 DSH 凭据库的工作方式”。',
        obVaultAckNeeded: '需要先勾选上面的「我已了解 DSH 凭据库的工作方式」，勾选后才能保存私钥并继续。',
        obKeyWhere: '私钥从哪里来：右上角头像 → 设置 → 账号，向下找到「敏感」里的「私钥」，点「开始导出」并复制（见下图）。下一步再填与它对应的账户钱包地址。',
        obKeyLink: '打开 Polymarket 设置页',
        obKeyRiskTitle: '安全提示',
        obKeyInput: '签名私钥',
        obKeyPlaceholder: '粘贴 0x 开头的 64 位私钥',
        obKeyKeep: '已配置，留空保持不变',
        obKeySavedHint: '已保存私钥。要替换就粘贴新私钥；留空不会改动。',
        obKeyStorageHint: '保存后只写入 DSH 凭据库；留空则保持当前配置。',
        obKeyFormat: '格式：0x + 64 位十六进制，共 66 个字符。',
        obKeyInvalid: '私钥格式不对，请检查是否完整复制。',
        obKeyWarning: '请注意私钥若被第三方知晓，有可能造成损失，当前程序私钥只保存在本机 DSH 凭据库（仅当前用户可读）。',
        obKeySave: '保存并继续',
        obWalletTitle: '账户钱包地址',
        obWalletWhy: '为什么需要钱包地址：私钥对应的只是一个签名者，真正装钱和仓位的是 Polymarket 的账户钱包（Proxy / Safe / Deposit）。插件用这个地址读余额、下订单。',
        obWalletWhere: '在哪里复制：打开个人中心（头像 → 个人资料），点「复制地址」。注意不要填钱包插件里的地址。',
        obWalletLink: '打开个人中心复制地址',
        obWalletInput: '账户钱包地址',
        obWalletDetected: '已检测到：{wallet}',
        obWalletFormat: '格式：0x + 40 位十六进制地址。',
        obWalletInvalid: '钱包地址格式不对，请检查是否完整复制。',
        obWalletUseDetected: '填入已检测到的地址 {wallet}',
        obRelayerTitle: 'Relayer API Key',
        obRelayerWhy: 'Relayer 用来免 Gas 完成授权和钱包部署。首次授权必须配置；如果当前账户已经有交易授权，可以留空直接下一步。',
        obRelayerWhere: '在 Polymarket → 设置 → API 密钥（Predictions）新建，复制 API Key 和上方的「签名者地址」（不是钱包地址）。',
        obRelayerLink: '打开 API Keys 页面',
        obRelayerKey: 'Relayer API Key',
        obRelayerKeyKeep: '已配置，留空保持不变',
        obRelayerKeyPlaceholder: '粘贴 Relayer API Key',
        obRelayerKeyInvalid: 'Relayer API Key 太短，请检查是否完整复制。',
        obRelayerAddress: '签名者地址（不是钱包地址）',
        obRelayerAddressInvalid: '签名者地址格式不对。',
        obRelayerIncomplete: 'Relayer Key 和签名者地址要一起填。',
        obRelayerSaved: '已配置 Relayer；留空不会改动。',
        obRelayerRequired: '首次授权需要 Relayer：请填写 API Key 和签名者地址。',
        obRelayerRequiredHint: '首次授权必须填写 Relayer API Key 和签名者地址。',
        obRelayerApprovedHint: '当前账户已有交易授权，可以留空直接下一步。',
        obRelayerConfigured: 'Relayer',
        obVerifyTitle: '检查并授权',
        obKeyConfigured: '签名私钥',
        obAccount: '账户钱包',
        obWalletType: '钱包类型',
        obCash: '可用余额',
        obApprovals: '交易授权',
        obApproved: '已授权',
        obNotApproved: '缺少授权',
        obApprovedDone: '交易授权已就绪。',
        obApproveWhy: 'Polymarket 要求先授权交易所动用你的 USDC 和结果代币（互斥多选市场还要授权 Neg Risk Adapter），否则订单会被拒绝。这个过程免 Gas，只需一次。',
        obApprove: '一键授权',
        obCapsTitle: '下单限额',
        obCapsEnable: '允许在这个面板里下单',
        obCapOrder: '单笔上限（USD）',
        obCapDaily: '每日上限（USD）',
        obFinish: '保存并完成',
        obRestart: '重新配置',
        obIncomplete: '还缺少私钥或钱包地址，先补齐再完成。',
        obHostStale: 'Host 插件还是旧版本（没有 /onboarding 路由）。重启 dsh web 或重新启用插件后即可使用。',

      },
      en: {
        panel: 'Polymarket Proxy',
        title: 'Polymarket Proxy',
        lede: 'Your Polymarket portfolio and market board: portfolio, cash and deposit address on top; radar-detected markets below, each openable to bet; positions can be closed.',
        loading: 'Loading…',
        loadFailed: 'Could not load',
        retry: 'Retry',
        refresh: 'Refresh',
        scanning: 'Scanning…',
        updated: 'Updated',
        close: 'Close',
        cancel: 'Cancel',
        back: 'Back',
        portfolio: 'Portfolio',
        cash: 'Cash',
        positionsValue: 'Positions',
        total: 'Total',
        wallet: 'Wallet',
        portfolioHint: 'holdings',
        cashHint: 'available to trade',
        totalHint: 'cash + positions',
        deposit: 'Deposit',
        positions: 'Positions',
        settings: 'Settings',
        settingsHint: 'Account, key, approvals and caps',
        settingsDangerTitle: 'Logout and erase',
        settingsLogoutWhy: 'Switch accounts or stop using the plugin? Logging out removes the locally stored wallet, private key, Relayer key and local order records, then returns to setup. Polymarket positions, open orders and on-chain history are not deleted, and open orders are not canceled; handle them on Polymarket before switching accounts.',
        settingsLogout: 'Log out credentials',
        settingsLogoutConfirm: 'Remove all local credentials and local order records? This cannot be undone.',
        settingsLogoutConfirmBtn: 'Log out and clear',
        settingsLogoutFailed: 'Logout failed: {error}',
        filterTitle: 'Keyword filter',
        filterStats: '{count} keywords; the last scan hid {hidden} events. One keyword per line — hit Refresh to apply edits.',
        filterNoFile: 'not created yet (generated on the next scan)',
        filterError: 'Cannot read the keyword file: {error}',

        depositTitle: 'Deposit',
        depositSub:
          'Send USDT / USDC to the address below. Accounts that have deposited before are recognized automatically; a brand-new account has no history yet — get the address from polymarket.com.',
        address: 'Wallet address',
        copy: 'Copy',
        copied: 'Copied',
        depositAddress: 'Polymarket deposit address',
        noWallet: 'No wallet configured',
        depositAddressMissing: 'No deposit address identified yet',
        depositAddressMissingHint:
          'The panel recovers it from public deposit history; a new account has no history before its first deposit. Open the web Deposit modal and paste the address once — the panel will remember it.',
        depositSourceHistory: 'From deposit history',
        depositSourceWallet: 'Account wallet',
        depositSourceManual: 'Entered manually',
        depositSourceUnknown: 'Unknown',
        depositLoading: 'Identifying deposit address…',
        depositWalletSourceHint: 'This account is itself a Deposit Wallet, so its deposit address is the account wallet.',
        depositEvidence: 'Source: last settlement',
        depositOrigin: 'From',
        depositDestination: 'To',
        depositUnknown: 'Unknown',
        depositQrAlt: 'Deposit address QR code',
        depositQrHint: 'Scan with your phone',
        depositViewTx: 'View',
        depositAddressNote: 'The web Deposit modal is the source of truth; overwrite it manually if they differ.',
        depositAddressSameWallet:
          'This is the account wallet, which the web marks API-only. If the web Deposit modal shows a different address, overwrite it with “Enter address manually”.',
        depositLegacyHint:
          'Legacy Proxy account: the web Deposit flow shows a dedicated deposit address. The panel will not guess it from the private key; paste it once if it cannot be recovered.',
        depositOpenPage: 'Open Polymarket deposit page',
        depositManual: 'Enter address manually',
        depositManualEdit: 'Edit address',
        depositManualHint: 'Open polymarket.com → Deposit and copy the address from the modal. It may not be the account wallet.',
        depositManualSave: 'Save address',
        depositManualClear: 'Clear manual address',
        depositInvalidAddress: 'Invalid address; expected 0x followed by 40 hex characters.',
        depositSaved: 'Saved; the manual address now takes priority.',
        depositCleared: 'Manual address cleared; automatic recovery is back.',
        depositSaveFailed: 'Failed:',
        depositRefreshed: 'Deposit address refreshed.',
        depositRefresh: 'Refresh',

        positionsTitle: 'My positions',
        currentPositions: 'Open positions',
        history: 'History',
        noPositions: 'No positions yet. Open a market and place a bet to see it here.',
        noHistory: 'No fills yet.',
        positionsUnavailable: 'Could not load positions right now (the API is throttling requests).',
        staleHint: 'The API is unavailable; showing the last successfully loaded data.',
        colMarket: 'Market',
        outcome: 'Outcome',
        size: 'Shares',
        avgPrice: 'Avg',
        currentPrice: 'Price',
        marketValue: 'Value',
        pnl: 'P/L',
        closePosition: 'Close',
        redeemable: 'Redeemable',
        redeemHint: 'Redeem',
        closeTitle: 'Close position',
        closeSub: 'Closing sends a marketable sell that lifts the bids; the fill may be slightly below the current price.',
        sharesToClose: 'Shares to sell',
        estimatedProceeds: 'Estimated proceeds',
        closeConfirm: 'Close position',
        closeQueued: 'Close order submitted',
        closeFailed: 'Close failed',
        when: 'Time',
        type: 'Type',
        amount: 'Amount',
        ordersTitle: 'Open orders',
        ordersNav: 'Orders',
        ordersUnit: 'in progress',
        ordersPending: 'Pending',
        noOpenOrders: 'No orders in progress right now.',
        ordersBrowse: 'Browse markets',
        ordersHint: 'A resting limit order stays on the book until it fills or is canceled; a market order only appears here briefly.',
        order_pending: 'Pending',
        order_filled: 'Filled',
        order_failed: 'Failed',
        orderBuy: 'Buy',
        orderSell: 'Sell',

        radarTitle: 'Market radar',
        markets: 'markets',
        newMarkets: 'new',
        nextSweep: 'Next scan {t}',
        sweeping: 'Scanning…',
        autoIdle: 'Waiting',
        sweepRuns: '{n} auto scans, last {ms} ms',
        sweepInterval: 'Radar interval',
        interval300: 'Every 5 min',
        interval900: 'Every 15 min',
        interval1800: 'Every 30 min',
        interval3600: 'Every hour',
        interval7200: 'Every 2 hours',
        intervalSaved: 'Radar interval set to {m} minutes',
        search: 'Search events, markets or tags, or paste a Polymarket link…',
        tabAll: 'All',
        tabNew: 'New',
        tabEnding: 'Ending in 7d',
        noRows: 'No markets match this filter. Change the category, clear the search, or paste a Polymarket event link.',
        noMarkets: 'This event has no tradeable markets right now (closed or delisted).',
        colEnds: 'Ends',
        colEvent: 'Event',
        colOutcomes: 'Markets',
        colVol24h: '24h vol',
        events: 'events',
        newEvents: 'new',
        outcomes: 'outcomes',
        marketRules: 'Market rules (English)',
        previewMore: 'more',
        details: 'Details',
        showMore: 'Show more',
        shown: '{shown} of {total}',
        buy: 'Buy',
        ends: 'Ends',
        vol24h: '24h',
        badgeNew: 'New',
        badgeNegRisk: 'Multi-outcome',
        catAll: 'All categories',
        cat_sports: 'Sports',
        cat_crypto: 'Crypto',
        cat_weather: 'Weather',
        cat_elections: 'Elections',
        cat_tech: 'Tech',
        cat_economy: 'Economy',
        cat_world: 'World',
        cat_politics: 'Politics',
        cat_culture: 'Culture',
        cat_other: 'Other',
        badgeLink: 'Link',
        badgeEnded: 'Ended',
        badgeOutside: 'Not in radar',
        linkResolving: 'Resolving link…',
        linkResolved: 'The linked event is pinned to the top of the list; open it for its markets.',
        linkNotFound: 'That link has no tradeable markets: it may be delisted, misspelled, or missing binary outcomes.',

        marketDetail: 'Market',
        marketInfo: 'Market info',
        orderBook: 'Order book',
        bids: 'Bids',
        asks: 'Asks',
        bestBid: 'Best bid',
        bestAsk: 'Best ask',
        noBook: 'No resting orders right now',
        liquidity: 'Liquidity',
        spread: 'Spread',
        volume: 'Volume',
        event: 'Event',
        rulesTitle: 'Rules',
        eventRules: 'Event description',
        backgroundTitle: 'Background',
        englishSource: 'English source',
        noRules: 'This market provides no rules text.',
        noBackground: 'No background available.',
        resolutionSource: 'Resolution source',
        openMarket: 'Open on Polymarket',
        marketNotFound: 'Market not found',

        betTitle: 'Confirm bet',
        betSub: '',
        price: 'Price',
        maxOrder: 'Per-order cap',
        dailyLeft: 'Left today',
        amountUsd: 'Amount (USD)',
        estShares: 'Estimated shares',
        confirmBet: 'Place bet',
        sending: 'Submitting…',
        betQueued: 'Order submitted',
        betFailed: 'Order failed',
        orderType: 'Order type',
        marketOrder: 'Market',
        limitOrder: 'Limit',
        marketHint: 'Fills at the best ask as soon as possible; the actual average may be better.',
        limitHint: 'A limit order rests on the book until it fills or you cancel it.',
        limitPrice: 'Limit price',
        lowerPrice: 'Lower price',
        higherPrice: 'Raise price',
        shares: 'Shares',
        minimum: 'Min',
        orderTotal: 'Total',
        validUntil: 'Valid until',
        gtc: 'Filled or canceled (GTC)',
        estAvgPrice: 'Est. average price',
        availableCash: 'Available',
        max: 'Max',
        youWin: 'To win',
        payoutNoteMarket: 'Estimated from expected shares × $1 per share, before fees.',
        payoutNoteLimit: 'Estimated from shares × $1 per share, before fees.',
        crossingNow: 'Should fill immediately',
        restingOrder: 'Will rest on the book',
        minSharesHint: 'At least {min} shares and a total of at least $1.',
        limitPriceInvalid: 'Enter a valid {tick} tick below $1.',
        placeLimit: 'Place limit order',
        limitQueued: 'Limit order submitted and resting',
        useLimitPrice: 'Use {price} as the limit',
        orderTypeLimit: 'Limit',
        orderTypeMarket: 'Market',
        order_open: 'Open',
        order_canceled: 'Canceled',
        cancelOrder: 'Cancel',
        orderCanceled: 'Limit order canceled',
        cancelFailed: 'Cancel failed',
        minHint: 'Minimum ${min}: Polymarket rejects marketable buys below $1 and every order needs at least 5 shares.',
        priceCap: 'Above the per-order cap {max}',
        dailyCapHint: 'Above the remaining daily amount {left}',
        overCash: 'Above available cash {cash}',
        configNeeded: 'No Polymarket account configured yet. Open Settings and add the private key and account wallet.',
        tradingDisabled: 'Trading is disabled in Settings.',
        approvalsMissing: 'The account is missing trading approvals. Open Settings and run the one-click approval.',
        bridgeNotReady: 'Trading bridge not ready: {reason}',
        openSettings: 'Open settings',
        errorOrderCap: 'Above the per-order cap {max}',
        errorDailyCap: 'Above the remaining daily amount ({left})',
        errorMinSize: 'Below the minimum order (at least $1 and 5 shares)',
        errorNoBook: 'No resting orders on this side right now',
        errorPositionMissing: 'Position not found — it may already be sold',
        errorPositionRedeemable: 'This position is resolved; redeem it on Polymarket',
        errorGeneric: 'Order failed: {error}',

        sourceCredentials: 'local credentials',
        sourceNone: 'not configured',
        configured: 'Configured',
        required: 'Required',
        notConfigured: 'Not configured',
        show: 'Show',
        hide: 'Hide',

        guideQuestion: 'Do you already have a Polymarket account?',
        guideCopy: 'Create one first if you are new; if you already have an account, continue straight to setup.',
        guideRegister: 'Sign up',
        guideHaveAccount: 'I already have an account',
        guideNote: 'After signing up, come back and choose “I already have an account” to continue.',

        obLater: 'Configure later',
        obNext: 'Next',
        obBack: 'Back',
        obCheckAgain: 'Refresh status',
        obWorking: 'Working…',
        obError: 'Error: {error}',
        obShotMissing: 'Screenshot missing: put {file} in plugin/assets',
        obZoom: 'Open screenshot',
        obZoomHint: 'Click to enlarge',
        obZoomAlt: 'Polymarket settings screenshot',
        obZoomClose: 'Click the background or press Esc to close',
        obStepKey: 'Key',
        obStepWallet: 'Wallet',
        obStepRelayer: 'Relayer',
        obStepVerify: 'Approve',
        obKeyTitle: 'Signing key',
        obKeyWhy: 'Why a key: orders must be signed with your account private key, or they cannot be placed. The private key is stored only in the local DSH credentials store and is never uploaded.',
        obVaultTitle: 'What is the DSH credentials store?',
        obVaultWhy: 'The DSH credentials store is a local credential file managed by DSH ($DSH_HOME/.credentials.yaml, mode 0600) outside the project workspace. The plugin reads and writes the wallet, private key and Relayer key only through it; it never writes them into .env, state.json or logs, and DSH workspace snapshots do not include it. It is a plaintext YAML file, not a hardware wallet: safety depends on this machine\'s account permissions and disk encryption. Use a separate or hardware wallet for large balances.',
        obVaultAck: 'I understand how the DSH credentials store works',
        obVaultAckRequired: 'Tick “I understand how the DSH credentials store works” first.',
        obVaultAckNeeded: 'Tick “I understand how the DSH credentials store works” above before this key can be saved and you can continue.',
        obKeyWhere: 'Where to get it: avatar → Settings → Account, find the private key under sensitive settings, click export and copy it (see below). The next step asks for the matching account wallet.',
        obKeyLink: 'Open Polymarket settings',
        obKeyRiskTitle: 'Security note',
        obKeyInput: 'Signing key',
        obKeyPlaceholder: 'Paste the 0x-prefixed 64-hex private key',
        obKeyKeep: 'Configured — leave empty to keep it',
        obKeySavedHint: 'The key is saved. Paste a new one to replace it; leaving it empty keeps the current key.',
        obKeyStorageHint: 'Saving writes only to the DSH credentials store; leave it empty to keep the current value.',
        obKeyFormat: 'Format: 0x plus 64 hex characters (66 characters total).',
        obKeyInvalid: 'Invalid key format. Check that you copied the whole key.',
        obKeyWarning: 'Please note that if a third party learns your private key, it may cause losses. This program stores the private key only in the local DSH credentials store (readable only by the current user).',
        obKeySave: 'Save and continue',
        obWalletTitle: 'Account wallet',
        obWalletWhy: 'Why the wallet: the key only signs; the funds and positions live in your Polymarket account wallet (Proxy / Safe / Deposit). The plugin reads balances and places orders for that address.',
        obWalletWhere: 'Where to copy it: open your profile (avatar → profile) and click copy address. Do not use the address from your browser wallet.',
        obWalletLink: 'Open profile to copy the address',
        obWalletInput: 'Account wallet address',
        obWalletDetected: 'Using: {wallet}',
        obWalletFormat: 'Format: 0x plus 40 hex characters.',
        obWalletInvalid: 'Invalid wallet address. Check that you copied the whole address.',
        obWalletUseDetected: 'Use the detected address {wallet}',
        obRelayerTitle: 'Relayer API key',
        obRelayerWhy: 'The relayer grants approvals and deploys the wallet without gas. It is required for the first approval; if this account is already approved, leave it empty and continue.',
        obRelayerWhere: 'Create one under Polymarket → Settings → API keys (Predictions) and copy the API key and the signer address shown above it (not the wallet address).',
        obRelayerLink: 'Open API keys',
        obRelayerKey: 'Relayer API key',
        obRelayerKeyKeep: 'Configured — leave empty to keep it',
        obRelayerKeyPlaceholder: 'Paste the relayer API key',
        obRelayerKeyInvalid: 'The relayer API key is too short. Check that you copied the whole key.',
        obRelayerAddress: 'Signer address (not the wallet)',
        obRelayerAddressInvalid: 'Invalid signer address.',
        obRelayerIncomplete: 'Fill in both the relayer key and the signer address.',
        obRelayerSaved: 'The relayer is configured; leaving the fields empty keeps it.',
        obRelayerRequired: 'The first approval needs a relayer: fill in the API key and signer address.',
        obRelayerRequiredHint: 'A relayer API key and signer address are required for the first approval.',
        obRelayerApprovedHint: 'This account already has trading approvals, so it is fine to leave these empty.',
        obRelayerConfigured: 'Relayer',
        obVerifyTitle: 'Check and approve',
        obKeyConfigured: 'Signing key',
        obAccount: 'Account wallet',
        obWalletType: 'Wallet type',
        obCash: 'Available cash',
        obApprovals: 'Trading approvals',
        obApproved: 'Approved',
        obNotApproved: 'Missing',
        obApprovedDone: 'Trading approvals are ready.',
        obApproveWhy: 'Polymarket requires approvals so the exchange can move your USDC and outcome tokens (neg-risk markets also need the Neg Risk Adapter). It is gasless and only needed once.',
        obApprove: 'Approve everything',
        obCapsTitle: 'Order caps',
        obCapsEnable: 'Enable ordering in the panel',
        obCapOrder: 'Per-order cap (USD)',
        obCapDaily: 'Daily cap (USD)',
        obFinish: 'Save and finish',
        obRestart: 'Reconfigure',
        obIncomplete: 'The key or wallet is still missing.',
        obHostStale: 'The Host plugin is an older build (no /onboarding route). Restart dsh web or re-enable the plugin.',

      },
    }

    function PanelIconRoot(props) {
      return h(PanelIcon, props)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        translate = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'polymarket-agent locale')

        const localeSnapshot = () => {
          try {
            return ctx.locale.getLocale?.() ?? ctx.locale.getSnapshot?.()
          } catch {
            return undefined
          }
        }
        localeProbe = () => syncLocale(localeSnapshot())
        ctx.effect(() => {
          syncLocale(localeSnapshot())
          return ctx.locale.subscribe(() => syncLocale(localeSnapshot()))
        }, 'polymarket-agent market locale')
        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Panel),
            ),
          'polymarket-agent page',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 16,
                  locale: NS,
                  label: () => t('panel'),
                },
                PanelIconRoot,
              ),
            ),
          'polymarket-agent panel icon',
        )
      },
    }
  },
})

