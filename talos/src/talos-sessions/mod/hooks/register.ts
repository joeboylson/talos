// talos's mod: checks in with the session runner when the session starts, then
// reports what Claude Code does as numbered facts. The runner reaches it back
// through the helper (../helper.ts). See talos-sessions/link/link-protocol.ts
// for the other side; the names here are copies of its.
import type { EngineInterface, Register } from 'claude-code'

const ROUTES = { checkIn: 'http://talos/check-in', facts: 'http://talos/facts' }
const RETRY_MS = 1000
// The runner counts a mod it hasn't heard from in a while as gone: a hook
// stuck in a loop leaves the mod dead while its helper stays up.
const HEARTBEAT_MS = 5000
// Prompts kept to match to their turns; one that never starts a turn ages out.
const MAX_PENDING_PROMPTS = 20
// The runner turns down a bigger post (SESSION_LIMITS.maxFactsPerPost).
const MAX_FACTS_PER_POST = 200

// Kept in the module, not $.state: other mods can read $.state. A reload
// starts these over. The token is gone from the env by then, so the new copy
// can't check in, and the runner sees the old helper's stream close: the link
// is lost.
let socketPath = ''
let secret = ''
let sentSeq = 0
let unacked: Fact[] = []
let isSending = false
let lastSessionId = ''
// Prompts submitted but not yet started, with who sent each, so a turn can say
// who started it (see TURN_STARTERS in link-protocol.ts).
let pendingPrompts: { text: string; startedBy: TurnStarter }[] = []
// Tool calls whose permission prompt shows, so their end can be reported.
let waitingPermissions: string[] = []

type TurnStarter = 'person' | 'talos' | 'self'

type Fact = { seq: number; type: string; atMs: number; sessionId: string; details: Record<string, unknown> }
type Calls = EngineInterface

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  socketPath,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

// The seq the runner acked, or null for a reply that isn't one.
const readAcked = (text: string): number | null => {
  try {
    const acked = Number(JSON.parse(text).acked)
    return Number.isSafeInteger(acked) ? acked : null
  } catch {
    return null
  }
}

// Sends the facts not yet acked, oldest first and a post's worth at a time,
// until none are left. One sender at a time; a failed post is tried again,
// and a resend is how a gap gets filled.
const sendFacts = async ($: Calls): Promise<void> => {
  if (isSending || !secret || unacked.length === 0) return
  isSending = true
  const sent = unacked.slice(0, MAX_FACTS_PER_POST)
  const answer = await $.http
    .fetch(ROUTES.facts, post(ROUTES.facts, { facts: sent }, { authorization: `Bearer ${secret}` }))
    .catch(() => null)
  const acked = answer?.ok ? readAcked(answer.text) : null
  if (acked !== null) unacked = unacked.filter(fact => fact.seq > acked)
  isSending = false
  // Also when nothing was taken: a fact still being made leaves a gap.
  const isStuck = acked === null || acked < sent[0]!.seq
  if (isStuck) await $.clock.sleep(RETRY_MS)
  return sendFacts($)
}

// The seq is taken at once, in the order the events came, and never lost: a
// fact whose time or id can't be read goes with the last ones known. The
// runner takes facts only in seq order, so a gap would hold up every later one.
const report = ($: Calls, type: string, details: Record<string, unknown>): void => {
  if (!secret) return
  sentSeq += 1
  const seq = sentSeq
  void Promise.all([$.clock.now(), $.session.id()])
    .catch(() => [0, lastSessionId] as const)
    .then(([atMs, sessionId]) => {
      lastSessionId = sessionId || lastSessionId
      unacked = [...unacked, { seq, type, atMs, sessionId: sessionId || 'unknown', details }].sort((a, b) => a.seq - b.seq)
      return sendFacts($)
    })
    .catch(() => undefined)
}

// An empty post: the runner counts it as word from the mod.
const sendHeartbeat = ($: Calls) => {
  if (!secret || isSending) return
  void $.http.fetch(ROUTES.facts, post(ROUTES.facts, { facts: [] }, { authorization: `Bearer ${secret}` })).catch(() => undefined)
}

