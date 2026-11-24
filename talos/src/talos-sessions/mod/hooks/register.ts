// talos's mod: checks in with the session runner when the session starts,
// gives the session talos's tools, and asks the runner about each tool call
// and each Stop. Everything else talos needs comes on Claude Code's own
// stream. See talos-sessions/link/link-protocol.ts for the other side; the
// names here are copies of its.
import type { EngineInterface, Register } from 'claude-code'

const ROUTES = {
  checkIn: 'http://talos/check-in',
  heartbeat: 'http://talos/heartbeat',
  toolCall: 'http://talos/tool-call',
  toolCheck: 'http://talos/tool-check',
  stop: 'http://talos/stop',
}
// The runner counts a mod it hasn't heard from in a while as gone: a hook
// stuck in a loop leaves the mod dead while the session runs on.
const HEARTBEAT_MS = 5000
// How long a guard waits on the runner before it decides alone.
const GUARD_WAIT_MS = 2000
const NOT_RECORDED = "talos can't record that right now."
// What a tool call carries beside the tool's own fields.
const CALL_KEYS = ['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta']

// Kept in the module, not $.state: other mods can read $.state. A reload
// starts these over. The token is gone from the env by then, so the new copy
// can't check in, and the runner hears nothing more: the link is lost.
let socketPath = ''
let secret = ''

type Calls = EngineInterface

const post = (body: unknown) => ({
  method: 'POST',
  socketPath,
  headers: { 'content-type': 'application/json', ...(secret && { authorization: `Bearer ${secret}` }) },
  body: JSON.stringify(body),
})

// A question to the runner, or null if it doesn't answer in time.
const askRunner = async ($: Calls, route: string, body: unknown): Promise<Record<string, unknown> | null> => {
  if (!secret) return null
  const asked = $.http.fetch(route, post(body)).then(answer => (answer.ok ? (JSON.parse(answer.text) as Record<string, unknown>) : null))
  return Promise.race([asked, $.clock.sleep(GUARD_WAIT_MS).then(() => null)]).catch(() => null)
}

// The runner checks a call to one of talos's tools and gives the reply the
// session reads: the call is answered here, so nothing else runs it.
const answerTalosTool = async ($: Calls, e: Record<string, unknown>) => {
  const input = Object.fromEntries(Object.entries(e).filter(([key]) => !CALL_KEYS.includes(key)))
  const answer = await askRunner($, ROUTES.toolCall, { tool: e.tool, toolUseId: e.tool_use_id, agentId: e.agentId, input })
  if (typeof answer?.result === 'string') return { result: answer.result }
  return { deny: typeof answer?.deny === 'string' ? answer.deny : NOT_RECORDED }
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
    post({ token, sessionId: await $.session.id(), version, snapshot: $.plugin.root.split('/').at(-1) }),
  )
  if (!answer.ok) return
  const { secret: given, tools } = JSON.parse(answer.text)
  secret = String(given)
  // In the prompt's list, not behind ToolSearch: an asked-for turn may call
  // only its tool, so it can't look one up.
  for (const tool of Array.isArray(tools) ? tools : []) {
    await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, isDeferred: false }).catch(() => undefined)
  }
  $.clock.every(HEARTBEAT_MS, () => void $.http.fetch(ROUTES.heartbeat, post({})).catch(() => undefined))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await checkIn($).catch(() => undefined)
    return started
  })
  // While talos asks for one kind of answer, the session's own turn may call
  // nothing else: the runner says, at the moment of the call, since its rule
  // changes as a message goes in. A sub-agent already running keeps its
  // tools. A runner that doesn't answer leaves the call to Claude Code, so a
  // slow runner never stops a session's work.
  on('tool.check', async ($, e, next) => {
    const check = e.agentId === undefined ? await askRunner($, ROUTES.toolCheck, { tool: e.tool }) : null
    return typeof check?.deny === 'string' ? { decision: 'deny', reason: check.deny } : next(e)
  }).catch(($, e, next) => next(e))
  // A call to talos's own tool is the runner's to allow, and one that can't be
  // checked doesn't run.
  on('tool.call', { tool: /^mcp__talos__/ }, ($, e) => answerTalosTool($, e as Record<string, unknown>)).catch(() => ({ deny: NOT_RECORDED }))
  // An asked-for turn that ends unanswered is sent back once to answer.
  on('classic.Stop', async ($, e, next) => {
    const answer = await askRunner($, ROUTES.stop, {})
    return typeof answer?.block === 'string' ? { block: answer.block } : next(e)
  }).catch(($, e, next) => next(e))
  // No other mod's code runs in a talos session: any hook of another mod hears
  // every call talos makes, and could read or rewrite its link. Other plugins
  // keep their skills and commands; only their hooks modules are refused. A
  // judge that fails refuses too.
  on('plugin.register', ($, e, next) => (e.name === 'talos' ? next(e) : { refuse: 'talos sessions run no other mods' })).catch(
    () => ({ refuse: "talos couldn't check this mod" }),
  )
}
