/**
 * Host half of the dsh-notify bundle.
 *
 * Plays a Windows sound when DSH needs the user or finishes work:
 *   - `approval/request` and `user-questions/request` → the attention sound;
 *   - `agent/status` running → idle on a main session → the done sound.
 *
 * The sound is played by this process, not by the page. The DSH Host runs
 * natively on the machine, so the alert is audible while the page sits in the
 * background, another account is in front, or the browser tab is muted —
 * which is exactly the case this plugin exists for.
 *
 * The settings page (client.js) reads and writes the JSON below through the
 * `/notify` RPC channel, whose endpoints are `get`, `set` and `preview`.
 *
 * Design notes:
 *   - The two request hooks are waterfalls: a listener that does not own the
 *     decision must return `next()`. This plugin only observes, so its own
 *     work is wrapped in try/catch and `next()` is called exactly once from
 *     outside it — a failing sound can never break the approval path.
 *   - Playback is a detached, hidden PowerShell one-shot, so the plugin needs
 *     no dependency, no build step and no visible window.
 *   - `connection` and `webServer` are injected rather than declared in
 *     `inject`, so the sound keeps working in a profile that carries no Web
 *     transport; see the channel comment near the end of `apply`.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-notify'

/** Directory holding the stock `.wav` files of this Windows installation. */
const MEDIA_DIR = `${process.env.SystemRoot ?? 'C:\\Windows'}\\Media`

/**
 * The one route the settings page talks to. It must live under `/api`, because
 * Connection's exact-route table is served by the `/api` prefix route — the
 * same mount that carries the Host/Origin fence and the browser cookie.
 */
const ROUTE_PATH = '/api/notify.config'

/** System-sound alias played when the configured `.wav` cannot be found. */
const FALLBACKS = { attention: 'Exclamation', done: 'Asterisk' }

/** Starting point; the live values are the config file the settings page edits. */
const DEFAULT_CONFIG = {
  enabled: true,
  attention: { sound: 'Windows Notify System Generic.wav' },
  done: { sound: 'Windows Ding.wav' },
  minGapMs: 1200,
  attentionSettleMs: 5000,
  muteDelegated: true,
}

/** Set true to trace every decision into the Host log. */
const DEBUG = false

/**
 * `powershell.exe` (Windows PowerShell 5.1) is used rather than `pwsh`: its
 * `System.Media.SoundPlayer` is present on every supported Windows install.
 */
const POWERSHELL = [
  `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
  'powershell.exe',
].find((candidate) => candidate === 'powershell.exe' || existsSync(candidate)) ?? 'powershell.exe'

/** The DSH home holding `storages/`, mirroring the other profile plugins. */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

const configPath = () => join(dshHome(), 'storages', 'dsh-notify.json')

const logPath = () => join(dshHome(), 'storages', 'dsh-notify.log')

/**
 * Append one line to the plugin's own log.
 *
 * Registering a Connection RPC channel is the one step here whose failure is
 * invisible: the Loader keeps the plugin `active` while the child context that
 * threw is simply dropped, and the page only ever sees the resulting HTTP 405.
 * One line per boot is cheap insurance against debugging that blind.
 */
function diagnose(message) {
  try {
    mkdirSync(dirname(logPath()), { recursive: true })
    appendFileSync(logPath(), `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* a blocked storage must never break the plugin */
  }
}

/** Keep one string field inside sane bounds. */
function soundOf(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 400) : fallback
}

/** Keep one numeric field inside sane bounds. */
function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Project arbitrary input onto the exact config shape, dropping anything else. */
function normalize(input) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    enabled: source.enabled !== false,
    attention: { sound: soundOf(source.attention?.sound, DEFAULT_CONFIG.attention.sound) },
    done: { sound: soundOf(source.done?.sound, DEFAULT_CONFIG.done.sound) },
    minGapMs: clampNumber(source.minGapMs, 0, 60000, DEFAULT_CONFIG.minGapMs),
    attentionSettleMs: clampNumber(
      source.attentionSettleMs,
      0,
      60000,
      DEFAULT_CONFIG.attentionSettleMs,
    ),
    muteDelegated: source.muteDelegated !== false,
  }
}

/** Read the file, falling back to the defaults for a missing or broken one. */
function loadConfig() {
  try {
    return normalize(JSON.parse(readFileSync(configPath(), 'utf8')))
  } catch {
    return normalize(DEFAULT_CONFIG)
  }
}

