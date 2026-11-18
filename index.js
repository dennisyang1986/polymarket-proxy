/**
 * Host half of the Polymarket Proxy panel.
 *
 * Responsibilities:
 *  - keep a portfolio snapshot for the configured proxy wallet: cash from the
 *    CLOB, open/redeemable positions and the activity feed from Data API v2;
 *  - sweep the public Gamma API for open markets and cache a normalized,
 *    volume-ranked list, classified by Polymarket's own tags; titles follow the
 *    panel language (Chinese Harness UI -> Polymarket zh, everything else en);
 *  - drop events matching the user-editable keyword filter (`keywords.txt`)
 *    before they reach the panel or the agent tool;
 *  - resolve a pasted event or market link straight from Gamma, including
 *    events the sweep leaves out (low volume, far end date, closed);
 *  - sign and submit BUY and SELL orders through the official TypeScript SDK
 *    (`bridge.js`), with caps owned by the panel;
 *  - expose everything over `/api/polymarket-agent/*` for the browser panel and
 *    through two read-only agent tools.
 *
 * Persistence is deliberately split in two, and only two, places:
 *  - credentials (wallet, private key, Relayer key, optional deposit address)
 *    live in the DSH credentials store and nowhere else;
 *  - non-secret plugin state (settings, orders, onboarding, scan bookkeeping)
 *    lives in `<DSH_HOME>/polymarket-agent/state.json`.
 * Public chain data discovered for the Deposit modal is memory-only; the plugin
 * never reads or writes `.env`.
 *
 * No Python, no build step: plain ESM, global fetch, node:fs.
 * @module dsh-polymarket-proxy
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createBridge } from './bridge.js'

export const name = 'polymarket-agent'
export const inject = ['tools', 'webServer', 'credentials', 'connection']

const GAMMA = 'https://gamma-api.polymarket.com'
const DATA_API = 'https://data-api.polymarket.com/v2'
const CLOB = 'https://clob.polymarket.com'
const POLYGON_RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.drpc.org',
]
/**
 * Cloudflare fronts the Data API and answers requests without a User-Agent
 * with a bare `429` (notably `/v2/positions`). Node's fetch sends none by
 * default, so every public API call has to name itself.
 */
const USER_AGENT = 'polymarket-agent/1.0 (+https://polymarket.com)'
const PUSD_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
const USDCE_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const ONRAMP_ADDRESS = '0x93070a847efEf7F70739046A929D47a521F5B8ee'
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const API_PREFIX = '/api/polymarket-agent'
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = path.join(PLUGIN_DIR, 'assets')
const DAY_MS = 86_400_000
const STATE_VERSION = 1
const DEFAULT_VIA = 'deepseek'
/**
 * Keyword filter: `<plugin>/keywords.txt` or `<plugin>/../keywords.txt`. A
 * packaged install without either file gets
 * `<DSH_HOME>/polymarket-agent/keywords.txt`, seeded from the bundled
 * `keywords.default.txt`. A non-secret override can be supplied as the plugin
 * config key `keywordsFile`; account data never travels this way.
 */
const KEYWORDS_FILE_NAME = 'keywords.txt'
const KEYWORDS_SEED_FILE = 'keywords.default.txt'
const KEYWORDS_FALLBACK = ['中国', 'China', 'Chinese', '中共', 'CCP', '习近平', 'Xi Jinping']

const DEFAULT_SETTINGS = {
  /** Pause between automatic radar sweeps (30 minutes by default). */
  refreshSeconds: 1800,
  /** Gamma pages of 100 events, ordered by 24h volume. */
  pages: 6,
  /** Hide markets whose 24h volume is below this. */
  minVolume24h: 0,
  /** Hide markets resolving further out than this. */
  maxDays: 365,
  /** Keep 5-minute crypto Up/Down noise out of the list. */
  hideNoise: true,
  /**
   * Polymarket title language, written by the panel from the DeepSeek Harness
   * locale: `zh` for a Chinese UI, `en` for every other language. It also
   * decides the language of the agent-tool rows.
   */
  marketLocale: 'en',
  /** Trading caps written by the onboarding wizard; `null` uses safe defaults. */
  caps: null,
}

const NOISE_TITLE = /\bup\s*or\s*down\b|\bup\/down\b|bitcoin up or down|ethereum up or down/i

/**
 * Polymarket exposes no category field: an event is classified only by its
 * `tags`. This maps those tag slugs (locale-independent, unlike the localized
 * labels) onto a small stable set. `CATEGORY_ORDER` is the tie-break: a specific
 * tag (a league, a coin, a temperature market) wins over a broad one, so every
 * event lands in exactly one bucket and the panel chips never double count.
 */
const CATEGORY_TAGS = {
  sports: [
    'sports', 'soccer', 'football', 'basketball', 'nba', 'nfl', 'mlb', 'nhl', 'cfb', 'cbb', 'ncaa',
    'ncaa-basketball', 'ncaa-football', 'wnba', 'tennis', 'golf', 'cricket', 'hockey', 'baseball',
    'boxing', 'mma', 'ufc', 'f1', 'formula-1', 'esports', 'champions-league', 'uefa-champions-league',
    'uefa-nations-league', 'premier-league', 'la-liga', 'serie-a', 'bundesliga', 'ligue-1',
    'europa-league', 'world-cup', 'super-bowl', 'olympics', 'nascar', 'rugby', 'darts', 'snooker',
    'volleyball', 'handball', 'afl', 'copa-libertadores', 'mls', 'ipl', 'big-bash', 'test-cricket',
    'lottery', 'poker', 'chess',
  ],
  crypto: [
    'crypto', 'crypto-prices', 'cryptocurrency', 'bitcoin', 'ethereum', 'solana', 'altcoins',
    'blockchain', 'defi', 'nft', 'stablecoin', 'stablecoins', 'etf', 'crypto-regulation', 'memecoins',
    'xrp', 'doge', 'dogecoin', 'binance', 'coinbase', 'microstrategy', 'saylor',
  ],
  weather: ['weather', 'daily-temperature', 'highest-temperature', 'lowest-temperature', 'temperature', 'hurricane', 'climate'],
  elections: [
    'elections', 'global-elections', 'world-elections', 'us-presidential-election', 'presidential-election',
    'midterms', '2028-election', 'main-election', '2024-elections', 'primary-elections',
    'gubernatorial-election', 'senate-elections', 'house-elections', 'local-elections',
    'parliamentary-election',
  ],
  tech: [
    'tech', 'technology', 'ai', 'artificial-intelligence', 'big-tech', 'openai', 'anthropic', 'nvidia',
    'nvda', 'apple', 'google', 'microsoft', 'meta', 'tesla', 'spacex', 'space', 'science', 'software',
    'semiconductors', 'chips', 'xai', 'grok', 'claude', 'chatgpt', 'deepseek',
  ],
  economy: [
    'economy', 'economics', 'finance', 'financials', 'business', 'fed', 'fed-rates', 'fomc',
    'economic-policy', 'macro-indicators', 'macro-graph', 'macro-single', 'inflation', 'cpi', 'gdp',
    'interest-rates', 'recession', 'stocks', 'sp500', 'nasdaq', 'treasury', 'oil', 'gold',
    'commodities', 'housing', 'unemployment', 'jobs-report', 'earnings',
  ],
  world: [
    'geopolitics', 'world', 'international-affairs', 'foreign-affairs', 'diplomacy',
    'diplomacy-ceasefire', 'war', 'ukraine', 'russia', 'iran', 'israel', 'china', 'taiwan',
    'middle-east', 'nato', 'united-nations', 'venezuela', 'north-korea', 'peace-deal',
    'strait-of-hormuz', 'terrorism', 'europe', 'asia', 'africa', 'latin-america', 'gaza', 'syria',
    'lebanon', 'yemen', 'hamas', 'hezbollah',
  ],
  politics: [
    'politics', 'us-politics', 'congress', 'senate', 'house', 'supreme-court', 'government', 'policy',
    'trump', 'biden', 'democrats', 'republicans', 'republican-party', 'democratic-party',
    'impeachment', 'shutdown', 'tariffs', 'tariff', 'cabinet', 'executive-orders',
  ],
  culture: [
    'pop-culture', 'culture', 'movies', 'celebrities', 'celebrity-events', 'music', 'tv', 'television',
    'awards', 'oscars', 'grammys', 'entertainment', 'video-games', 'gaming', 'youtube', 'tiktok',
    'streaming', 'netflix', 'anime', 'comics', 'books', 'fashion', 'royal-family', 'time-magazine',
    'person-of-the-year', 'religion', 'aliens', 'christmas',
  ],
}
const CATEGORY_ORDER = [...Object.keys(CATEGORY_TAGS), 'other']
const CATEGORY_LABELS = {
  sports: '体育',
  crypto: '加密',
  weather: '天气',
  elections: '选举',
  tech: '科技',
  economy: '经济',
  world: '国际',
  politics: '政治',
  culture: '文化',
  other: '其他',
}
/** English labels for the agent-tool output when the panel language is not Chinese. */
const CATEGORY_LABELS_EN = {
  sports: 'Sports',
  crypto: 'Crypto',
  weather: 'Weather',
  elections: 'Elections',
  tech: 'Tech',
  economy: 'Economy',
  world: 'World',
  politics: 'Politics',
  culture: 'Culture',
  other: 'Other',
}
const CATEGORY_SETS = Object.fromEntries(
  Object.entries(CATEGORY_TAGS).map(([key, slugs]) => [key, new Set(slugs)]),
)

/** Category label in the current panel language (`zh` or `en`). */
function categoryLabel(key, locale) {
  const table = locale === 'zh' ? CATEGORY_LABELS : CATEGORY_LABELS_EN
  return table[key] ?? key
}

/** Single radar bucket for an event, from its own tags. */
function categoryOf(event) {
  const tags = event?.tags
  if (!Array.isArray(tags) || tags.length === 0) return 'other'
  const slugs = new Set()
  for (const tag of tags) if (tag?.slug) slugs.add(String(tag.slug).toLowerCase())
  for (const key of CATEGORY_ORDER) {
    const set = CATEGORY_SETS[key]
    if (!set) continue
    for (const slug of slugs) if (set.has(slug)) return key
  }
  return 'other'
}

/** Localized tag labels as one lowercase string, for the search index. */
function tagTextOf(event) {
  const tags = event?.tags
  if (!Array.isArray(tags)) return ''
  return tags
    .map((tag) => `${tag?.label ?? ''} ${tag?.slug ?? ''}`.trim())
    .filter(Boolean)
    .join(' ')
}

/** Map a tool argument (key or Chinese label) onto a category key. */
function normalizeCategory(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const key = raw.toLowerCase()
  if (CATEGORY_ORDER.includes(key)) return key
  return CATEGORY_ORDER.find((candidate) => CATEGORY_LABELS[candidate] === raw) ?? ''
}

/**
 * Pull the event or market slug out of a pasted link. Accepts a full URL, a URL
 * without a scheme, or a bare `/event/...` path; locale prefixes such as `/zh/`
 * are skipped, and query strings are ignored.
 */
const POLYMARKET_LINK_RE = /^(?:https?:\/\/)?(?:www\.)?polymarket\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(event|market)\/([^/?#\s]+)/i
const POLYMARKET_PATH_RE = /^\/?(event|market)\/([^/?#\s]+)/i

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parsePolymarketLink(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const match = text.match(POLYMARKET_LINK_RE) ?? text.match(POLYMARKET_PATH_RE)
  if (!match) return null
  const slug = safeDecode(match[2])
  if (!slug) return null
  return { kind: match[1].toLowerCase(), slug, id: /^\d+$/.test(slug) ? slug : '' }
}

// --------------------------------------------------------------------- utils

function num(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function parseArray(value) {
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value ?? 'null')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Width- and case-insensitive text used by the keyword filter. */
function foldKeywordText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse `keywords.txt`: one keyword per line, `#` starts a comment, and commas
 * or semicolons separate extra keywords on the same line. Returns folded,
 * deduplicated substrings.
 */
function parseKeywordConfig(text) {
  const keywords = []
  const seen = new Set()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const body = line.replace(/#.*$/, '').trim()
    if (!body) continue
    for (const token of body.split(/[,，;；]/)) {
      const folded = foldKeywordText(token)
      if (!folded || seen.has(folded)) continue
      seen.add(folded)
      keywords.push(folded)
    }
  }
  return keywords
}

/**
 * Everything the radar shows about an event, folded for substring matching:
 * title, tags, market questions, option labels and slugs (English keywords
 * often survive only in the slug when the Chinese locale translates the title).
 */
function keywordSourceOf(event) {
  const parts = [event?.title, event?.slug]
  for (const tag of event?.tags ?? []) parts.push(tag?.label, tag?.slug)
  for (const market of event?.markets ?? []) {
    parts.push(market?.question, market?.groupItemTitle, market?.slug)
    for (const outcome of parseArray(market?.outcomes)) parts.push(outcome)
  }
  return foldKeywordText(parts.filter(Boolean).join(' \n '))
}

/** True when any configured keyword occurs in the event's visible text. */
function eventMatchesKeywords(event, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return false
  const source = keywordSourceOf(event)
  if (!source) return false
  return keywords.some((keyword) => keyword && source.includes(keyword))
}

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value
}

function daysLeft(iso, now) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return undefined
  return (t - now) / DAY_MS
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function dataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'polymarket-agent')
}

function shortError(error) {
  const text = String(error?.message ?? error ?? '')
    // Never let an error string echo a key, a tx hash or a wallet address.
    .replace(/0x[0-9a-fA-F]{64}/g, '0x…')
    .replace(/0x[0-9a-fA-F]{40}/g, '0x…')
    .replace(/\s+/g, ' ')
    .trim()
  const body = text.length > 240 ? `${text.slice(0, 240)}…` : text || 'unknown-error'
  return `${body}${networkDetail(error)}`
}

/**
 * `fetch failed` on its own says nothing. The SDK wraps the undici error once
 * more (`TransportError → TypeError → Error`), so the code and host sit two
 * `cause` hops down; walk the chain instead of reading only `error.cause`.
 */
function networkDetail(error) {
  const seen = new Set()
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 4 || seen.has(node)) return ''
    seen.add(node)
    if (node.name === 'TimeoutError') return ' (timeout)'
    const code = typeof node.code === 'string' ? node.code : ''
    const host = typeof node.hostname === 'string' ? node.hostname : ''
    if (code) return ` (${code}${host ? ` ${host}` : ''})`
    if (Array.isArray(node.errors)) {
      for (const sub of node.errors) {
        const hit = walk(sub, depth + 1)
        if (hit) return hit
      }
    }
    return walk(node.cause, depth + 1)
  }
  return walk(error, 0)
}


