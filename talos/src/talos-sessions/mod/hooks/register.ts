// talos's mod: checks in with the session runner when the session starts, then
// reports what Claude Code does as numbered facts. The runner reaches it back
// through the helper (../helper.ts). See talos-sessions/link/link-protocol.ts
// for the other side; the names here are copies of its.
import type { EngineInterface, Register } from 'claude-code'

const ROUTES = { checkIn: 'http://talos/check-in', facts: 'http://talos/facts' }
const RETRY_MS = 1000
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
  if (acked === null) await $.clock.sleep(RETRY_MS)
  return sendFacts($)
}

// Never throws: a fact that can't be made is lost (the seq isn't taken), and
// the hook it came from still answers.
const report = async ($: Calls, type: string, details: Record<string, unknown>) => {
  if (!secret) return
  const fact = await Promise.all([$.clock.now(), $.session.id()]).catch(() => null)
  if (!fact) return
  const [atMs, sessionId] = fact
  sentSeq += 1
  unacked = [...unacked, { seq: sentSeq, type, atMs, sessionId, details }]
  void sendFacts($).catch(() => undefined)
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
}

// Observers call next first, so a slow runner never holds Claude Code up.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await checkIn($).catch(() => undefined)
    await report($, 'session-start', {})
    return started
  })
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    await report($, 'session-end', { reason: e.reason })
    return ended
  })
  on('session.stop', async ($, e, next) => {
    const stopped = await next(e)
    await report($, 'session-stop', {})
    return stopped
  })
  on('turn.start', ($, e, next) => {
    const started = next(e)
    void report($, 'turn-start', { turnId: e.turnId, agentId: e.agentId })
    return started
  })
  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    await report($, 'turn-complete', { turnId: e.turnId, agentId: e.agentId, reason: e.reason })
    return completed
  })
  on('prompt.submit', async ($, e, next) => {
    const submitted = await next(e)
    await report($, 'prompt-submit', { origin: e.origin })
    return submitted
  })
}