/** Write the config; a blocked storage never breaks the plugin. */
function saveConfig(config) {
  try {
    mkdirSync(dirname(configPath()), { recursive: true })
    writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`)
    return true
  } catch (error) {
    console.error('[dsh-notify] config write failed:', error)
    return false
  }
}

/**
 * The live config, cached briefly so a burst of events does not re-read the
 * file for each one while an external edit is still picked up promptly.
 */
let cachedConfig = null
let cachedAt = 0
function currentConfig() {
  const now = Date.now()
  if (!cachedConfig || now - cachedAt > 500) {
    cachedConfig = loadConfig()
    cachedAt = now
  }
  return cachedConfig
}

/** The stock `.wav` names this machine offers, for the settings list. */
function listSounds() {
  try {
    return readdirSync(MEDIA_DIR)
      .filter((name) => name.toLowerCase().endsWith('.wav'))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

/** A bare name resolves inside the Windows media directory; a path is used as given. */
function wavPath(sound) {
  if (!sound) return null
  if (/[\\/]/.test(sound) || sound.includes(':')) return sound
  return join(MEDIA_DIR, sound)
}

/**
 * Play one sound, fire and forget.
 *
 * The script is passed as `-EncodedCommand` (Base64 UTF-16LE) so no path,
 * quote or non-ASCII character is ever reinterpreted by a shell.
 * @param sound - `.wav` name or path, or undefined for the alias alone.
 * @param alias - `SystemSounds` member used when the file is missing.
 * @returns the resolved `.wav` path, for reporting.
 */
function play(sound, alias) {
  const target = wavPath(sound)
  const script = ["$ErrorActionPreference='SilentlyContinue'"]
  if (target) {
    script.push(`$wav='${target.replace(/'/g, "''")}'`)
    script.push(
      'if (Test-Path -LiteralPath $wav) { (New-Object System.Media.SoundPlayer -ArgumentList $wav).PlaySync(); exit 0 }',
    )
  }
  script.push(`[System.Media.SystemSounds]::${alias}.Play()`)
  // The alias plays asynchronously; stay alive long enough to be heard.
  script.push('Start-Sleep -Milliseconds 900')
  const encoded = Buffer.from(script.join('; '), 'utf16le').toString('base64')
  try {
    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { stdio: 'ignore', windowsHide: true },
    )
    child.on('error', () => {})
    child.unref()
  } catch {
    /* a missing shell must never break the notification path */
  }
  return target
}

/**
 * Answer one settings-page call.
 *
 * The page posts `{ endpoint, payload }` and reads one `{ ok, value }` or
 * `{ ok: false, error }` envelope back — the shape `connection.fetch`,
 * `connection.rpc` and every Remote in this Harness share.
 * @param endpoint - `get`, `set` or `preview`.
 * @param payload - endpoint-specific argument.
 * @returns the response envelope.
 */
async function handleEndpoint(endpoint, payload) {
  try {
    if (endpoint === 'get') {
      return {
        ok: true,
        value: {
          config: currentConfig(),
          sounds: listSounds(),
          mediaDir: MEDIA_DIR,
          configPath: configPath(),
        },
      }
    }

    if (endpoint === 'set') {
      const patch = payload && typeof payload === 'object' ? payload.patch : null
      const base = currentConfig()
      const merged = normalize({
        ...base,
        ...(patch && typeof patch === 'object' ? patch : {}),
        attention: { ...base.attention, ...(patch?.attention ?? {}) },
        done: { ...base.done, ...(patch?.done ?? {}) },
      })
      const saved = saveConfig(merged)
      cachedConfig = merged
      cachedAt = Date.now()
      return { ok: true, value: { config: merged, saved } }
    }

    if (endpoint === 'preview') {
      const requested = payload && typeof payload === 'object' ? payload.sound : null
      const target = wavPath(soundOf(requested, ''))
      const found = Boolean(target) && existsSync(target)
      // A preview is an explicit user action: it ignores `enabled` and the
      // throttle, and it never falls back, so the button reflects exactly the
      // file that was picked.
      if (found) play(requested, FALLBACKS.attention)
      return { ok: true, value: { path: target, exists: found } }
    }

    return {
      ok: false,
      error: { code: 'unknown-endpoint', message: `unknown endpoint: ${endpoint}`, details: {} },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: { code: 'internal', message, details: {} } }
  }
}