/**
 * Errors worth one automatic retry: the DNS/socket/TLS layer hiccuped, so the
 * next attempt may simply work. A malformed key, a missing wallet or a
 * rejected order is deterministic and must fail fast instead.
 */
export function isTransientStatusError(status) {
  if (status?.reason !== 'bridge-error') return false
  return /fetch failed|socket|timeout|EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_/i.test(
    String(status.error ?? ''),
  )
}

/** Shorten a public address for agent-visible text and logs. */
function shortAddress(value) {
  const text = String(value ?? '')
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}…${text.slice(-4)}` : text
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Endpoint for an error message: origin + path only. Query strings carry the
 * wallet (`?user=0x...`), and an error string ends up in panel state and logs.
 */
function safeEndpoint(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return 'request'
  }
}

/**
 * JSON GET with a User-Agent (Cloudflare 429s anonymous callers) and a short
 * backoff on 429/5xx so one throttled poll does not blank the positions table.
 */
async function fetchJson(url, timeoutMs = 15_000) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) return response.json()
    const error = new Error(`fetch ${safeEndpoint(url)} -> HTTP ${response.status}`)
    error.status = response.status
    lastError = error
    const retryable = response.status === 429 || response.status === 408 || response.status >= 500
    if (!retryable || attempt === 2) throw error
    const retryAfter = Number(response.headers.get('retry-after'))
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 4_000) : 400 * 2 ** attempt
    await sleep(waitMs)
  }
  throw lastError
}

// ------------------------------------------------------------ deposit helpers

/**
 * Polymarket has no unauthenticated "my deposit address" endpoint: the web app
 * reads it from the authenticated onboarding/profile APIs, which need the
 * user's polymarket.com session. We recover the same address from public data:
 *
 *  - Data API v2 exposes pUSD deposit rows (`type=DEPOSIT`) with a tx hash.
 *  - That transaction wraps USDC.e held by the account's deposit wallet into
 *    pUSD minted for the trading wallet. The USDC.e sender is the address the
 *    web deposit modal shows (for legacy accounts, an EIP-7702 deposit wallet;
 *    for new accounts, the Deposit Wallet itself).
 *
 * Accounts that have never deposited have no row yet. A Deposit Wallet account
 * falls back to its own wallet address; everything else is a one-time paste.
 */

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const depositDiscoveryCache = new Map()

function isEvmAddress(value) {
  return typeof value === 'string' && EVM_ADDRESS_RE.test(value.trim())
}

/** Last 20 bytes of an indexed log topic, or null. */
function topicAddress(topic) {
  const hex = String(topic ?? '').toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(hex)) return null
  return `0x${hex.slice(26)}`
}

async function rpcCall(method, params, timeoutMs = 6_000) {
  let lastError = null
  for (const url of POLYGON_RPCS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`rpc HTTP ${response.status}`)
      const payload = await response.json()
      if (payload?.error) throw new Error(String(payload.error.message ?? 'rpc-error'))
      return payload?.result
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('polygon-rpc-unavailable')
}

/**
 * The deposit address is the USDC.e sender in the wrap transaction: the token
 * moves from the deposit wallet to the CollateralOnramp, and pUSD is minted to
 * the trading wallet. Plain transfers from exchanges never produce this row.
 */
const TOKEN_META = Object.freeze({
  [USDCE_ADDRESS.toLowerCase()]: { symbol: 'USDC.e', decimals: 6 },
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', decimals: 6 },
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', decimals: 6 },
})

/**
 * The deposit address is the USDC.e sender in the wrap transaction: the token
 * moves from the deposit wallet to the CollateralOnramp, and pUSD is minted to
 * the trading wallet. Plain transfers from exchanges never produce this row.
 */
function depositTransferFromReceipt(receipt, wallet) {
  const own = String(wallet ?? '').toLowerCase()
  for (const log of receipt?.logs ?? []) {
    const tokenAddress = String(log?.address ?? '').toLowerCase()
    const topics = log?.topics ?? []
    if (String(topics[0] ?? '').toLowerCase() !== ERC20_TRANSFER_TOPIC) continue
    if (topics.length < 3) continue
    const from = topicAddress(topics[1])
    const to = topicAddress(topics[2])
    if (!from || !to) continue
    if (to !== PUSD_ADDRESS.toLowerCase()) continue
    if (from === ZERO_ADDRESS) continue
    if (own && from === own) continue
    if (!isEvmAddress(from)) continue
    const meta = TOKEN_META[tokenAddress] ?? { symbol: 'TOKEN', decimals: 6 }
    let amount = null
    try {
      amount = Number(BigInt(String(log.data ?? '0x0'))) / 10 ** meta.decimals
    } catch {
      amount = null
    }
    return { address: from, asset: meta.symbol, tokenAddress, decimals: meta.decimals, amount }
  }
  return null
}

async function fetchDepositRows(wallet, limit = 5, timeoutMs = 12_000) {
  const url = new URL(`${DATA_API}/activity`)
  url.searchParams.set('user', wallet)
  url.searchParams.set('type', 'DEPOSIT')
  url.searchParams.set('exclude_deposits_withdrawals', 'false')
  url.searchParams.set('limit', String(limit))
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`deposit-history-http-${response.status}`)
  const body = await response.json()
  return Array.isArray(body?.data) ? body.data : []
}

/**
 * Recover the account's deposit address from the newest pUSD deposit. Cached
 * for ten minutes; a miss is cached for three minutes so `/state` polling does
 * not hammer the public API.
 */
async function discoverDepositAddress(wallet, options = {}) {
  if (!isEvmAddress(wallet)) return null
  const key = wallet.toLowerCase()
  const cached = depositDiscoveryCache.get(key)
  const ttl = cached?.value ? 600_000 : 180_000
  if (!options.refresh && cached && Date.now() - cached.at < ttl) return cached.value
  let value = null
  try {
    const rows = await fetchDepositRows(wallet)
    for (const row of rows.slice(0, 5)) {
      const txHash = String(row?.transaction_hash ?? '')
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) continue
      let receipt
      try {
        receipt = await rpcCall('eth_getTransactionReceipt', [txHash], 10_000)
      } catch {
        continue
      }
      const transfer = depositTransferFromReceipt(receipt, wallet)
      if (!transfer) continue
      value = {
        address: transfer.address,
        txHash: txHash.toLowerCase(),
        at: Number(row?.timestamp) ? new Date(Number(row.timestamp) * 1000).toISOString() : null,
        amount: transfer.amount,
        asset: transfer.asset,
        tokenAddress: transfer.tokenAddress,
        network: 'Polygon',
        chainId: 137,
      }
      break
    }
  } catch {
    value = null
  }
  depositDiscoveryCache.set(key, { at: Date.now(), value })
  return value
}

/**
 * Source-chain lookup without requiring the user to provide any API key: scan
 * the same deposit address on BSC, then Ethereum, then Polygon for an incoming
 * USDC/USDT transfer that matches the settlement amount and time. If none
 * matches, the source is explicitly reported as unknown.
 */
const SOURCE_CHAINS = Object.freeze([
  {
    label: 'BSC',
    chainId: 56,
    // Public nodes prune old receipts/logs at very different depths, and some
    // answer an old `eth_getLogs` with an empty array instead of an error.
    // Keep an archive-capable endpoint first and several fallbacks so a
    // deposit still resolves after the ten-minute in-memory cache expires.
    rpcs: [
      'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3',
      'https://rpc.48.club',
      'https://bsc.rpc.blxrbdn.com',
      'https://bsc-rpc.publicnode.com',
    ],
    // Only an initial guess: centerBlockForTimestamp corrects it against the
    // chain's actual current block interval, which BSC changes from time to time.
    blockTime: 0.45,
    // bloXroute caps one logs query at 5,000 blocks. 2,400 blocks on each side
    // is still about twenty minutes, far wider than a source transfer before a relay.
    window: 2400,
    tokens: [
      { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 },
      { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
    ],
  },
  {
    label: 'Ethereum',
    chainId: 1,
    rpcs: [
      'https://eth-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3',
      'https://ethereum-rpc.publicnode.com',
      'https://rpc.48.club',
    ],
    blockTime: 12,
    window: 600,
    tokens: [
      { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
      { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
    ],
  },
  {
    label: 'Polygon',
    chainId: 137,
    rpcs: ['https://polygon-bor-rpc.publicnode.com'],
    blockTime: 2.1,
    window: 3000,
    tokens: [
      { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', symbol: 'USDC.e', decimals: 6 },
      { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6 },
      { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', decimals: 6 },
    ],
  },
])

async function rpcOn(url, method, params, timeoutMs = 15_000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`rpc HTTP ${response.status}`)
  const payload = await response.json()
  if (payload?.error) throw new Error(String(payload.error.message ?? 'rpc-error'))
  return payload?.result
}

/** Try every configured RPC for a chain until one answers. */
async function rpcOnAny(chain, method, params, timeoutMs) {
  let lastError = null
  for (const url of chain.rpcs ?? [chain.rpc]) {
    try {
      return await rpcOn(url, method, params, timeoutMs)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error(`rpc-unavailable:${chain.label}`)
}

/**
 * Query the first RPC that answers. The first entry for each chain is an
 * archive endpoint: a successful empty array there means the transfer really is
 * absent, so do not keep probing slower fallbacks (one BSC fallback can take
 * more than ten seconds). A failed first provider still falls through.
 */
async function logsOnAny(chain, filter, timeoutMs) {
  for (const url of chain.rpcs ?? [chain.rpc]) {
    try {
      const logs = await rpcOn(url, 'eth_getLogs', [filter], timeoutMs)
      if (Array.isArray(logs)) return logs
    } catch {
      // Try the next provider; a failure is not evidence of absence.
    }
  }
  return []
}

/**
 * A Relay fill on Polygon is an EOA calling `transferFrom` from a liquidity
 * wallet, so the transfer sender differs from the transaction sender. A direct
 * user deposit normally has both equal. Skip the former when deciding whether
 * Polygon itself was the source chain.
 */
async function looksLikeRelayFill(chain, log, sender, timeoutMs) {
  try {
    const tx = await rpcOnAny(chain, 'eth_getTransactionByHash', [log.transactionHash], timeoutMs)
    if (!tx?.from) return false
    if (String(tx.from).toLowerCase() === sender) return false
    return String(tx.input ?? '').toLowerCase().startsWith('0x23b872dd')
  } catch {
    return false
  }
}

/**
 * Map a settlement timestamp to a block number without trusting a fixed
 * block time. BSC in particular has changed its block interval more than once,
 * so a constant gets worse the older the deposit is. Start from the configured
 * interval, read the timestamp of that guess, then correct using the interval
 * observed between that block and the head.
 */
async function centerBlockForTimestamp(chain, target, latestNumber, latestTimestamp, timeoutMs) {
  let guess = Math.max(
    0,
    Math.min(latestNumber, latestNumber - Math.round((latestTimestamp - target) / chain.blockTime)),
  )
  let observed = chain.blockTime
  for (let pass = 0; pass < 4; pass += 1) {
    let block
    try {
      block = await rpcOnAny(chain, 'eth_getBlockByNumber', [`0x${guess.toString(16)}`, false], timeoutMs)
    } catch {
      break
    }
    const when = Number.parseInt(block?.timestamp, 16)
    if (!Number.isFinite(when)) break
    const delta = when - target
    if (Math.abs(delta) <= 120) break
    const span = latestNumber - guess
    if (span > 1000) {
      const rate = (latestTimestamp - when) / span
      if (rate > 0.05) observed = rate
    }
    const step = Math.round(delta / observed)
    if (!Number.isFinite(step) || step === 0) break
    guess = Math.max(0, Math.min(latestNumber, guess - step))
  }
  return guess
}

async function scanSourceChain(chain, depositAddress, target, wanted, timeoutMs) {
  let latest
  try {
    latest = await rpcOnAny(chain, 'eth_getBlockByNumber', ['latest', false], timeoutMs)
  } catch {
    return null
  }
  if (!latest?.number) return null
  const latestNumber = Number.parseInt(latest.number, 16)
  const latestTimestamp = Number.parseInt(latest.timestamp, 16)
  const center = await centerBlockForTimestamp(chain, target, latestNumber, latestTimestamp, timeoutMs)
  const from = Math.max(0, center - chain.window)
  const to = Math.min(latestNumber, center + chain.window)
  if (!(to > from)) return null
  const topic2 = `0x${'0'.repeat(24)}${depositAddress.slice(2).toLowerCase()}`
  const tolerance = Math.max(0.01, wanted * 0.02)
  let best = null
  for (const token of chain.tokens) {
    const logs = await logsOnAny(
      chain,
      {
        address: token.address,
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
        topics: [ERC20_TRANSFER_TOPIC, null, topic2],
      },
      timeoutMs,
    )
    for (const log of logs) {
      let amount
      try {
        amount = Number(BigInt(String(log.data ?? '0x0'))) / 10 ** token.decimals
      } catch {
        continue
      }
      if (!(amount > 0)) continue
      const diff = Math.abs(amount - wanted)
      if (diff > tolerance) continue
      const sender = topicAddress(log.topics?.[1])
      if (!sender || sender === depositAddress.toLowerCase()) continue
      let block
      try {
        block = await rpcOnAny(chain, 'eth_getBlockByNumber', [log.blockNumber, false], timeoutMs)
      } catch {
        continue
      }
      const when = Number.parseInt(block.timestamp, 16)
      const delta = target - when
      if (delta < -120 || delta > 3600) continue
      if (chain.chainId === 137 && (await looksLikeRelayFill(chain, log, sender, timeoutMs))) continue
      const score = diff * 1e6 + Math.abs(delta)
      if (best && score >= best.score) continue
      best = {
        symbol: token.symbol,
        amount,
        txHash: String(log.transactionHash),
        sender,
        when,
        score,
      }
    }
  }
  return best
}

async function detectSourceChain(depositAddress, settlement, timeoutMs = 15_000) {
  const destination = {
    chainId: Number(settlement.chainId) || 137,
    chain: 'Polygon',
    asset: settlement.asset ?? null,
    amount: settlement.amount ?? null,
    txHash: settlement.txHash ?? null,
  }
  const unknown = {
    protocol: 'Relay',
    origin: { chainId: 0, chain: '未知', asset: null, amount: null, txHash: null },
    destination,
  }
  if (!isEvmAddress(depositAddress) || !settlement?.at) return unknown
  const target = Date.parse(settlement.at) / 1000
  const wanted = Number(settlement.amount)
  if (!Number.isFinite(target) || !(wanted > 0)) return unknown
  for (const chain of SOURCE_CHAINS) {
    const hit = await scanSourceChain(chain, depositAddress, target, wanted, timeoutMs)
    if (!hit) continue
    return {
      protocol: chain.chainId === 137 ? 'Direct' : 'Relay',
      origin: {
        chainId: chain.chainId,
        chain: chain.label,
        asset: hit.symbol,
        amount: hit.amount,
        txHash: hit.txHash,
      },
      destination,
    }
  }
  return unknown
}

// ------------------------------------------------------------------- runtime

/**
 * Build the runtime for one plugin activation.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function createRuntime(ctx, config) {
  const statePath = path.join(dataDir(), 'state.json')
  const settings = { ...DEFAULT_SETTINGS, ...(config?.settings ?? {}) }
  // Retired key from the `.env` era; drop it from live and persisted settings.
  delete settings.envFile
  const via = String(config?.via ?? '').trim() || DEFAULT_VIA
  const keywordsFileOverride = String(config?.keywordsFile ?? '').trim()

  /** @type {any} */
  let state = {
    version: STATE_VERSION,
    settings,
    bootstrapped: false,
    firstSeen: {},
    spend: { date: today(), usd: 0 },
    orders: [],
    onboarding: { done: false, skipped: false, completedAt: null },
  }
  const bridge = createBridge({ ctx })

  /**
   * Progress of the last "一键授权" run. The panel polls `/approve/status`
   * while the POST is in flight, so the four steps can be shown one by one
   * instead of a silent two-minute spinner.
   */
  let approvalRun = null
  const APPROVAL_STEPS = ['credentials', 'session', 'state', 'submit']

  function startApprovalRun() {
    approvalRun = {
      id: Number(approvalRun?.id ?? 0) + 1,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      running: true,
      steps: APPROVAL_STEPS.map((id) => ({ id, status: 'pending', at: null, ms: null, data: null })),
      result: null,
    }
    return approvalRun
  }

  function recordApproval(event) {
    const run = approvalRun
    if (!run?.running) return
    const step = run.steps.find((row) => row.id === event?.step)
    if (!step) return
    const now = Date.now()
    if (step.at === null) step.at = now
    if (event.status === 'running') {
      step.status = 'running'
      step.ms = null
    } else {
      step.status = event.status === 'error' ? 'error' : event.status === 'warn' ? 'warn' : 'ok'
      step.ms = now - step.at
    }
    if (event.data) step.data = event.data
  }

  function finishApprovalRun(result) {
    if (!approvalRun) return approvalRun
    approvalRun.running = false
    approvalRun.finishedAt = new Date().toISOString()
    approvalRun.result = {
      ok: Boolean(result?.ok),
      stage: result?.stage ?? null,
      error: result?.error ?? null,
    }
    // Never leave a step spinning once the run is over.
    for (const step of approvalRun.steps) {
      if (step.status === 'running') step.status = 'error'
    }
    return approvalRun
  }

  /**
   * Live view of the keyword filter. `keywords` are folded substrings read from
   * disk; `hidden` is how many events the last scan dropped, so the panel (and
   * the user) can see the filter working without listing the hidden events.
   */
  const keywordFilter = {
    file: '',
    keywords: [],
    updatedAt: null,
    hidden: 0,
    error: null,
    stamp: '',
  }

  function keywordCandidateFiles() {
    return [path.join(PLUGIN_DIR, KEYWORDS_FILE_NAME), path.join(PLUGIN_DIR, '..', KEYWORDS_FILE_NAME)]
  }

  async function seedKeywordFile(file) {
    await mkdir(path.dirname(file), { recursive: true })
    let text
    try {
      text = await readFile(path.join(PLUGIN_DIR, KEYWORDS_SEED_FILE), 'utf8')
    } catch {
      text = `${KEYWORDS_FALLBACK.join('\n')}\n`
    }
    await writeFile(file, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 })
    ctx.logger?.info?.(`polymarket-agent: created keyword filter at ${file}`)
  }

  /** First existing config file, or the seeded data-dir fallback. */
  async function keywordFile() {
    const configured = keywordsFileOverride
    if (configured) {
      const file = path.resolve(configured)
      try {
        await stat(file)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        await seedKeywordFile(file)
      }
      return file
    }
    for (const file of keywordCandidateFiles()) {
      try {
        await stat(file)
        return file
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          ctx.logger?.warn?.(`polymarket-agent: cannot stat keyword filter ${file}: ${error}`)
        }
      }
    }
    const fallback = path.join(dataDir(), KEYWORDS_FILE_NAME)
    try {
      await stat(fallback)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await seedKeywordFile(fallback)
    }
    return fallback
  }

  /**
   * Re-read the keyword file when its mtime/size changed. A read failure keeps
   * the previous list (fail closed) and surfaces the error to the panel.
   */
  async function loadKeywordFilter(force = false) {
    try {
      const file = await keywordFile()
      const stamp = await stat(file)
      const fingerprint = `${file}|${stamp.mtimeMs}|${stamp.ctimeMs}|${stamp.size}`
      if (!force && keywordFilter.stamp === fingerprint) return keywordFilter
      const text = await readFile(file, 'utf8')
      const keywords = parseKeywordConfig(text)
      keywordFilter.file = file
      keywordFilter.keywords = keywords
      keywordFilter.updatedAt = stamp.mtime.toISOString()
      keywordFilter.error = null
      keywordFilter.stamp = fingerprint
      ctx.logger?.info?.(`polymarket-agent: keyword filter loaded ${keywords.length} words from ${file}`)
    } catch (error) {
      keywordFilter.error = shortError(error)
      if (keywordFilter.keywords.length === 0) {
        keywordFilter.keywords = parseKeywordConfig(KEYWORDS_FALLBACK.join('\n'))
      }
      ctx.logger?.warn?.(`polymarket-agent: cannot read keyword filter: ${error}`)
    }
    return keywordFilter
  }

  function filterView() {
    return {
      file: keywordFilter.file,
      keywords: keywordFilter.keywords.length,
      hidden: keywordFilter.hidden,
      updatedAt: keywordFilter.updatedAt,
      scannedAt: cache?.generatedAt ?? null,
      error: keywordFilter.error,
    }
  }

  function clientVia() {
    return via
  }

  function marketLink(slug) {
    const clean = String(slug ?? '').trim()
    if (!clean) return ''
    return `https://polymarket.com/market/${clean}?via=${encodeURIComponent(clientVia())}`
  }

  let loaded = false
  let loading
  let saving
  let saveTimer
  let cache
  let inflight
  let inflightLocale
  let pollTimer
  let quoteCache = { key: '', at: 0, value: null }
  /** Memory-only cache for the cross-chain source scan (keyed by deposit tx). */
  const depositBridgeCache = new Map()

  const sweeper = {
    intervalSeconds: 1800,
    runs: 0,
    lastAt: null,
    lastMs: 0,
    lastErrors: [],
    nextAt: null,
    running: false,
  }

  function pollSeconds() {
    return clamp(Math.round(num(state.settings?.refreshSeconds) || 1800), 60, 86_400)
  }

  async function load() {
    if (loaded) return
    if (loading) return loading
    loading = (async () => {
      let cleaned = false
      try {
        const raw = JSON.parse(await readFile(statePath, 'utf8'))
        if (raw && raw.version === STATE_VERSION) {
          // `firstSeen` used to be keyed by market id; the board is keyed by
          // event now, so an old map would mark the whole board as new.
          const migrated = raw.firstSeenMode !== 'event'
          const legacyDeposit = typeof raw?.deposit?.address === 'string' ? raw.deposit.address.trim() : ''
          state = {
            ...state,
            ...raw,
            settings: { ...settings, ...(raw.settings ?? {}) },
            spend: { date: today(), usd: 0, ...(raw.spend ?? {}) },
            firstSeen: migrated ? {} : raw.firstSeen ?? {},
            bootstrapped: migrated ? false : Boolean(raw.bootstrapped),
            firstSeenMode: 'event',
            orders: Array.isArray(raw.orders) ? raw.orders : [],
          }
          // Account data belongs in the credentials store. Older builds kept a
          // manual deposit address here; move it once, then scrub the field.
          delete state.deposit
          delete state.settings.envFile
          if (raw.deposit !== undefined || raw.settings?.envFile !== undefined) cleaned = true
          if (legacyDeposit && isEvmAddress(legacyDeposit)) {
            try {
              await bridge.setCredentials({ depositAddress: legacyDeposit })
              ctx.logger?.info?.(
                'polymarket-agent: moved the legacy manual deposit address into the DSH credentials store',
              )
            } catch (error) {
              ctx.logger?.warn?.(`polymarket-agent: cannot migrate legacy deposit address: ${shortError(error)}`)
            }
          } else if (legacyDeposit) {
            ctx.logger?.warn?.('polymarket-agent: discarded an invalid legacy deposit address from state.json')
          }
          Object.assign(settings, state.settings)
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') ctx.logger?.warn?.(`polymarket-agent: cannot read state: ${error}`)
      }
      // An order still 'pending' after a restart can never settle by itself.
      for (const order of state.orders ?? []) {
        if (order.status !== 'pending') continue
        if (Date.now() - Date.parse(order.at) < 300_000) continue
        order.status = 'failed'
        order.ok = false
        order.error = order.error ?? 'interrupted'
      }
      loaded = true
      // Rewrite state.json so the removed address/settings key do not linger.
      if (cleaned) markDirty()
    })()
    return loading
  }

  function markDirty() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      saving = persist()
    }, 400)
    saveTimer.unref?.()
  }

  async function persistNow() {
    await mkdir(path.dirname(statePath), { recursive: true })
    await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 })
  }

  async function persist() {
    try {
      await persistNow()
    } catch (error) {
      ctx.logger?.warn?.(`polymarket-agent: cannot write state: ${error}`)
    }
  }

  // ------------------------------------------------------------------ sweep

  async function gamma(pathname, timeoutMs = 20_000) {
    return fetchJson(`${GAMMA}${pathname}`, timeoutMs)
  }

  async function dataApi(pathname, timeoutMs = 15_000) {
    return fetchJson(`${DATA_API}${pathname}`, timeoutMs)
  }

  /**
   * Polymarket title language: the Chinese locale only when the
   * DeepSeek Harness UI is Chinese, the English locale for everything else.
   */
  function marketLocale() {
    return settings.marketLocale === 'zh' ? 'zh' : 'en'
  }

  /**
   * The Host keeps the Web UI locale preference in the settings document.
   * Reading it lets the very first sweep use the right title language before a
   * browser tab has announced itself; the panel's later report still wins.
   */
  function hostLocalePreference() {
    try {
      const rows = ctx.get?.('settings')?.describe?.() ?? []
      const row = Array.isArray(rows) ? rows.find((entry) => String(entry?.ns) === 'locale') : undefined
      for (const source of [row?.value, row?.base, row?.user]) {
        const preference = String(source?.preference ?? '')
          .trim()
          .toLowerCase()
        if (!preference) continue
        return preference === 'zh' || preference.startsWith('zh-') ? 'zh' : 'en'
      }
    } catch (error) {
      ctx.logger?.warn?.(`polymarket-agent: cannot read the Host locale preference: ${shortError(error)}`)
    }
    return ''
  }

  let hostLocaleRead = false
  let panelLocaleReported = false
  async function applyHostLocalePreference() {
    if (hostLocaleRead || panelLocaleReported) return
    hostLocaleRead = true
    const preferred = hostLocalePreference()
    if (!preferred || marketLocale() === preferred) return
    settings.marketLocale = preferred
    state.settings = { ...state.settings, marketLocale: preferred }
    markDirty()
  }

  async function sweep(locale = marketLocale()) {
    const pages = clamp(Math.round(num(state.settings.pages) || 6), 1, 8)
    const tasks = []
    for (let page = 0; page < pages; page += 1) tasks.push(page * 100)
    const byId = new Map()
    const errors = []
    const batches = await Promise.all(
      tasks.map((offset) =>
        gamma(
          `/events?closed=false&active=true&limit=100&offset=${offset}&order=volume24hr&ascending=false&locale=${locale}`,
        ).catch((error) => {
          errors.push(shortError(error))
          return []
        }),
      ),
    )
    for (const batch of batches) {
      if (!Array.isArray(batch)) continue
      for (const event of batch) if (event?.id) byId.set(String(event.id), event)
    }
    return { events: [...byId.values()], errors }
  }

  /**
   * One binary, orderable market reduced to what the panel renders. `strict`
   * applies the radar thresholds (volume, horizon); an explicit link lookup
   * keeps the event's markets even when they fall outside them.
   */
  function normalizeMarket(market, event, now, options = {}) {
    const { withText = false, strict = true } = options
    if (!market || market.closed || market.active === false) return undefined
    if (market.acceptingOrders === false || market.enableOrderBook === false) return undefined
    const outcomes = parseArray(market.outcomes).map((value) => String(value))
    const prices = parseArray(market.outcomePrices).map(num)
    const tokens = parseArray(market.clobTokenIds).map((value) => String(value))
    if (outcomes.length !== 2 || prices.length !== 2 || tokens.length < 2) return undefined
    if (!(prices[0] > 0 && prices[0] < 1) || !(prices[1] > 0 && prices[1] < 1)) return undefined
    const endDate = market.endDate ?? event.endDate
    const days = daysLeft(endDate, now)
    if (days === undefined) return undefined
    if (strict && days < 0) return undefined
    if (strict && settings.maxDays > 0 && days > settings.maxDays) return undefined
    const volume24h = num(market.volume24hr ?? event.volume24hr)
    if (strict && volume24h < num(settings.minVolume24h)) return undefined
    const yesIndex = outcomes.findIndex((label) => /^(yes|是)$/i.test(label.trim()))
    const noIndex = outcomes.findIndex((label) => /^(no|否)$/i.test(label.trim()))
    const recognized = yesIndex >= 0 && noIndex >= 0
    const sides = outcomes.map((label, index) => ({
      label,
      price: Number(prices[index].toFixed(4)),
      token: tokens[index],
    }))
    const market_ = {
      id: String(market.id ?? market.slug ?? ''),
      slug: String(market.slug ?? ''),
      conditionId: String(market.conditionId ?? ''),
      question: String(market.question ?? event.title ?? ''),
      groupLabel: String(market.groupItemTitle ?? '').trim(),
      eventId: String(event.id ?? ''),
      eventSlug: String(event.slug ?? ''),
      eventTitle: String(event.title ?? ''),
      icon: String(market.icon ?? event.icon ?? market.image ?? event.image ?? ''),
      endDate,
      days: Number(days.toFixed(2)),
      sides,
      yes: recognized ? sides[yesIndex].price : null,
      no: recognized ? sides[noIndex].price : null,
      tokenYes: recognized ? sides[yesIndex].token : null,
      tokenNo: recognized ? sides[noIndex].token : null,
      spread: num(market.spread),
      liquidity: num(market.liquidityNum ?? market.liquidity),
      volume24h,
      volume: num(market.volumeNum ?? market.volume),
      negRisk: Boolean(event.negRisk ?? market.negRisk),
      newMarket: Boolean(market.new),
    }
    // Descriptions are long and identical across an event's markets; the list
    // snapshot omits them and the detail request carries them for one event.
    if (withText) {
      market_.rules = String(market.description ?? '')
      market_.resolutionSource = String(market.resolutionSource ?? event.resolutionSource ?? '')
    }
    return market_
  }

  /** Compact outcome preview carried inside an event row. */
  function previewMarket(market) {
    return {
      id: market.id,
      slug: market.slug,
      question: market.question,
      groupLabel: market.groupLabel,
      sides: market.sides.map((side) => ({ label: side.label, price: side.price })),
      volume24h: market.volume24h,
    }
  }

  /**
   * One event row, shared by the radar sweep and by a link lookup. `markets`
   * are already normalized and sorted by 24h volume.
   */
  function summarizeEvent(raw, marketRows, now) {
    const markets = marketRows.slice().sort((a, b) => b.volume24h - a.volume24h)
    const top = markets.slice(0, 4)
    const days = markets.length
      ? markets.reduce((best, market) => Math.min(best, market.days), Number.POSITIVE_INFINITY)
      : daysLeft(raw.endDate, now)
    return {
      id: String(raw.id ?? ''),
      slug: String(raw.slug ?? ''),
      title: String(raw.title ?? top[0]?.question ?? ''),
      icon: String(raw.icon ?? raw.image ?? ''),
      endDate: raw.endDate ?? top[0]?.endDate ?? null,
      days: Number.isFinite(days) ? Number(days.toFixed(2)) : 0,
      volume24h: num(raw.volume24hr) || markets.reduce((acc, market) => acc + market.volume24h, 0),
      volume: num(raw.volumeNum ?? raw.volume),
      liquidity: num(raw.liquidityNum ?? raw.liquidity),
      negRisk: Boolean(raw.negRisk),
      marketCount: markets.length,
      category: categoryOf(raw),
      newMarket: false,
      keywords: `${raw.title ?? ''} ${tagTextOf(raw)} ${top.map((market) => market.question).join(' ')}`.toLowerCase(),
      top: top.map(previewMarket),
    }
  }

  /**
   * Rank markets and fold them into their event. Polymarket groups one question
   * ("Fed decision in December") into many binary outcome markets; showing the
   * event with its top outcomes keeps the panel readable and the payload small.
   */
  function analyze(rawEvents, now) {
    const markets = []
    const groups = new Map()
    const seen = new Set()
    let filtered = 0
    for (const event of rawEvents) {
      if (!event || event.closed || event.active === false) continue
      if (settings.hideNoise !== false && NOISE_TITLE.test(String(event.title ?? ''))) continue
      if (eventMatchesKeywords(event, keywordFilter.keywords)) {
        filtered += 1
        continue
      }
      let group = groups.get(String(event.id))
      if (!group) {
        group = {
          id: String(event.id ?? ''),
          slug: String(event.slug ?? ''),
          title: String(event.title ?? ''),
          icon: String(event.icon ?? event.image ?? ''),
          endDate: event.endDate ?? null,
          volume24h: num(event.volume24hr),
          volume: num(event.volumeNum ?? event.volume),
          liquidity: num(event.liquidityNum ?? event.liquidity),
          negRisk: Boolean(event.negRisk),
          category: categoryOf(event),
          tagText: tagTextOf(event),
          markets: [],
        }
        groups.set(group.id, group)
      }
      for (const market of event.markets ?? []) {
        const normalized = normalizeMarket(market, event, now)
        if (!normalized?.id || seen.has(normalized.id)) continue
        seen.add(normalized.id)
        markets.push(normalized)
        group.markets.push(normalized)
      }
    }
    markets.sort((a, b) => b.volume24h - a.volume24h)

    const established = Boolean(state.bootstrapped)
    const nextFirstSeen = {}
    let freshEvents = 0
    const events = []
    for (const group of groups.values()) {
      if (group.markets.length === 0) continue
      group.markets.sort((a, b) => b.volume24h - a.volume24h)
      const prior = state.firstSeen?.[group.id]
      if (prior) nextFirstSeen[group.id] = prior
      else {
        nextFirstSeen[group.id] = now
        if (established) freshEvents += 1
      }
      const isNew = established && !prior
      const top = group.markets.slice(0, 4)
      const days = group.markets.reduce((best, market) => Math.min(best, market.days), Number.POSITIVE_INFINITY)
      events.push({
        id: group.id,
        slug: group.slug,
        title: group.title || top[0]?.eventTitle || top[0]?.question || '',
        icon: group.icon || top[0]?.icon || '',
        endDate: group.endDate ?? top[0]?.endDate ?? null,
        days: Number(days.toFixed(2)),
        volume24h: group.volume24h || group.markets.reduce((acc, market) => acc + market.volume24h, 0),
        volume: group.volume,
        liquidity: group.liquidity,
        negRisk: group.negRisk,
        marketCount: group.markets.length,
        category: group.category,
        newMarket: isNew || group.markets.some((market) => market.newMarket),
        keywords: `${group.title} ${group.tagText} ${top.map((market) => market.question).join(' ')}`.toLowerCase(),
        top: top.map(previewMarket),
      })
    }
    events.sort((a, b) => b.volume24h - a.volume24h)
    state.firstSeen = nextFirstSeen
    state.firstSeenMode = 'event'
    state.bootstrapped = true
    const byEventSlug = new Map(events.map((event) => [event.slug, event]))
    return {
      events,
      markets,
      byEventSlug,
      filtered,
      counts: {
        events: events.length,
        markets: markets.length,
        newEvents: freshEvents,
        yesNo: markets.filter((market) => market.yes !== null).length,
      },
    }
  }

  async function refresh() {
    // A sweep already running in the other language cannot serve the panel, so
    // wait it out instead of sharing its result.
    if (inflight && inflightLocale === marketLocale()) return inflight
    if (inflight) {
      try {
        await inflight
      } catch {
        // the caller below retries with a fresh sweep
      }
      if (cache?.locale === marketLocale()) return cache
      if (inflight && inflightLocale === marketLocale()) return inflight
    }
    const locale = marketLocale()
    sweeper.running = true
    const run = (async () => {
      const started = Date.now()
      await loadKeywordFilter()
      const { events, errors } = await sweep(locale)
      const now = Date.now()
      const { events: eventRows, markets, byEventSlug, counts, filtered } = analyze(events, now)
      keywordFilter.hidden = filtered
      const generatedAt = new Date(now).toISOString()
      cache = {
        generatedAt,
        locale,
        elapsedMs: Date.now() - started,
        errors,
        counts,
        filter: { ...filterView(), scannedAt: generatedAt },
        events: eventRows,
        markets,
        byEventSlug,
        rawEvents: events.length,
        via: clientVia(),
      }
      markDirty()
      sweeper.runs += 1
      sweeper.lastAt = cache.generatedAt
      sweeper.lastMs = Date.now() - started
      sweeper.lastErrors = errors
      return cache
    })()
    inflight = run
    inflightLocale = locale
    try {
      return await run
    } finally {
      if (inflight === run) {
        inflight = undefined
        inflightLocale = undefined
      }
      if (!inflight) sweeper.running = false
    }
  }

  function scheduleSweep(delayMs) {
    if (pollTimer) clearTimeout(pollTimer)
    const seconds = pollSeconds()
    sweeper.intervalSeconds = seconds
    const wait = delayMs ?? seconds * 1000
    sweeper.nextAt = new Date(Date.now() + wait).toISOString()
    pollTimer = setTimeout(async () => {
      try {
        await refresh()
      } catch (error) {
        sweeper.lastErrors = [shortError(error)]
        ctx.logger?.warn?.(`polymarket-agent sweep failed: ${shortError(error)}`)
      }
      scheduleSweep()
    }, wait)
    pollTimer.unref?.()
  }

  async function getScan(force) {
    await load()
    await applyHostLocalePreference()
    const stale = Boolean(cache && cache.locale !== marketLocale())
    if (cache && !force && !stale && Date.now() - Date.parse(cache.generatedAt) < pollSeconds() * 1000) return cache
    if (cache && !force && !stale && inflight) return inflight
    try {
      return await refresh()
    } catch (error) {
      if (cache) return { ...cache, errors: [...cache.errors, shortError(error)] }
      throw error
    }
  }

  // --------------------------------------------------------------- trading

  function positive(value, fallback) {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }

  /**
   * USD caps are owned by the panel (`settings.caps`, written by the
   * onboarding wizard). There is no `.env` or process-environment fallback:
   * an unset cap is a safe default, never an ambient surprise. There is no
   * on/off switch: a configured, approved account can order immediately.
   */
  function tradingLimits() {
    const panel = state.settings?.caps && typeof state.settings.caps === 'object' ? state.settings.caps : null
    const maxOrderUsd = positive(panel?.maxOrderUsd, 100)
    const dailyUsd = positive(panel?.dailyUsd, Math.max(maxOrderUsd, 100))
    return {
      maxOrderUsd,
      dailyUsd,
      source: {
        maxOrderUsd: panel?.maxOrderUsd !== undefined ? 'panel' : 'default',
        dailyUsd: panel?.dailyUsd !== undefined ? 'panel' : 'default',
      },
    }
  }

  function spendToday() {
    return state.spend?.date === today() ? num(state.spend?.usd) : 0
  }

  /** Add a fill to today's spend exactly once per newly matched share. */
  function addSpend(amount) {
    const value = num(amount)
    if (!(value > 0)) return
    state.spend = { date: today(), usd: Number((spendToday() + value).toFixed(4)) }
  }

  /**
   * What a live BUY still reserves against the daily cap. Limit orders reserve
   * only the unfilled remainder, so a partial fill gradually releases budget.
   */
  function remainingOrderNotional(order) {
    if (order?.kind !== 'BUY') return 0
    if (order.status !== 'pending' && order.status !== 'open') return 0
    if (order.orderType === 'limit') {
      const shares = num(order.shares)
      const filled = num(order.filledShares)
      return Math.max(0, shares - filled) * num(order.price)
    }
    return num(order.notional)
  }

  function pendingNotional() {
    return state.orders.reduce((acc, order) => acc + remainingOrderNotional(order), 0)
  }

  async function liveStatus(force = false) {
    const limits = tradingLimits()
    const spend = spendToday()
    const pending = pendingNotional()
    const startedAt = Date.now()
    let status = await bridge.status(force)
    // A forced read bypasses the 30 s status cache. Retry one fast, transient
    // failure so a single blip does not paint an error card the user has to
    // clear by hand; a call that already hung for seconds is not retried.
    let retried = false
    if (force && Date.now() - startedAt < 2_500 && isTransientStatusError(status)) {
      await sleep(450)
      status = await bridge.status(true)
      retried = true
    }
    if (state.orders.some((order) => order.status === 'open' && order.orderType === 'limit')) {
      void syncOpenOrders()
    }
    return {
      ready: status.ready,
      limits,
      wallet: status.wallet,
      walletType: status.walletType,
      signer: status.signer,
      cash: status.cash,
      approvals: status.approvals,
      configured: status.configured,
      credentialSource: status.sources?.privateKey ?? 'none',
      spentToday: Number(spend.toFixed(2)),
      pendingUsd: Number(pending.toFixed(2)),
      remainingToday: Number(Math.max(0, limits.dailyUsd - spend - pending).toFixed(2)),
      orders: state.orders.slice(0, 12),
      reason: status.reason,
      error: status.error,
      retried,
      at: status.at,
    }
  }

  // -------------------------------------------------------------- portfolio

  function mapPosition(row) {
    return {
      tokenId: String(row.token_id ?? ''),
      conditionId: String(row.condition_id ?? ''),
      title: String(row.title ?? ''),
      slug: String(row.slug ?? ''),
      eventSlug: String(row.event_slug ?? ''),
      icon: String(row.icon ?? ''),
      outcome: String(row.outcome ?? ''),
      outcomeIndex: num(row.outcome_index),
      size: num(row.current_size),
      avgPrice: num(row.avg_price),
      currentPrice: num(row.current_price),
      currentValue: num(row.current_value),
      entryCost: num(row.entry_cost_usdc),
      fees: num(row.entry_fees_usdc),
      realizedPnl: num(row.realized_pnl),
      unrealizedPnl: num(row.unrealized_pnl),
      totalPnl: num(row.total_pnl),
      percentPnl: num(row.percent_pnl),
      status: String(row.status ?? 'OPEN'),
      redeemable: Boolean(row.redeemable),
      mergeable: Boolean(row.mergeable),
      negativeRisk: Boolean(row.negative_risk),
      endDate: row.end_date ?? null,
      eventId: String(row.event_id ?? ''),
    }
  }

  function mapActivity(row) {
    return {
      at: Number(row.timestamp) ? new Date(Number(row.timestamp) * 1000).toISOString() : null,
      type: String(row.type ?? ''),
      side: row.side ? String(row.side) : null,
      title: String(row.title ?? ''),
      slug: String(row.slug ?? ''),
      eventSlug: String(row.event_slug ?? ''),
      icon: String(row.icon ?? ''),
      outcome: row.outcome ? String(row.outcome) : null,
      price: num(row.price),
      size: num(row.size),
      usdc: num(row.usdc_size),
      txHash: row.transaction_hash ?? null,
    }
  }

  async function walletAddress(force = false) {
    const status = await bridge.status(force)
    if (status.wallet) return status.wallet
    const described = await bridge.describe()
    return described.wallet ?? null
  }

  /**
   * Portfolio snapshot: cash + open/redeemable positions + the recent activity
   * feed. Cached briefly because the panel polls it while a positions view is
   * open.
   */
  async function portfolio(force = false) {
    const status = await bridge.status(force)
    const wallet = status.wallet ?? (await bridge.describe()).wallet ?? null
    const base = {
      configured: Boolean(status.configured?.key && wallet),
      wallet,
      cash: status.cash ?? null,
      value: null,
      total: null,
      positionsValue: 0,
      positions: [],
      history: [],
      stale: false,
      errors: [],
      at: new Date().toISOString(),
    }
    if (!wallet) return base

    const key = `${wallet}:cached`
    if (!force && quoteCache.key === key && Date.now() - quoteCache.at < 15_000) return quoteCache.value

    const errors = []
    const [value, open, redeemable, activity] = await Promise.all([
      dataApi(`/value?user=${encodeURIComponent(wallet)}`).catch((error) => {
        errors.push(`value: ${shortError(error)}`)
        return null
      }),
      dataApi(
        `/positions?user=${encodeURIComponent(wallet)}&status=OPEN&limit=50&sort_by=CURRENT_VALUE&sort_direction=DESC&include_archived=false`,
      ).catch((error) => {
        errors.push(`positions: ${shortError(error)}`)
        return null
      }),
      dataApi(
        `/positions?user=${encodeURIComponent(wallet)}&status=REDEEMABLE&limit=50&sort_by=CURRENT_VALUE&sort_direction=DESC&include_archived=false`,
      ).catch((error) => {
        errors.push(`redeemable: ${shortError(error)}`)
        return null
      }),
      dataApi(`/activity?user=${encodeURIComponent(wallet)}&limit=60`).catch((error) => {
        errors.push(`activity: ${shortError(error)}`)
        return null
      }),
    ])

    // A failed poll must not look like "you have no positions": fall back to the
    // last successful snapshot and let the client show it as stale.
    const previous = quoteCache.key === key && quoteCache.value ? quoteCache.value : null
    const openRows = Array.isArray(open?.data) ? open.data : null
    const redeemableRows = Array.isArray(redeemable?.data) ? redeemable.data : null
    let stale = false
    const byToken = new Map()
    for (const position of [
      ...(openRows ?? []).map(mapPosition),
      ...(redeemableRows ?? []).map(mapPosition),
    ]) {
      if (!position.tokenId || position.size <= 0) continue
      const prior = byToken.get(position.tokenId)
      // The REDEEMABLE query also returns still-open rows for some wallets;
      // keep one row per token, preferring the larger size and the redeemable flag.
      if (!prior) byToken.set(position.tokenId, position)
      else {
        if (position.size > prior.size) byToken.set(position.tokenId, position)
        else if (position.redeemable) prior.redeemable = true
      }
    }
    if (openRows === null || redeemableRows === null) {
      for (const position of previous?.positions ?? []) {
        if (!byToken.has(position.tokenId)) {
          byToken.set(position.tokenId, position)
          stale = true
        }
      }
    }
    const positions = [...byToken.values()]
    const activityRows = Array.isArray(activity?.data) ? activity.data : null
    const history = activityRows === null ? previous?.history ?? [] : activityRows.map(mapActivity)
    if (activityRows === null && history.length > 0) stale = true
    const positionsValue = positions.reduce((acc, position) => acc + position.currentValue, 0)
    const portfolioValue = value?.data?.value !== undefined ? num(value.data.value) : positionsValue
    const cash = status.cash === null || status.cash === undefined ? null : num(status.cash)
    const result = {
      ...base,
      value: Number(portfolioValue.toFixed(2)),
      positionsValue: Number(positionsValue.toFixed(2)),
      total: Number((portfolioValue + (cash ?? 0)).toFixed(2)),
      positions,
      history,
      stale,
      errors,
      at: new Date().toISOString(),
    }
    quoteCache = { key, at: Date.now(), value: result }
    return result
  }

  // ----------------------------------------------------------------- orders

  /** Persist one submitted order and let the bridge settle it in the background. */
  async function runOrder(record, task) {
    try {
      const result = await task()
      const ok = Boolean(result.ok)
      const isLimit = record.orderType === 'limit'
      const resting = ok && isLimit && (result.status === 'live' || result.status === 'delayed')
      const shares = num(result.size ?? record.shares)
      const filledShares = ok
        ? Math.min(shares || Infinity, num(result.filledSize ?? (resting ? 0 : shares)))
        : 0
      const fullyFilled = ok && !resting && (!(shares > 0) || filledShares + 1e-9 >= shares)
      record.ok = ok
      record.price = num(result.price ?? record.price)
      record.shares = shares || null
      record.filledShares = Number((filledShares || 0).toFixed(4))
      record.notional = Number(num(result.notional ?? record.notional).toFixed(4))
      record.orderId = result.orderId ?? null
      record.brokerStatus = result.status
      record.status = !ok ? 'failed' : fullyFilled || !isLimit ? 'filled' : 'open'
      record.error = ok ? undefined : result.error ?? 'order-failed'
      if (record.status === 'filled' || record.status === 'failed') {
        record.finishedAt = new Date().toISOString()
        record.elapsedMs = Date.now() - Date.parse(record.at)
      }
      if (ok && record.kind === 'BUY' && record.filledShares > 0) {
        addSpend(record.filledShares * record.price)
      }
      if (ok && (fullyFilled || !isLimit)) quoteCache = { key: '', at: 0, value: null }
    } catch (error) {
      record.ok = false
      record.status = 'failed'
      record.error = shortError(error)
      record.finishedAt = new Date().toISOString()
    }
    markDirty()
  }

  /** Copy a refreshed venue order into the persisted record. */
  function applyOrderInfo(record, info) {
    if (!record || !info?.ok) return false
    const price = num(record.price)
    const original = num(info.originalSize) || num(record.shares)
    const filled = Math.max(num(record.filledShares), Math.min(num(info.filledSize), original || Infinity))
    const delta = filled - num(record.filledShares)
    let changed = false
    if (delta > 1e-9) {
      record.filledShares = Number(filled.toFixed(4))
      addSpend(delta * price)
      changed = true
    }
    const status = String(info.status ?? '').toLowerCase()
    if (status.includes('cancel')) {
      record.status = 'canceled'
      record.canceledAt ??= new Date().toISOString()
      record.finishedAt ??= record.canceledAt
      changed = true
    } else if (original > 0 && filled + 1e-6 >= original) {
      record.status = 'filled'
      record.ok = true
      record.finishedAt ??= new Date().toISOString()
      changed = true
    } else if (record.status === 'pending') {
      record.status = 'open'
      changed = true
    }
    if (changed) markDirty()
    return changed
  }

  let orderSyncAt = 0
  let orderSyncPromise = null

  /**
   * Refresh the fill state of resting limit orders. Throttled because `/state`
   * is polled often; a single in-flight sweep is shared by all callers.
   */
  function syncOpenOrders(force = false) {
    if (orderSyncPromise) return orderSyncPromise
    const open = state.orders.filter(
      (order) => order.status === 'open' && order.orderType === 'limit' && order.orderId,
    )
    if (open.length === 0) return Promise.resolve(false)
    if (!force && Date.now() - orderSyncAt < 15_000) return Promise.resolve(false)
    orderSyncAt = Date.now()
    orderSyncPromise = Promise.all(
      open.slice(0, 8).map(async (record) => {
        const info = await bridge.orderInfo({ orderId: record.orderId })
        if (info?.ok) applyOrderInfo(record, info)
      }),
    )
      .then(() => markDirty())
      .catch((error) => ctx.logger?.warn?.(`polymarket-agent order sync failed: ${shortError(error)}`))
      .finally(() => {
        orderSyncPromise = null
      })
    return orderSyncPromise
  }

  function pushRecord(record) {
    state.orders.unshift(record)
    state.orders = state.orders.slice(0, 80)
    markDirty()
  }

  /**
   * Validate and queue a BUY. `orderType` is `market` for a dollar ticket that
   * crosses the current ask, or `limit` for an explicit GTC price/share ticket.
   * The record is returned immediately; the bridge posts the signed order in
   * the background so the panel stays responsive.
   */
  async function placeBuy({ tokenId, orderType, amountUsd, maxPrice, price, shares, title, outcome, label }) {
    await load()
    const status = await liveStatus()
    if (!status.ready) return { ok: false, error: status.reason ?? 'bridge-missing', detail: status.error }
    const caps = status.limits
    const mode = orderType === 'limit' ? 'limit' : 'market'
    const limitPrice = num(price)
    const shareCount = num(shares)
    const notional = mode === 'limit' ? Number((limitPrice * shareCount).toFixed(4)) : num(amountUsd)
    if (mode === 'limit') {
      if (!(shareCount > 0)) return { ok: false, error: 'shares-required' }
      if (!(limitPrice > 0)) return { ok: false, error: 'price-required' }
    } else if (!(notional > 0)) {
      return { ok: false, error: 'amount-required' }
    }
    if (notional > caps.maxOrderUsd + 1e-9) {
      return { ok: false, error: 'order-cap', maxOrderUsd: caps.maxOrderUsd }
    }
    // Polymarket's CLOB accepts prices below 1 only; the highest valid order
    // is one tick under settlement (0.99 / 0.999 / 0.9999). There is no
    // user-facing price cap any more; the market ticket still passes the live
    // ask as its own hard ceiling.
    const capsPrice = mode === 'limit' ? limitPrice : num(maxPrice)
    if (!(capsPrice > 0) || !(capsPrice < 1)) return { ok: false, error: 'price-required' }
    const minTicket = mode === 'limit' ? 1 : Math.max(1, 5 * capsPrice)
    if (mode === 'limit' && shareCount + 1e-9 < 5) {
      return { ok: false, error: 'below-min-size', minShares: 5 }
    }
    if (notional + 1e-9 < minTicket) {
      return { ok: false, error: 'below-min-size', minUsd: Number(minTicket.toFixed(2)) }
    }
    const spend = spendToday()
    const pending = pendingNotional()
    if (spend + pending + notional > caps.dailyUsd + 1e-9) {
      return { ok: false, error: 'daily-cap', spentToday: spend, pending, dailyUsd: caps.dailyUsd }
    }
    const record = {
      id: `ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'BUY',
      orderType: mode,
      at: new Date().toISOString(),
      tokenId: String(tokenId),
      title: String(title ?? ''),
      label: String(label ?? ''),
      outcome: outcome === 'YES' ? 'YES' : outcome === 'NO' ? 'NO' : 'SIDE',
      price: mode === 'limit' ? limitPrice : capsPrice,
      shares: mode === 'limit' ? shareCount : null,
      filledShares: 0,
      notional,
      status: 'pending',
      ok: false,
    }
    pushRecord(record)
    const task =
      mode === 'limit'
        ? () => bridge.buyLimit({ tokenId: String(tokenId), price: limitPrice, shares: shareCount })
        : () =>
            bridge.buy({ tokenId: String(tokenId), amountUsd: notional, maxPrice: capsPrice })
    runOrder(record, task).catch((error) =>
      ctx.logger?.warn?.(`polymarket-agent buy failed: ${shortError(error)}`),
    )
    return { ok: true, pending: true, record }
  }

  /**
   * Cancel one resting limit order. The venue is the source of truth: if the
   * order filled while the panel was looking at it, a failed cancel refreshes
   * the record instead of pretending it was canceled.
   */
  async function cancelBuy(orderId) {
    await load()
    const id = String(orderId ?? '').trim()
    if (!id) return { ok: false, error: 'order-id-required' }
    const record = state.orders.find((order) => String(order.orderId ?? '') === id)
    if (!record) return { ok: false, error: 'order-not-found' }
    if (record.status !== 'open') return { ok: false, error: 'order-not-open' }
    let result
    try {
      result = await bridge.cancel({ orderId: id })
    } catch (error) {
      return { ok: false, error: shortError(error) }
    }
    if (!result.ok) {
      const info = await bridge.orderInfo({ orderId: id })
      if (info?.ok) applyOrderInfo(record, info)
      markDirty()
      return { ok: false, error: result.error ?? 'cancel-rejected', record }
    }
    record.status = 'canceled'
    record.canceledAt = new Date().toISOString()
    record.finishedAt = record.canceledAt
    record.ok = true
    markDirty()
    return { ok: true, record }
  }

  /**
   * Queue a SELL that closes (part of) a position. `shares` is validated
   * against the wallet's current holdings so a stale panel cannot oversell.
   */
  async function placeClose({ tokenId, shares }) {
    await load()
    const status = await liveStatus()
    if (!status.ready) return { ok: false, error: status.reason ?? 'bridge-missing', detail: status.error }
    let amount = num(shares)
    if (amount <= 0) return { ok: false, error: 'shares-required' }
    const snapshot = await portfolio(true)
    const holding = snapshot.positions.find((position) => position.tokenId === String(tokenId))
    if (!holding) return { ok: false, error: 'position-missing' }
    if (holding.redeemable) return { ok: false, error: 'position-redeemable' }
    if (amount > holding.size + 1e-6) amount = holding.size
    const record = {
      id: `ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'SELL',
      at: new Date().toISOString(),
      tokenId: String(tokenId),
      title: holding.title,
      label: holding.outcome,
      outcome: 'SELL',
      price: holding.currentPrice,
      shares: Number(amount.toFixed(4)),
      notional: Number((amount * holding.currentPrice).toFixed(4)),
      status: 'pending',
      ok: false,
    }
    pushRecord(record)
    runOrder(record, () => bridge.sell({ tokenId: String(tokenId), shares: amount })).catch((error) =>
      ctx.logger?.warn?.(`polymarket-agent close failed: ${shortError(error)}`),
    )
    return { ok: true, pending: true, record }
  }

  // ----------------------------------------------------------------- market

  /**
   * Fetch one event's Gamma document by event slug/id, falling back to a market
   * slug/id (a `/market/...` link) and then walking to the market's event.
   */
  async function eventDocument({ id, slug }) {
    const wanted = String(slug ?? '').trim()
    const wantedId = String(id ?? '').trim()
    const attempts = []
    if (wanted) attempts.push(() => gamma(`/events/slug/${encodeURIComponent(wanted)}?locale=${marketLocale()}`))
    if (wantedId) attempts.push(() => gamma(`/events/${encodeURIComponent(wantedId)}?locale=${marketLocale()}`))
    for (const attempt of attempts) {
      try {
        const raw = await attempt()
        if (raw?.id) return { raw, marketSlug: '' }
      } catch {
        // try the next shape
      }
    }
    const marketAttempts = []
    if (wanted) marketAttempts.push(() => gamma(`/markets/slug/${encodeURIComponent(wanted)}?locale=${marketLocale()}`))
    if (wantedId) marketAttempts.push(() => gamma(`/markets/${encodeURIComponent(wantedId)}?locale=${marketLocale()}`))
    for (const attempt of marketAttempts) {
      try {
        const market = await attempt()
        const parent = (market?.events ?? []).find((row) => row?.id)
        if (!parent?.id) continue
        // The event embedded in a market carries no tags and no sibling
        // markets, so read the full event document when it still exists.
        try {
          const full = await gamma(`/events/${encodeURIComponent(parent.id)}?locale=${marketLocale()}`)
          if (full?.id) return { raw: full, marketSlug: String(market.slug ?? '') }
        } catch {
          // keep the embedded copy
        }
        return { raw: parent, marketSlug: String(market.slug ?? '') }
      } catch {
        // not a market either
      }
    }
    return { raw: null, marketSlug: '' }
  }

  /**
   * Resolve a pasted Polymarket link straight from Gamma, so the panel can show
   * an event the radar sweep left out: below the volume floor, past `maxDays`,
   * outside the top pages, or already closed.
   */
  async function resolveLookup({ url, slug, id }) {
    const text = String(url ?? '').trim()
    const target =
      parsePolymarketLink(text) ??
      (String(slug ?? '').trim() ? { slug: String(slug).trim(), id: '' } : null) ??
      (String(id ?? '').trim() ? { slug: '', id: String(id).trim() } : null)
    if (!target) return { found: false, error: 'link-required' }
    const { raw, marketSlug } = await eventDocument(target)
    if (!raw?.id) return { found: false, error: 'event-not-found', input: text }
    const now = Date.now()
    const marketRows = (raw.markets ?? [])
      .map((market) => normalizeMarket(market, raw, now, { strict: false }))
      .filter(Boolean)
    const event = summarizeEvent(raw, marketRows, now)
    // Membership of the sweep the panel already shows, not a fresh one.
    let inRadar = false
    try {
      const scan = await getScan(false)
      inRadar = scan.events.some((row) => row.slug === event.slug || row.id === event.id)
    } catch {
      inRadar = false
    }
    return {
      found: true,
      kind: marketSlug ? 'market' : 'event',
      marketSlug,
      inRadar,
      closed: Boolean(raw.closed) || raw.active === false,
      event,
      link: event.slug ? `https://polymarket.com/event/${event.slug}?via=${encodeURIComponent(clientVia())}` : '',
      at: new Date(now).toISOString(),
    }
  }

  async function eventDetail({ id, slug }) {
    const scan = await getScan(false)
    const wanted = String(slug ?? '')
    const wantedId = String(id ?? '')
    let summary = scan.events.find(
      (event) => (wanted && event.slug === wanted) || (wantedId && event.id === wantedId),
    )
    // Open the event from its own Gamma document: it carries the current
    // English rules and every market, including ones outside the sweep window.
    const { raw, marketSlug } = await eventDocument({ id: wantedId, slug: wanted })
    let marketRows = []
    if (raw?.id) {
      marketRows = (raw.markets ?? [])
        .map((market) => normalizeMarket(market, raw, Date.now(), { withText: true, strict: false }))
        .filter(Boolean)
      if (!summary) summary = summarizeEvent(raw, marketRows, Date.now())
    }
    if (!marketRows.length && summary) {
      marketRows = scan.markets.filter((market) => market.eventId === summary.id)
    }
    if (!summary && !marketRows.length) return null
    const rules = String(raw?.description ?? '')
    const resolutionSource = String(raw?.resolutionSource ?? '')
    // The event description usually repeats the market description; send it
    // once instead of once per outcome.
    for (const market of marketRows) {
      if (market.rules && rules && market.rules.trim() === rules.trim()) market.rules = ''
    }
    let background = ''
    try {
      const insights = await fetchJson(`${GAMMA}/events/${encodeURIComponent(summary.id)}/insights`, 8_000)
      background = String(insights?.context?.description ?? '').trim()
    } catch {
      background = ''
    }
    return {
      event: {
        ...summary,
        description: rules,
        resolutionSource,
        marketCount: marketRows.length,
      },
      markets: marketRows,
      marketSlug,
      background,
      rules,
      link: summary.slug ? `https://polymarket.com/event/${summary.slug}?via=${encodeURIComponent(clientVia())}` : '',
      via: clientVia(),
    }
  }

  async function orderBook(tokenId) {
    const value = String(tokenId ?? '').trim()
    if (!/^\d+$/.test(value)) throw new Error('invalid-token')
    const book = await fetchJson(`${CLOB}/book?token_id=${encodeURIComponent(value)}`, 10_000)
    const bids = (book?.bids ?? [])
      .map((row) => ({ price: num(row.price), size: num(row.size) }))
      .filter((row) => row.price > 0 && row.size > 0)
      .sort((a, b) => b.price - a.price)
      .slice(0, 12)
    const asks = (book?.asks ?? [])
      .map((row) => ({ price: num(row.price), size: num(row.size) }))
      .filter((row) => row.price > 0 && row.size > 0)
      .sort((a, b) => a.price - b.price)
      .slice(0, 12)
    return {
      tokenId: value,
      bids,
      asks,
      bestBid: bids[0]?.price ?? null,
      bestAsk: asks[0]?.price ?? null,
      tickSize: Number(book?.tick_size) > 0 ? Number(book.tick_size) : 0.01,
      minOrderSize: Number(book?.min_order_size) > 0 ? Number(book.min_order_size) : 5,
      at: new Date().toISOString(),
    }
  }

  // ------------------------------------------------------------------ state

  function publicSettings() {
    return { ...state.settings }
  }

  async function snapshot(force) {
    const scan = await getScan(force)
    return {
      generatedAt: scan.generatedAt,
      elapsedMs: scan.elapsedMs,
      errors: scan.errors,
      counts: scan.counts,
      rawEvents: scan.rawEvents,
      filter: scan.filter ?? filterView(),
      events: scan.events,
      sweep: { ...sweeper, nextAt: sweeper.running ? null : sweeper.nextAt },
      portfolio: await portfolio(false),
      live: await liveStatus(),
      onboarding: await onboardingView(),
      settings: publicSettings(),
      via: clientVia(),
    }
  }

  // -------------------------------------------------------------- onboarding

  async function onboardingView() {
    const described = await bridge.describe()
    const configured = described.configured
    return {
      done: Boolean(configured.key && configured.wallet) || Boolean(state.onboarding?.skipped),
      skipped: Boolean(state.onboarding?.skipped),
      configured,
      sources: described.sources,
      wallet: described.wallet,
      relayerAddress: described.relayerAddress ?? null,
      depositAddress: described.depositAddress ?? null,
      via: clientVia(),
    }
  }

  function isLoopback(req) {
    const address = req.socket?.remoteAddress ?? ''
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  async function finishOnboarding(payload) {
    await load()
    const action = String(payload?.action ?? 'finish')
    if (payload?.caps && typeof payload.caps === 'object') await updateSettings({ caps: payload.caps })
    if (action === 'reopen') {
      state.onboarding = { done: false, skipped: false, completedAt: null }
    } else if (action === 'skip') {
      state.onboarding = { done: true, skipped: true, completedAt: new Date().toISOString() }
    } else {
      const view = await onboardingView()
      if (!view.configured.key || !view.configured.wallet) return { ok: false, error: 'onboarding-incomplete' }
      state.onboarding = { done: true, skipped: false, completedAt: new Date().toISOString() }
    }
    markDirty()
    return { ok: true, onboarding: await onboardingView() }
  }

  const ASSET_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  }

  function sniffImage(body) {
    if (body[0] === 0xff && body[1] === 0xd8) return 'image/jpeg'
    if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) return 'image/png'
    if (body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    if (body.subarray(0, 5).toString('ascii').trimStart().startsWith('<')) return 'image/svg+xml'
    return undefined
  }

  async function sendAsset(res, name) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) return send(res, 404, { ok: false, error: 'not-found' })
    if (!ASSET_TYPES[path.extname(name).toLowerCase()]) return send(res, 404, { ok: false, error: 'not-found' })
    try {
      const body = await readFile(path.join(ASSETS_DIR, name))
      const type = sniffImage(body) ?? ASSET_TYPES[path.extname(name).toLowerCase()]
      res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=3600', 'content-length': body.length })
      res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('asset-missing')
    }
  }

  // ------------------------------------------------------------------ routes

  function send(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 256 * 1024) throw new Error('body-too-large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return {}
    }
  }

  async function handle(req, res) {
    try {
      // Every panel call runs through DSH's own connection admission: Host and
      // Origin checks plus the signed browser credential. A web page open in
      // the browser therefore cannot drive the trading routes.
      const rejection = ctx.connection?.requestRejection?.(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('connection-rejected')
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.slice(API_PREFIX.length) || '/'
      const method = (req.method ?? 'GET').toUpperCase()

      if (method === 'GET' && (route === '/' || route === '/markets' || route === '/scan')) {
        await load()
        const scan = await getScan(url.searchParams.get('refresh') === '1')
        return send(res, 200, {
          generatedAt: scan.generatedAt,
          locale: scan.locale ?? marketLocale(),
          elapsedMs: scan.elapsedMs,
          errors: scan.errors,
          counts: scan.counts,
          rawEvents: scan.rawEvents,
          filter: scan.filter ?? filterView(),
          events: scan.events,
          sweep: { ...sweeper, nextAt: sweeper.running ? null : sweeper.nextAt },
          settings: publicSettings(),
          via: clientVia(),
        })
      }
      if (method === 'GET' && route === '/state') {
        await load()
        await loadKeywordFilter()
        return send(res, 200, {
          sweep: { ...sweeper, nextAt: sweeper.running ? null : sweeper.nextAt },
          live: await liveStatus(),
          portfolio: await portfolio(false),
          onboarding: await onboardingView(),
          filter: filterView(),
          settings: publicSettings(),
          via: clientVia(),
          deposit: await depositInfo({ discover: false }),
        })
      }
      if (method === 'GET' && route === '/portfolio') {
        await load()
        return send(res, 200, { ...(await portfolio(url.searchParams.get('refresh') === '1')), live: await liveStatus() })
      }
      if (method === 'GET' && route === '/positions') {
        await load()
        const snapshotValue = await portfolio(url.searchParams.get('refresh') === '1')
        return send(res, 200, {
          positions: snapshotValue.positions,
          history: snapshotValue.history,
          value: snapshotValue.value,
          cash: snapshotValue.cash,
          total: snapshotValue.total,
          wallet: snapshotValue.wallet,
          stale: snapshotValue.stale,
          errors: snapshotValue.errors,
          at: snapshotValue.at,
        })
      }
      if (method === 'GET' && (route === '/event' || route === '/market')) {
        const detail = await eventDetail({
          id: url.searchParams.get('id'),
          slug: url.searchParams.get('slug'),
        })
        if (!detail) return send(res, 404, { ok: false, error: 'event-not-found' })
        return send(res, 200, detail)
      }
      if (method === 'GET' && (route === '/resolve' || route === '/lookup')) {
        const found = await resolveLookup({
          url: url.searchParams.get('url'),
          slug: url.searchParams.get('slug'),
          id: url.searchParams.get('id'),
        })
        return send(res, found.found ? 200 : found.error === 'event-not-found' ? 404 : 400, found)
      }
      if (method === 'GET' && route === '/book') {
        return send(res, 200, await orderBook(url.searchParams.get('tokenId')))
      }
      if (method === 'GET' && route === '/deposit') {
        await load()
        return send(res, 200, await depositInfo({ refresh: url.searchParams.get('refresh') === '1', qr: true }))
      }
      if (method === 'POST' && route === '/deposit/address') {
        if (!isLoopback(req)) return send(res, 403, { ok: false, error: 'loopback-only' })
        const body = await readBody(req)
        const result = await saveDepositAddress(body?.address)
        if (!result.ok) return send(res, 400, result)
        return send(res, 200, result)
      }
      if (method === 'GET' && route === '/live') {
        await load()
        return send(res, 200, await liveStatus())
      }
      if (method === 'GET' && route === '/onboarding') {
        await load()
        // The panel's "刷新状态" button sends `?refresh=1`: bypass the 30 s
        // status cache so one click really re-probes the account.
        const force = url.searchParams.get('refresh') === '1'
        return send(res, 200, { ...(await onboardingView()), live: await liveStatus(force), caps: tradingLimits() })
      }
      if (method === 'POST' && route === '/onboarding') {
        if (!isLoopback(req)) return send(res, 403, { ok: false, error: 'loopback-only' })
        return send(res, 200, await finishOnboarding(await readBody(req)))
      }
      if (method === 'POST' && route === '/credentials') {
        if (!isLoopback(req)) return send(res, 403, { ok: false, error: 'loopback-only' })
        try {
          const body = await readBody(req)
          const result = await bridge.setCredentials({
            ...(body.privateKey ? { privateKey: body.privateKey } : {}),
            ...(body.wallet ? { wallet: body.wallet } : {}),
            ...(body.relayerKey ? { relayerKey: body.relayerKey } : {}),
            ...(body.relayerAddress ? { relayerAddress: body.relayerAddress } : {}),
          })
          quoteCache = { key: '', at: 0, value: null }
          return send(res, 200, { ...result, onboarding: await onboardingView(), live: await liveStatus(true) })
        } catch (error) {
          return send(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && route === '/credentials/clear') {
        if (!isLoopback(req)) return send(res, 403, { ok: false, error: 'loopback-only' })
        await bridge.clearCredentials()
        quoteCache = { key: '', at: 0, value: null }
        markDirty()
        return send(res, 200, { ok: true, onboarding: await onboardingView(), live: await liveStatus(true) })
      }
      if (method === 'POST' && route === '/logout') {
        if (!isLoopback(req)) return send(res, 403, { ok: false, error: 'loopback-only' })
        return send(res, 200, await logout())
      }
      if (method === 'GET' && route === '/approve/status') {
        // Polled by the panel while a run is in flight; cheap and read-only.
        return send(res, 200, { run: approvalRun })
      }
      if (method === 'POST' && route === '/approve') {
        if (!isLoopback(req)) return send(res, 403, { ok: false, error: 'loopback-only' })
        if (approvalRun?.running) return send(res, 409, { ok: false, error: 'approval-running', run: approvalRun })
        startApprovalRun()
        let result
        try {
          result = await bridge.approveAll({ onProgress: recordApproval })
        } catch (error) {
          result = { ok: false, stage: 'approve', error: shortError(error) }
        } finally {
          finishApprovalRun(result)
        }
        return send(res, 200, { ...result, run: approvalRun, live: await liveStatus(true) })
      }
      if (method === 'POST' && route === '/order') {
        const body = await readBody(req)
        const result = await placeBuy({
          tokenId: String(body.tokenId ?? ''),
          orderType: body.orderType === 'limit' ? 'limit' : 'market',
          amountUsd: body.amountUsd,
          maxPrice: body.maxPrice,
          price: body.price,
          shares: body.shares,
          title: body.title,
          outcome: body.outcome,
          label: body.label,
        })
        return send(res, 200, result)
      }
      if (method === 'POST' && route === '/cancel') {
        if (!isLoopback(req)) return send(res, 403, { ok: false, error: 'loopback-only' })
        const body = await readBody(req)
        return send(res, 200, await cancelBuy(body.orderId))
      }
      if (method === 'POST' && route === '/close') {
        const body = await readBody(req)
        return send(res, 200, await placeClose({ tokenId: String(body.tokenId ?? ''), shares: body.shares }))
      }
      if (method === 'POST' && route === '/locale') {
        const body = await readBody(req)
        return send(res, 200, { ok: true, ...(await setMarketLocale(body?.locale)) })
      }
      if (method === 'POST' && route === '/settings') {
        const patch = await readBody(req)
        return send(res, 200, { ok: true, settings: await updateSettings(patch) })
      }
      if (method === 'GET' && route.startsWith('/asset/')) {
        return sendAsset(res, decodeURIComponent(route.slice('/asset/'.length)))
      }
      return send(res, 404, { ok: false, error: 'not-found', route })
    } catch (error) {
      return send(res, 500, { ok: false, error: shortError(error) })
    }
  }

  let qrModule
  async function addressQr(text) {
    try {
      qrModule ??= import('qrcode-generator')
      const module = await qrModule
      const qrcode = module.default ?? module
      const qr = qrcode(0, 'M')
      qr.addData(text)
      qr.make()
      const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
      return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    } catch (error) {
      ctx.logger?.warn?.(`polymarket-agent: cannot render deposit QR: ${shortError(error)}`)
      return null
    }
  }

  async function depositInfo(options = {}) {
    // `describe()` reads only the DSH credentials store; it does not call the
    // CLOB. Full `status()` is only needed when a brand-new Deposit Wallet
    // account has no address yet.
    const described = await bridge.describe()
    let wallet = described.wallet ?? null
    let walletType = null
    const savedAddress = isEvmAddress(described.depositAddress)
      ? described.depositAddress.toLowerCase()
      : null

    // A manual address wins. Otherwise recover the address from public chain
    // data. `discoverDepositAddress` has a short in-memory TTL; the result is
    // never written to disk.
    const shouldDiscover = !savedAddress && options.discover !== false && Boolean(wallet)
    const discovered = shouldDiscover
      ? await discoverDepositAddress(wallet, { refresh: Boolean(options.refresh) })
      : null
    let sourceBridge = null
    if (discovered) {
      const cacheKey = `${discovered.txHash ?? discovered.address}:${discovered.amount ?? ''}`
      if (!options.refresh && depositBridgeCache.has(cacheKey)) {
        sourceBridge = depositBridgeCache.get(cacheKey)
      } else {
        try {
          sourceBridge = await detectSourceChain(discovered.address, discovered)
        } catch (error) {
          ctx.logger?.warn?.(`polymarket-agent: source-chain scan failed: ${shortError(error)}`)
        }
        if (depositBridgeCache.size > 32) depositBridgeCache.clear()
        depositBridgeCache.set(cacheKey, sourceBridge)
      }
    }
    const auto = discovered
    let accountDeposit = null
    if (!savedAddress && !auto && wallet) {
      const status = await bridge.status(false)
      wallet = status.wallet ?? wallet
      walletType = status.walletType ?? null
      // A Deposit Wallet account *is* its own deposit address.
      if (walletType === 'DEPOSIT_WALLET') accountDeposit = wallet
    }
    const address = savedAddress ?? auto?.address ?? accountDeposit ?? null
    const source = savedAddress ? 'manual' : auto ? 'history' : accountDeposit ? 'wallet' : null
    const evidence =
      savedAddress || !auto
        ? null
        : {
            txHash: auto.txHash ?? null,
            at: auto.at ?? null,
            amount: auto.amount ?? null,
            asset: auto.asset ?? null,
            network: auto.network ?? 'Polygon',
            chainId: auto.chainId ?? 137,
            bridge: sourceBridge,
          }

    const info = {
      address,
      source,
      savedAddress,
      wallet,
      walletType,
      evidence,
      explorer: address ? `https://polygonscan.com/address/${address}` : '',
      qr: null,
      at: new Date().toISOString(),
    }
    if (address && options.qr) info.qr = await addressQr(address)
    return info
  }

  /** Store the address copied from polymarket.com (or clear it). */
  async function saveDepositAddress(rawAddress) {
    const raw = String(rawAddress ?? '').trim()
    if (!raw) {
      await bridge.setCredentials({ depositAddress: null })
      return { ok: true, deposit: await depositInfo({ qr: true }) }
    }
    if (!isEvmAddress(raw)) return { ok: false, error: 'invalid-address' }
    const address = raw.toLowerCase()
    if (
      /^0x0{40}$/.test(address) ||
      address === PUSD_ADDRESS.toLowerCase() ||
      address === USDCE_ADDRESS.toLowerCase() ||
      address === ONRAMP_ADDRESS.toLowerCase()
    ) {
      return { ok: false, error: 'invalid-address' }
    }
    await bridge.setCredentials({ depositAddress: address })
    const wallet = await walletAddress(false)
    return {
      ok: true,
      warning: wallet && wallet.toLowerCase() === address ? 'same-as-wallet' : null,
      deposit: await depositInfo({ qr: true }),
    }
  }

  /**
   * Log out: remove every credential and every local account record, then
   * return to setup. Public Polymarket data (positions, orders, on-chain
   * history) is not touched and cannot be deleted from here.
   */
  async function logout() {
    await load()
    await bridge.clearCredentials()
    state.orders = []
    state.onboarding = { done: false, skipped: false, completedAt: null }
    state.spend = { date: today(), usd: 0 }
    state.firstSeen = {}
    state.bootstrapped = false
    quoteCache = { key: '', at: 0, value: null }
    depositBridgeCache.clear()
    depositDiscoveryCache.clear()
    // Persist immediately: a logout that only lives in memory would reappear
    // after a restart, and a failed write must reach the caller.
    await persistNow()
    return { ok: true, onboarding: await onboardingView(), live: await liveStatus(true) }
  }

  async function updateSettings(patch) {
    await load()
    const next = { ...state.settings }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (patch?.[key] !== undefined && key !== 'caps') next[key] = patch[key]
    }
    if (next.refreshSeconds !== undefined) next.refreshSeconds = clamp(Math.round(num(next.refreshSeconds) || 1800), 60, 86_400)
    if (next.pages !== undefined) next.pages = clamp(Math.round(num(next.pages) || 6), 1, 8)
    if (next.minVolume24h !== undefined) next.minVolume24h = Math.max(0, num(next.minVolume24h))
    if (next.maxDays !== undefined) next.maxDays = clamp(Math.round(num(next.maxDays) || 365), 1, 3650)
    if (next.marketLocale !== undefined) next.marketLocale = next.marketLocale === 'zh' ? 'zh' : 'en'
    if (patch?.caps && typeof patch.caps === 'object') {
      const caps = patch.caps
      next.caps = {
        maxOrderUsd: clamp(num(caps.maxOrderUsd) || 25, 1, 100_000),
        dailyUsd: clamp(num(caps.dailyUsd) || 100, 1, 1_000_000),
      }
    }
    state.settings = next
    Object.assign(settings, next)
    markDirty()
    if (pollTimer) scheduleSweep()
    return publicSettings()
  }

  /**
   * The panel calls this with the DeepSeek Harness UI language on every mount
   * and locale switch. A change invalidates the cached radar so the list
   * reloads with Polymarket titles in the same language; the sweep itself is
   * left to the caller's next request (which forces one).
   */
  async function setMarketLocale(locale) {
    await load()
    panelLocaleReported = true
    const next = locale === 'zh' ? 'zh' : 'en'
    if (marketLocale() === next) return { changed: false, locale: next }
    settings.marketLocale = next
    state.settings = { ...state.settings, marketLocale: next }
    markDirty()
    return { changed: true, locale: next }
  }

  // ------------------------------------------------------------------- tools

  function toolResult() {
    return {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, result) => [{ type: 'text', text: String(result?.text ?? '') }],
    }
  }

  const marketsTool = {
    name: 'polymarket_markets',
    description:
      'List Polymarket events detected by the auto-radar, ranked by 24h volume and classified by category. ' +
      "Titles, questions and outcome labels follow the panel language: English by default, or Polymarket's " +
      'Chinese locale when the DeepSeek Harness interface is Chinese; rules stay in English. ' +
      'Events matching the keyword filter file are omitted. ' +
      'Pass a polymarket.com event or market link as `url` to open that event directly, even when the radar does not ' +
      'list it (low volume, further than the radar horizon, outside the swept pages, or closed). Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring filter on the localized title, question or tag.',
        },
        category: {
          type: 'string',
          description:
            'Only return one category: politics, sports, crypto, economy, tech, culture, world, weather, elections, ' +
            'other. Chinese labels are accepted too (政治, 体育, 加密, 经济, 科技, 文化, 国际, 天气, 选举, 其他).',
        },
        url: {
          type: 'string',
          description:
            'A polymarket.com event or market link, or an event slug. Returns that event with its outcomes instead of ' +
            'the radar list; combine with no other filter.',
        },
        limit: { type: 'number', description: 'Maximum radar rows to return (default 15, max 50).' },
        refresh: { type: 'boolean', description: 'Force a fresh Gamma sweep instead of using the cache.' },
      },
    },
    output: toolResult(),
    async execute(args) {
      if (String(args?.url ?? '').trim()) {
        const raw = String(args.url).trim()
        // Accept a link, a bare event slug, or a numeric event id.
        const found = await resolveLookup({ url: raw, slug: raw, id: /^\d+$/.test(raw) ? raw : '' })
        if (!found.found) {
          return {
            text:
              found.error === 'link-required'
                ? 'That is not a Polymarket event or market link. Pass a URL such as https://polymarket.com/event/<slug>.'
                : `Polymarket has no event or market at ${String(args.url).trim()} (it may be delisted or the link is wrong).`,
          }
        }
        const { event } = found
        const where = found.inRadar
          ? 'already in the radar list'
          : found.closed
            ? 'closed — outside the radar list'
            : 'not in the radar list'
        const lines = (event.top ?? [])
          .slice(0, 8)
          .map((market) => `- ${market.groupLabel || market.question}: ${market.sides.map((side) => `${side.label} ${(side.price * 100).toFixed(1)}¢`).join(' / ')}`)
        return {
          text:
            `Polymarket Proxy · link lookup · ${where}\n` +
            `${event.title} [${event.category} ${categoryLabel(event.category, marketLocale())}] (${event.marketCount} markets)\n` +
            `ends ${String(event.endDate).slice(0, 10)} · 24h $${Math.round(event.volume24h).toLocaleString('en-US')} · ` +
            `liquidity $${Math.round(event.liquidity).toLocaleString('en-US')}\n` +
            (lines.length ? `${lines.join('\n')}\n` : '') +
            (found.link ? `${found.link}\n` : ''),
        }
      }
      const scan = await getScan(Boolean(args?.refresh))
      const query = String(args?.query ?? '').trim().toLowerCase()
      const category = normalizeCategory(args?.category)
      if (String(args?.category ?? '').trim() && !category) {
        return { text: `Unknown category "${args.category}". Use one of: ${CATEGORY_ORDER.join(', ')}.` }
      }
      const limit = clamp(Math.round(num(args?.limit) || 15), 1, 50)
      const rows = scan.events
        .filter((event) => !category || event.category === category)
        .filter((event) => !query || event.keywords.includes(query) || event.title.toLowerCase().includes(query))
        .slice(0, limit)
      const categoryLine = CATEGORY_ORDER.map((key) => {
        const count = scan.events.filter((event) => event.category === key).length
        return count ? `${key} ${count}` : ''
      })
        .filter(Boolean)
        .join(' · ')
      if (rows.length === 0) {
        return {
          text:
            `No markets matched${category ? ` in ${category}` : ''}${query ? ` for "${args.query}"` : ''}. ` +
            `Categories: ${categoryLine}.`,
        }
      }
      const lines = rows.map((event, index) => {
        const preview = (event.top ?? [])
          .slice(0, 3)
          .map((market) => `${market.groupLabel || market.question}: ${market.sides.map((side) => `${side.label} ${(side.price * 100).toFixed(1)}¢`).join(' / ')}`)
          .join(' · ')
        return (
          `${index + 1}. ${event.title} [${event.category}] (${event.marketCount} markets)\n` +
          `   ${preview}\n` +
          `   ends ${String(event.endDate).slice(0, 10)} · 24h $${Math.round(event.volume24h).toLocaleString('en-US')}` +
          (event.slug
            ? `\n   https://polymarket.com/event/${event.slug}?via=${encodeURIComponent(clientVia())}`
            : '')
        )
      })
      return {
        text:
          `Polymarket Proxy · ${scan.counts.events} events / ${scan.counts.markets} markets · ${scan.generatedAt}\n` +
          `categories · ${categoryLine}\n\n` +
          lines.join('\n'),
      }
    },
  }

  const portfolioTool = {
    name: 'polymarket_portfolio',
    description:
      'Show the Polymarket portfolio for the configured wallet: total value, cash, open positions and recent ' +
      'activity. Read-only — placing and closing orders stays with the user in the panel.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: toolResult(),
    async execute() {
      const snapshotValue = await portfolio(true)
      const status = await liveStatus()
      const deposit = await depositInfo()
      const head =
        `Portfolio ${snapshotValue.configured ? '' : '(not configured) '}` +
        `total ${snapshotValue.total === null ? '—' : `$${snapshotValue.total.toFixed(2)}`} · ` +
        `positions ${snapshotValue.value === null ? '—' : `$${snapshotValue.value.toFixed(2)}`} · ` +
        `cash ${snapshotValue.cash === null ? '—' : `$${snapshotValue.cash.toFixed(2)}`}` +
        (snapshotValue.wallet ? ` · ${shortAddress(snapshotValue.wallet)}` : '')
      const depositSource =
        deposit.source === 'history'
          ? 'recovered from deposit history'
          : deposit.source === 'wallet'
            ? 'account wallet'
            : 'manual'
      const depositAsset = deposit.evidence?.asset ? ` · ${deposit.evidence.asset}` : ''
      const depositLine = deposit.address
        ? `deposit ${shortAddress(deposit.address)} (${depositSource})${depositAsset}`
        : 'deposit address not identified — open the panel Deposit modal and paste the address from the web Deposit modal once'
      const positionLines = snapshotValue.positions
        .slice(0, 15)
        .map(
          (position) =>
            `- ${position.title} [${position.outcome}] ${position.size.toFixed(2)} sh @ ${(
              position.currentPrice * 100
            ).toFixed(1)}¢ = $${position.currentValue.toFixed(2)} (${position.percentPnl.toFixed(1)}%)`,
        )
      const statusLine =
        `trading ${status.ready ? 'ready' : `not ready (${status.reason ?? 'unknown'})`} · ` +
        `caps $${status.limits.maxOrderUsd}/order · $${status.limits.dailyUsd}/day`
      return {
        text: `${head}\n${depositLine}\n${statusLine}\n\n${positionLines.length ? positionLines.join('\n') : 'No open positions.'}`,
      }
    },
  }

  // --------------------------------------------------------------- lifecycle

  function start() {
    load()
    ctx.effect(() => ctx.tools.register(marketsTool), 'polymarket-agent markets tool')
    ctx.effect(() => ctx.tools.register(portfolioTool), 'polymarket-agent portfolio tool')
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handle }),
      'polymarket-agent routes',
    )
    ctx.effect(() => {
      const warm = setTimeout(async () => {
        await load()
        await applyHostLocalePreference()
        refresh()
          .catch((error) => ctx.logger?.warn?.(`polymarket-agent warm sweep failed: ${shortError(error)}`))
          .finally(() => scheduleSweep())
      }, 4_000)
      warm.unref?.()
      scheduleSweep()
      return () => {
        clearTimeout(warm)
        if (pollTimer) clearTimeout(pollTimer)
        pollTimer = undefined
        if (saveTimer) clearTimeout(saveTimer)
      }
    }, 'polymarket-agent poller')
  }

  return {
    start,
    snapshot,
    getScan,
    portfolio,
    placeBuy,
    cancelBuy,
    placeClose,
    liveStatus,
    updateSettings,
    onboardingView,
    eventDetail,
    depositInfo,
    saveDepositAddress,
    logout,
  }
}

export function apply(ctx, config) {
  createRuntime(ctx, config ?? {}).start()
}

// Exported for unit tests; not part of the plugin's public runtime surface.
export {
  isEvmAddress,
  topicAddress,
  depositTransferFromReceipt,
  detectSourceChain,
  discoverDepositAddress,
  parseKeywordConfig,
  eventMatchesKeywords,
  keywordSourceOf,
}
