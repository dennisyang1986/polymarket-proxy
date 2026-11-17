/**
 * Execution bridge: signs and submits CLOB orders with the official
 * `@polymarket/client` TypeScript SDK inside the Host process.
 *
 * The panel wants three operations: buy an outcome at the current ask (market),
 * rest a GTC buy at a chosen limit price, and sell (close) an outcome position
 * at the current bid. All three read the live book first, so the price the panel
 * shows and the price the order uses cannot drift apart.
 *
 * Credentials have exactly one home: the DSH credentials store
 * (`ctx.credentials`, `$DSH_HOME/.credentials.yaml`). The store can also see
 * ambient layers (the Host process environment, the project `.env` and
 * `$DSH_HOME/.env`); this bridge deliberately refuses those layers so a
 * checkout, a shell export or an old `.env` cannot become a second copy of a
 * wallet, private key or Relayer API key.
 *
 * There is no `.env` reader and no `.env` writer in this module. Deposit
 * discovery is cached in memory by `index.js` only.
 *
 * The SDK is imported lazily: the read-only radar and every unconfigured
 * install keep working without the dependency.
 * @module dsh-polymarket-proxy/bridge
 */

import { createHash } from 'node:crypto'

/** Credential references written by the settings panel / onboarding. */
export const CREDENTIALS = Object.freeze({
  privateKey: 'POLYMARKET_PRIVATE_KEY',
  wallet: 'POLYMARKET_WALLET_ADDRESS',
  relayerKey: 'POLYMARKET_RELAYER_API_KEY',
  relayerAddress: 'POLYMARKET_RELAYER_API_KEY_ADDRESS',
  /** Optional manual deposit address (public data, stored with the account). */
  depositAddress: 'POLYMARKET_DEPOSIT_ADDRESS',
})

/**
 * Layers the credentials service may fall back to. The local provider calls
 * them `env` (process), `project-env` (cwd `.env`) and `user-env`
 * (`$DSH_HOME/.env`); its managed document reports `file`. Anything ambient is
 * ignored here, not merely outranked.
 */
const AMBIENT_CREDENTIAL_SOURCES = new Set(['env', 'process-env', 'project-env', 'user-env', 'dotenv'])

const STATUS_TTL_MS = 30_000
const CALL_TIMEOUT_MS = 45_000
/** Never let a marketable sell fall more than this below the best bid. */
const SELL_SLIPPAGE = 0.03
/**
 * Polygon RPC for the SDK's on-chain checks. The SDK defaults to
 * `polygon.drpc.org`, whose free plan refuses JSON-RPC batches above ten calls;
 * `setupTradingApprovals()` checks seventeen allowances in one batch and gets
 * an HTTP 400 there. Use the same public endpoint the Host already prefers for
 * its Polygon scans.
 */
const POLYGON_RPC = 'https://polygon-bor-rpc.publicnode.com'

// ---------------------------------------------------------------- pure helpers

/** Round a price to a valid tick, keeping the tick's own precision. */
export function roundPriceToTick(price, tick) {
  const step = Number(tick) > 0 ? Number(tick) : 0.01
  const raw = Number(price)
  if (!Number.isFinite(raw) || raw <= 0) return step
  const stepped = Math.floor((raw + 1e-9) / step) * step
  const decimals = Math.max(0, String(step).split('.')[1]?.length ?? 0)
  // Polymarket prices must stay below 1: the highest valid value is one tick
  // under settlement (0.99 at 0.01, 0.999 at 0.001, 0.9999 at 0.0001).
  const maxPrice = Number((1 - step).toFixed(decimals))
  const clamped = Math.min(Math.max(stepped, step), maxPrice)
  return Number(clamped.toFixed(decimals))
}

/** Share count for a USD ticket: never below the market floor, never above the cap. */
export function sizeForTicket(amountUsd, price, minSize = 5) {
  const px = Number(price)
  const floor = Number(minSize) > 0 ? Number(minSize) : 5
  const raw = Number(amountUsd) / px
  const size = Math.max(floor, Math.floor(raw * 100 + 1e-9) / 100)
  return Number(size.toFixed(2))
}