const starterOf = (origin: unknown): TurnStarter => {
  const kind = typeof origin === 'object' && origin !== null ? Reflect.get(origin, 'kind') : undefined
  if (kind === 'composer' || kind === 'bridge') return 'person'
  const isTalos = kind === 'plugin' && Reflect.get(origin as object, 'name') === 'talos'
  return isTalos ? 'talos' : 'self'
}

// A turn's text is its prompt's: a plugin's submit always gets a turn of its
// own. A turn no prompt matches, Claude Code started on its own.
const takeStarter = (text: string): TurnStarter => {
  const index = pendingPrompts.findIndex(prompt => prompt.text === text)
  if (index === -1) return 'self'
  const { startedBy } = pendingPrompts[index]!
  pendingPrompts = pendingPrompts.filter((_, at) => at !== index)
  return startedBy
}

// The helper is the runner's way in: it holds a stream open to the runner and
// writes each command to its output. Its loop is its life, so it ends with the
// session or this module.
const startHelper = async ($: Calls) => {
  const bun = await $.env.get('TALOS_BUN')
  if (!bun) return
  const helper = $.process.spawn({
    argv: [bun, `${$.plugin.root}/helper.ts`],
    env: { TALOS_LINK_SOCKET: socketPath, TALOS_LINK_SECRET: secret },
  })
  for await (const _chunk of helper) {
    // The runner sends only heartbeats so far: nothing to act on.
  }
}

const checkIn = async ($: Calls) => {
  const token = await $.env.get('TALOS_LINK_TOKEN')
  socketPath = (await $.env.get('TALOS_LINK_SOCKET')) ?? ''
  if (!token || !socketPath) return
  // Gone from the env before anything else runs, so no Bash call or command
  // hook started later sees it.
  await $.env.set('TALOS_LINK_TOKEN', undefined)
  const { version } = await $.session.version()
  const answer = await $.http.fetch(
    ROUTES.checkIn,
    post(ROUTES.checkIn, { token, sessionId: await $.session.id(), version, snapshot: $.plugin.root.split('/').at(-1) }),
  )
  if (!answer.ok) return
  secret = String(JSON.parse(answer.text).secret)
  void startHelper($)
  $.clock.every(HEARTBEAT_MS, () => sendHeartbeat($))
}

// Observers call next first, so a slow runner never holds Claude Code up.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await checkIn($).catch(() => undefined)
    report($, 'session-start', {})
    return started
  })
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    report($, 'session-end', { reason: e.reason })
    return ended
  })
  on('session.stop', async ($, e, next) => {
    const stopped = await next(e)
    report($, 'session-stop', { isTurnRunning: e.isTurnRunning })
    return stopped
  })
  // Before next: the turn it starts can begin before next resolves.
  on('prompt.submit', ($, e, next) => {
    const startedBy = starterOf(e.origin)
    pendingPrompts = [...pendingPrompts, { text: e.text, startedBy }].slice(-MAX_PENDING_PROMPTS)
    report($, 'prompt-submit', { origin: e.origin })
    return next(e)
  })
  on('turn.start', ($, e, next) => {
    const started = next(e)
    const startedBy = e.agentId === undefined ? takeStarter(e.text) : 'self'
    report($, 'turn-start', { turnId: e.turnId, agentId: e.agentId, startedBy })
    return started
  })
  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId === undefined) waitingPermissions = []
    report($, 'turn-complete', { turnId: e.turnId, agentId: e.agentId, reason: e.reason })
    return completed
  })
  // The verdict is read after next, and nothing waits on the runner: a
  // tool.check that waits holds the permission dialog back.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const isPersonAsked = verdict.decision === 'ask' && e.approver === 'person' && e.tool_use_id !== undefined
    if (isPersonAsked) {
      waitingPermissions = [...waitingPermissions, e.tool_use_id!]
      report($, 'permission-asked', { toolUseId: e.tool_use_id, agentId: e.agentId })
    }
    return verdict
  })
  // Allowed or declined (Esc or "No"), the call resolves here.
  on('tool.call', async ($, e, next) => {
    const called = await next(e)
    const toolUseId = e.tool_use_id
    if (toolUseId && waitingPermissions.includes(toolUseId)) {
      waitingPermissions = waitingPermissions.filter(id => id !== toolUseId)
      report($, 'permission-settled', { toolUseId })
    }
    return called
  })
}