/**
 * Watch the Host's session and approval events and announce what matters.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  /** Session ids whose agent is running right now. */
  const running = new Set()
  /** Session ids owned by a subagent or an Agent Teams member, which stay silent. */
  const delegated = new Set()

  let lastSoundAt = 0
  let lastAttentionAt = 0

  const isDelegated = (sessionId) => typeof sessionId === 'string' && delegated.has(sessionId)

  /** Throttle and play one sound. */
  const announce = (kind, detail) => {
    try {
      const config = currentConfig()
      if (!config.enabled) return
      const now = Date.now()
      if (now - lastSoundAt < config.minGapMs) return
      lastSoundAt = now
      if (kind === 'attention') lastAttentionAt = now
      play(config[kind]?.sound, FALLBACKS[kind])
      if (DEBUG) console.log('[dsh-notify]', kind, detail ?? '')
    } catch {
      /* observation only */
    }
  }

  // Delegated sessions finish constantly; only what the user is watching earns
  // a sound. `origin`/`parentSessionId` are how the Host marks them.
  ctx.on('api-session/added', (summary) => {
    if (!summary || typeof summary.sessionId !== 'string') return
    if (summary.origin === 'subagent' || summary.parentSessionId) {
      delegated.add(summary.sessionId)
    } else {
      delegated.delete(summary.sessionId)
    }
  })

  // The agent stopped for a decision only the user can make.
  ctx.on('approval/request', (request, next) => {
    try {
      if (!isDelegated(request?.agent?.id)) {
        announce('attention', { approval: request?.toolName })
      }
    } catch {
      /* observation only: never disturb the decision itself */
    }
    return next()
  })

  // The agent asked a structured question, including plan review.
  ctx.on('user-questions/request', (request, next) => {
    try {
      if (!isDelegated(request?.agent?.id)) {
        announce('attention', { questions: request?.questions?.length ?? 0 })
      }
    } catch {
      /* observation only */
    }
    return next()
  })

  // `idle` after `running` is one finished turn. A session that was never seen
  // running stays silent, so startup and idle housekeeping never beep.
  ctx.on('agent/status', (payload) => {
    try {
      const sessionId = payload?.agent?.id
      if (typeof sessionId !== 'string') return
      if (payload.status === 'running') {
        running.add(sessionId)
        return
      }
      if (payload.status !== 'idle') return
      if (!running.delete(sessionId)) return
      const config = currentConfig()
      if (config.muteDelegated && isDelegated(sessionId)) return
      if (Date.now() - lastAttentionAt < config.attentionSettleMs) return
      announce('done', { sessionId })
    } catch {
      /* observation only */
    }
  })

  // ── settings page route ──────────────────────────────────────────────────
  // Both halves are optional: the sound above works without any Web transport,
  // so this registration simply does not happen in such a profile.
  //
  // `connection.fetch.register` is the extension point a plugin can actually
  // use: it only adds an entry to Connection's exact-route table. The obvious
  // alternative, `connection.rpc.handle(channel, handler)`, is unusable from a
  // plugin in this build: it runs `owner.webServer.register(route)` where
  // `owner` is the *service's own* context — whose inject list is
  // `['credentials']`, not `['webServer']` — so it always throws
  // `cannot get property "webServer" without inject`. Cordis drops the child
  // fiber silently, the plugin still reads as `active`, and the page sees HTTP
  // 405 for every endpoint.
  //
  // The path lives under `/api`, whose prefix route already applies the
  // Host/Origin fence and the signed browser cookie, so a same-origin fetch
  // from the page is authenticated exactly like the rest of the UI.
  ctx.inject(['connection'], (connectionCtx) => {
    try {
      connectionCtx.connection.fetch.register({
        path: ROUTE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = await request.json().catch(() => null)
            return Response.json(await handleEndpoint(body?.endpoint, body?.payload))
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return Response.json({ ok: false, error: { code: 'internal', message, details: {} } })
          }
        },
      })
      diagnose(`route ${ROUTE_PATH} registered`)
    } catch (error) {
      diagnose(`route ${ROUTE_PATH} registration failed: ${error?.stack ?? error}`)
    }
  })
}