/** The SDK's numeric wallet type as a readable name. */
export function walletTypeName(type) {
  return ['EOA', 'POLY_PROXY', 'GNOSIS_SAFE', 'DEPOSIT_WALLET'][Number(type)] ?? `TYPE_${type}`
}

/** Accepts a bare 64-hex key and normalizes the 0x prefix. */
export function normalizePrivateKey(value) {
  const raw = String(value ?? '').trim()
  const body = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw
  if (!/^[0-9a-fA-F]{64}$/.test(body)) return undefined
  return `0x${body.toLowerCase()}`
}

/** A 20-byte EVM address, normalized to lower case. */
export function normalizeAddress(value) {
  const raw = String(value ?? '').trim()
  return /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : undefined
}

function withTimeout(promise, label, ms = CALL_TIMEOUT_MS) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}-timeout`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function shortError(error) {
  const text = String(error?.message ?? error ?? '')
    // Never let an error string echo a key, a tx hash or a wallet address.
    .replace(/0x[0-9a-fA-F]{64}/g, '0x…')
    .replace(/0x[0-9a-fA-F]{40}/g, '0x…')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 300 ? `${text.slice(0, 300)}…` : text || 'unknown-error'
}

function fingerprint(parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

/**
 * JSON-safe view of the SDK's missing-approval lists. The raw ERC-20 entries
 * carry a `bigint` amount, which `JSON.stringify` refuses to serialize.
 */
function missingView(state) {
  return {
    erc20: (state?.missing?.erc20 ?? []).map((entry) => entry.spenderAddress),
    erc1155: (state?.missing?.erc1155 ?? []).map((entry) => entry.operatorAddress),
  }
}

function bestBidOf(book) {
  return (book?.bids ?? []).reduce((best, row) => Math.max(best, Number(row.price) || 0), 0)
}

function bestAskOf(book) {
  const asks = (book?.asks ?? []).map((row) => Number(row.price) || 0).filter((price) => price > 0)
  return asks.length ? Math.min(...asks) : 0
}

// ---------------------------------------------------------------------- bridge

/**
 * @param {object} options
 * @param {object} options.ctx Host plugin context (`ctx.credentials` required).
 */
export function createBridge({ ctx }) {
  /** @type {{ key: string, client: any } | null} */
  let clientCache = null
  /** @type {{ key: string, at: number, value: any } | null} */
  let statusCache = null
  /** Warn once per reference when an ambient copy was deliberately ignored. */
  const ambientWarned = new Set()

  /** Drop caches after credentials change. */
  function reset() {
    clientCache = null
    statusCache = null
    ambientWarned.clear()
  }

  /**
   * Read one reference from the provider-managed store only. The credentials
   * service can also answer from the Host environment or a `.env`; those
   * layers are rejected here so the settings panel is the sole way in.
   */
  async function stored(name) {
    const service = ctx.credentials
    if (!service || typeof service.resolve !== 'function') return undefined
    try {
      const hit = await service.resolve(name)
      if (!hit?.value) return undefined
      const source = String(hit.source ?? '')
      if (AMBIENT_CREDENTIAL_SOURCES.has(source)) {
        if (!ambientWarned.has(name)) {
          ambientWarned.add(name)
          ctx.logger?.warn?.(
            `polymarket-agent: ignoring ${name} from ${source}; save it in Settings so it lives only in the DSH credentials store`,
          )
        }
        return undefined
      }
      return { value: hit.value, source: 'credentials' }
    } catch {
      return undefined
    }
  }

  /** Resolved credentials plus where each one came from. */
  async function config() {
    const [key, wallet, relayerKey, relayerAddress, depositAddress] = await Promise.all([
      stored(CREDENTIALS.privateKey),
      stored(CREDENTIALS.wallet),
      stored(CREDENTIALS.relayerKey),
      stored(CREDENTIALS.relayerAddress),
      stored(CREDENTIALS.depositAddress),
    ])
    const privateKey = normalizePrivateKey(key?.value)
    const walletRaw = String(wallet?.value ?? '').trim()
    const relayerAddressRaw = String(relayerAddress?.value ?? '').trim()
    const depositAddressRaw = String(depositAddress?.value ?? '').trim()
    return {
      privateKey,
      wallet: normalizeAddress(walletRaw) ?? (walletRaw || undefined),
      relayerKey: String(relayerKey?.value ?? '').trim() || undefined,
      relayerAddress: normalizeAddress(relayerAddressRaw) ?? (relayerAddressRaw || undefined),
      depositAddress: normalizeAddress(depositAddressRaw) ?? undefined,
      sources: {
        privateKey: key?.source,
        wallet: wallet?.source,
        relayerKey: relayerKey?.source,
        relayerAddress: relayerAddress?.source,
        depositAddress: depositAddress?.source,
      },
    }
  }

  function configuredOf(cfg) {
    return {
      key: Boolean(cfg.privateKey),
      wallet: Boolean(cfg.wallet),
      relayer: Boolean(cfg.relayerKey && cfg.relayerAddress),
    }
  }

  function markOf(cfg) {
    return fingerprint([cfg.privateKey ?? '', cfg.wallet ?? '', cfg.relayerKey ?? '', cfg.relayerAddress ?? ''])
  }

  async function sdk() {
    try {
      const [client, viem, actions] = await Promise.all([
        import('@polymarket/client'),
        import('@polymarket/client/viem'),
        import('@polymarket/client/actions'),
      ])
      return { client, viem, actions }
    } catch (error) {
      throw new Error(`sdk-unavailable: ${shortError(error)}`)
    }
  }

  async function getClient(cfg) {
    if (!cfg.privateKey) throw new Error('no-private-key')
    const mark = markOf(cfg)
    if (clientCache?.key === mark) return clientCache.client
    const lib = await sdk()
    const options = {
      signer: lib.viem.privateKey(cfg.privateKey),
      environment: { ...lib.client.production, rpc: POLYGON_RPC },
    }
    if (cfg.wallet) options.wallet = cfg.wallet
    if (cfg.relayerKey && cfg.relayerAddress) {
      options.apiKey = lib.client.relayerApiKey({ key: cfg.relayerKey, address: cfg.relayerAddress })
    }
    const client = await withTimeout(lib.client.createSecureClient(options), 'create-client')
    clientCache = { key: mark, client }
    return client
  }

  /**
   * Read-only health of the trading account. Cached briefly because the panel
   * polls `/state`; `force` bypasses the cache after a credential change.
   */
  async function status(force = false) {
    const cfg = await config()
    const configured = configuredOf(cfg)
    const base = {
      ready: false,
      configured,
      sources: cfg.sources,
      wallet: cfg.wallet ?? null,
      signer: null,
      walletType: null,
      cash: null,
      approvals: null,
      reason: undefined,
      error: undefined,
      at: new Date().toISOString(),
    }
    if (!configured.key) return { ...base, reason: 'no-private-key' }
    if (!configured.wallet) return { ...base, reason: 'no-wallet' }

    const mark = markOf(cfg)
    if (!force && statusCache && statusCache.key === mark && Date.now() - statusCache.at < STATUS_TTL_MS) {
      return statusCache.value
    }

    try {
      const lib = await sdk()
      const client = await withTimeout(getClient(cfg), 'status-client', 20_000)
      const [balance, approvals] = await Promise.all([
        withTimeout(lib.actions.fetchBalanceAllowance(client, { assetType: 'COLLATERAL' }), 'balance', 8_000),
        withTimeout(client.fetchTradingApprovalsState(), 'approvals', 8_000),
      ])
      const value = {
        ...base,
        ready: Boolean(approvals?.isFullyApproved),
        reason: approvals?.isFullyApproved ? undefined : 'approvals-missing',
        signer: client.account?.signer ?? null,
        wallet: client.account?.wallet ?? cfg.wallet,
        walletType: walletTypeName(client.account?.walletType),
        cash: Number(balance?.balance ?? 0) / 1e6,
        approvals: {
          fully: Boolean(approvals?.isFullyApproved),
          ...missingView(approvals),
        },
        at: new Date().toISOString(),
      }
      statusCache = { key: mark, at: Date.now(), value }
      return value
    } catch (error) {
      const value = { ...base, reason: 'bridge-error', error: shortError(error) }
      statusCache = { key: mark, at: Date.now(), value }
      return value
    }
  }

  /**
   * Sign and submit one marketable BUY against the live ask. `maxPrice` is the
   * ticket's hard ceiling (normally the current ask); the book's ask is used
   * when cheaper. Polymarket itself never accepts a price at or above 1.
   */
  async function buy({ tokenId, amountUsd, maxPrice }) {
    const cfg = await config()
    const client = await getClient(cfg)
    const book = await withTimeout(client.fetchOrderBook({ assetId: String(tokenId) }), 'order-book')
    const tick = Number(book?.tickSize) || 0.01
    const minSize = Number(book?.minOrderSize) || 5
    const ask = bestAskOf(book)
    if (!(ask > 0 && ask < 1)) throw new Error('no-ask')
    const ceiling = Number(maxPrice) > 0 ? Number(maxPrice) : 1 - tick
    const limit = roundPriceToTick(Math.min(ceiling, ask), tick)
    const rawSize = Number(amountUsd) / limit
    // Reject rather than silently bumping to the 5-share floor: the ticket the
    // user confirmed must not spend more than its amount.
    if (!(rawSize >= minSize - 1e-9)) {
      throw new Error(`below-min-size:${Number((minSize * limit).toFixed(2))}`)
    }
    const size = Math.max(minSize, Math.floor(rawSize * 100 + 1e-9) / 100)
    const notional = Number((size * limit).toFixed(4))
    if (notional < 1 - 1e-9 || notional > Number(amountUsd) + 0.011) throw new Error('below-min-size')

    const signed = await withTimeout(
      client.createLimitOrder({
        assetId: String(tokenId),
        side: 'BUY',
        price: String(limit),
        size: String(size),
      }),
      'sign-order',
    )
    const response = await withTimeout(client.postOrder(signed), 'post-order')
    const ok = Boolean(response?.ok)
    // The taker order should fill or die fast; keep a stale resting bid from
    // sitting on the book after the ask moved away.
    if (ok && response.status === 'live') {
      const orderId = response.orderId
      const timer = setTimeout(() => {
        client
          .cancelOrder({ orderId })
          .catch((error) => ctx.logger?.warn?.(`polymarket-agent: cancel failed: ${shortError(error)}`))
      }, 3000)
      timer.unref?.()
    }
    return {
      ok,
      price: limit,
      size,
      notional,
      orderId: response?.orderId ?? null,
      status: response?.status ?? (ok ? 'filled' : 'failed'),
      error: ok ? undefined : shortError(response?.message ?? response?.code ?? 'order-rejected'),
    }
  }

  /**
   * Sign and submit a GTC BUY at an explicit limit price. A limit at or above
   * the best ask crosses immediately; a lower limit rests on the book until it
   * fills or is canceled. No expiration is attached, matching Polymarket's
   * "never expires" buy-limit default.
   */
  async function buyLimit({ tokenId, price, shares }) {
    const cfg = await config()
    const client = await getClient(cfg)
    const requestedPrice = Number(price)
    const requestedSize = Number(shares)
    if (!(requestedPrice > 0)) throw new Error('price-required')
    if (!(requestedSize > 0)) throw new Error('shares-required')

    const book = await withTimeout(client.fetchOrderBook({ assetId: String(tokenId) }), 'order-book')
    const tick = Number(book?.tickSize) || 0.01
    const minSize = Number(book?.minOrderSize) || 5
    const limit = roundPriceToTick(requestedPrice, tick)
    const size = Math.floor(requestedSize * 100 + 1e-9) / 100
    if (!(limit > 0 && limit < 1)) throw new Error('price-required')
    if (!(size > 0)) throw new Error('shares-required')
    if (size + 1e-9 < minSize) {
      throw new Error(`below-min-size:${Number((minSize * limit).toFixed(2))}`)
    }
    const notional = Number((size * limit).toFixed(4))
    if (notional < 1 - 1e-9) {
      throw new Error(`below-min-size:${Number((1 / limit).toFixed(2))}`)
    }

    const signed = await withTimeout(
      client.createLimitOrder({
        assetId: String(tokenId),
        side: 'BUY',
        price: String(limit),
        size: String(size),
      }),
      'sign-order',
    )
    const response = await withTimeout(client.postOrder(signed), 'post-order')
    const ok = Boolean(response?.ok)
    const resting = ok && (response.status === 'live' || response.status === 'delayed')
    // `takingAmount` is the taker asset received at placement, i.e. shares for
    // a BUY. Use it when present so a partially matched crossing limit does not
    // get recorded as a full fill.
    const matchedShares = ok && !resting ? Number(response?.takingAmount) : 0
    const filledSize = ok && !resting
      ? matchedShares > 0
        ? Math.min(size, matchedShares)
        : size
      : 0
    return {
      ok,
      orderType: 'limit',
      price: limit,
      size,
      filledSize,
      remainingSize: Number((size - filledSize).toFixed(4)),
      notional,
      orderId: response?.orderId ?? null,
      status: ok ? (resting ? 'live' : 'matched') : 'failed',
      error: ok ? undefined : shortError(response?.message ?? response?.code ?? 'order-rejected'),
    }
  }

  /** Cancel one resting order and report which ids the venue accepted. */
  async function cancel({ orderId }) {
    const id = String(orderId ?? '').trim()
    if (!id) throw new Error('order-id-required')
    const cfg = await config()
    const client = await getClient(cfg)
    const response = await withTimeout(client.cancelOrder({ orderId: id }), 'cancel-order')
    const canceled = (response?.canceled ?? []).map(String)
    const notCanceled = response?.notCanceled ?? {}
    return {
      ok: canceled.includes(id),
      canceled,
      notCanceled,
      error: canceled.includes(id) ? undefined : shortError(notCanceled?.[id] ?? 'cancel-rejected'),
    }
  }

  /** Current fill state of one order, for refreshing resting limit orders. */
  async function orderInfo({ orderId }) {
    const id = String(orderId ?? '').trim()
    if (!id) return { ok: false, error: 'order-id-required' }
    try {
      const cfg = await config()
      const client = await getClient(cfg)
      const order = await withTimeout(client.fetchOrder({ orderId: id }), 'fetch-order')
      return {
        ok: true,
        status: String(order?.status ?? ''),
        originalSize: Number(order?.originalSize ?? 0),
        filledSize: Number(order?.sizeMatched ?? 0),
        price: Number(order?.price ?? 0),
        orderType: order?.orderType ?? null,
      }
    } catch (error) {
      return { ok: false, error: shortError(error) }
    }
  }

  /**
   * Close (part of) a position with a marketable SELL. The order only matches
   * down to `SELL_SLIPPAGE` below the current best bid.
   */
  async function sell({ tokenId, shares }) {
    const cfg = await config()
    const client = await getClient(cfg)
    const amount = Number(shares)
    if (!(amount > 0)) throw new Error('shares-required')
    const book = await withTimeout(client.fetchOrderBook({ assetId: String(tokenId) }), 'order-book')
    const tick = Number(book?.tickSize) || 0.01
    const bid = bestBidOf(book)
    if (!(bid > 0)) throw new Error('no-bid')
    const floor = roundPriceToTick(bid * (1 - SELL_SLIPPAGE), tick)
    const response = await withTimeout(
      client.placeMarketOrder({
        assetId: String(tokenId),
        side: 'SELL',
        shares: amount,
        minPrice: String(Math.max(tick, floor)),
      }),
      'sell-order',
      60_000,
    )
    const ok = Boolean(response?.ok)
    return {
      ok,
      price: bid,
      size: amount,
      notional: Number((amount * bid).toFixed(4)),
      orderId: response?.orderId ?? null,
      status: response?.status ?? (ok ? 'filled' : 'failed'),
      error: ok ? undefined : shortError(response?.message ?? response?.code ?? 'order-rejected'),
    }
  }

  /**
   * Grant the approvals a fresh account needs: the SDK's trading approvals,
   * then whatever the state still reports missing (the neg-risk adapter is not
   * covered by `setupTradingApprovals`).
   */
  async function approveAll() {
    const cfg = await config()
    const client = await getClient(cfg)
    const lib = await sdk()
    let state
    let stage = 'setup'
    try {
      // `setupTradingApprovals` checks every required allowance in one
      // JSON-RPC batch and submits a single gasless transaction. Some RPC
      // providers refuse batches that large, so a failure here is not fatal:
      // the indexed `missing` list below is enough to approve each entry
      // through the SDK's public actions.
      try {
        await withTimeout(client.setupTradingApprovals(), 'approvals-setup', 120_000)
      } catch (error) {
        ctx.logger?.warn?.(
          `polymarket-agent: trading approval batch failed; approving entries individually: ${shortError(error)}`,
        )
      }

      stage = 'state'
      state = await withTimeout(client.fetchTradingApprovalsState(), 'approvals-state')
      stage = 'erc20'
      for (const entry of state?.missing?.erc20 ?? []) {
        const handle = await withTimeout(
          lib.actions.approveErc20(client, {
            tokenAddress: entry.tokenAddress,
            spenderAddress: entry.spenderAddress,
            amount: 'max',
          }),
          'approve-erc20',
          120_000,
        )
        await handle.wait()
      }
      stage = 'erc1155'
      for (const entry of state?.missing?.erc1155 ?? []) {
        const handle = await withTimeout(
          lib.actions.approveErc1155ForAll(client, {
            tokenAddress: entry.tokenAddress,
            operatorAddress: entry.operatorAddress,
            approved: true,
          }),
          'approve-erc1155',
          120_000,
        )
        await handle.wait()
      }
      stage = 'verify'
      state = await withTimeout(client.fetchTradingApprovalsState(), 'approvals-state')
      statusCache = null
      return { ok: true, fully: Boolean(state?.isFullyApproved), missing: missingView(state) }
    } catch (error) {
      statusCache = null
      return { ok: false, stage, error: shortError(error) }
    }
  }

  /** Presence + source only — no network, safe for the onboarding screen. */
  async function describe() {
    const cfg = await config()
    return {
      configured: configuredOf(cfg),
      sources: cfg.sources,
      wallet: cfg.wallet ?? null,
      // Public addresses, safe to echo back so a settings form can prefill them.
      relayerAddress: cfg.relayerAddress ?? null,
      depositAddress: cfg.depositAddress ?? null,
    }
  }

  /**
   * Persist credentials in the DSH store (never in plugin state, never echoed
   * back). Each field is optional; an omitted field keeps its stored value.
   * A `null` or empty `depositAddress` removes the optional manual address.
   */
  async function setCredentials(patch) {
    const service = ctx.credentials
    if (!service || typeof service.set !== 'function') throw new Error('credentials-unavailable')
    const writes = []
    if (patch?.privateKey !== undefined) {
      const key = normalizePrivateKey(patch.privateKey)
      if (!key) throw new Error('invalid-private-key')
      writes.push([CREDENTIALS.privateKey, key])
    }
    if (patch?.wallet !== undefined) {
      const wallet = normalizeAddress(patch.wallet)
      if (!wallet) throw new Error('invalid-wallet')
      writes.push([CREDENTIALS.wallet, wallet])
    }
    if (patch?.relayerKey !== undefined) {
      const value = String(patch.relayerKey).trim()
      if (value.length < 8) throw new Error('invalid-relayer-key')
      writes.push([CREDENTIALS.relayerKey, value])
    }
    if (patch?.relayerAddress !== undefined) {
      const address = normalizeAddress(patch.relayerAddress)
      if (!address) throw new Error('invalid-relayer-address')
      writes.push([CREDENTIALS.relayerAddress, address])
    }
    if (patch?.depositAddress !== undefined) {
      const raw = String(patch.depositAddress ?? '').trim()
      if (raw === '') {
        writes.push([CREDENTIALS.depositAddress, null])
      } else {
        const address = normalizeAddress(raw)
        if (!address) throw new Error('invalid-deposit-address')
        writes.push([CREDENTIALS.depositAddress, address])
      }
    }
    for (const [name, value] of writes) {
      if (value === null) {
        if (typeof service.unset !== 'function') throw new Error('credentials-unavailable')
        await service.unset(name)
      } else {
        await service.set(name, value)
      }
    }
    reset()
    return { ok: true, described: await describe() }
  }

  async function clearCredentials() {
    const service = ctx.credentials
    if (!service || typeof service.unset !== 'function') throw new Error('credentials-unavailable')
    for (const name of Object.values(CREDENTIALS)) await service.unset(name)
    reset()
    return { ok: true }
  }

  return {
    status,
    buy,
    buyLimit,
    sell,
    cancel,
    orderInfo,
    approveAll,
    describe,
    setCredentials,
    clearCredentials,
    config,
    reset,
  }
}
