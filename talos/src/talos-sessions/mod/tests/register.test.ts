import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// The test stands in for the runner's link socket and the session, and
// records what the mod sends. answers: the runner's reply by route (null: no
// answer, as when it's down).
const DOWN = { value: { status: 503, ok: false, headers: {}, text: '' } }
const TOOLS = [{ name: 'send_note', description: 'Send a note.', inputSchema: { type: 'object' } }]
const runner = (on: On, answers: Record<string, unknown> = {}) => {
  const asked: { route: string; body: unknown; authorization?: string }[] = []
  on('http.fetch', (_, e) => {
    const route = e.url.replace('http://talos', '')
    asked.push({ route, body: JSON.parse(String(e.init?.body)), authorization: e.init?.headers?.authorization })
    const answer = route === '/check-in' ? { secret: 's3cret', tools: TOOLS } : (answers[route] ?? {})
    return answer === null ? DOWN : { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) } }
  })
  return asked
}

const linked = (on: On) => {
  mock.env(on, { TALOS_LINK_TOKEN: 'one-use', TALOS_LINK_SOCKET: '/tmp/link.sock' })
  on('env.set', () => ({ value: {} }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330', builtAt: '' } }))
  on('session.start', (_, e) => e)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__talos__${e.name}` } }))
}
const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)

test('it checks in with the token, unsets it, registers the tools in the prompt list, and sends the secret after', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { TALOS_LINK_TOKEN: 'one-use', TALOS_LINK_SOCKET: '/tmp/link.sock' })
  const envSets: { name: string; value?: string }[] = []
  on('env.set', (_, e) => {
    envSets.push(e)
    return { value: {} }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330', builtAt: '' } }))
  on('session.start', (_, e) => e)
  const registered: unknown[] = []
  on('tool.register', (_, e) => {
    registered.push(e)
    return { value: { tool: `mcp__talos__${e.name}` } }
  })
  const asked = runner(on)
  await start($)
  await clock.advance(5000)
  expect(envSets).toEqual([{ name: 'TALOS_LINK_TOKEN' }])
  expect(asked[0]).toEqual({ route: '/check-in', body: { token: 'one-use', sessionId: 'session-1', version: '2.1.330', snapshot: expect.any(String) }, authorization: undefined })
  expect(registered).toEqual([{ ...TOOLS[0], isDeferred: false }])
  expect(asked.slice(1).map(({ route, authorization }) => [route, authorization])).toEqual([['/heartbeat', 'Bearer s3cret']])
})

test('with no token it sends nothing', async ($, on) => {
  mock.env(on, {})
  const asked = runner(on)
  on('session.start', (_, e) => e)
  await start($)
  expect(asked).toEqual([])
})

test("a call to talos's tool is the runner's to answer: its reply, its denial, or a denial when it can't be reached", async ($, on) => {
  mock.clock(on)
  linked(on)
  const answers: Record<string, unknown> = { '/tool-call': { result: 'Recorded as x.' } }
  const asked = runner(on, answers)
  await start($)
  const call = () => $.tool.call({ tool: 'mcp__talos__send_note', text: 'hi', tool_use_id: 'u1' } as never)
  expect(await call()).toMatchObject({ result: 'Recorded as x.' })
  expect(asked.find(({ route }) => route === '/tool-call')?.body).toEqual({ tool: 'mcp__talos__send_note', toolUseId: 'u1', input: { text: 'hi' } })
  answers['/tool-call'] = { deny: 'Only mcp__talos__send_poll is allowed this turn.' }
  expect(await call()).toMatchObject({ deny: 'Only mcp__talos__send_poll is allowed this turn.' })
  answers['/tool-call'] = null
  expect(await call()).toMatchObject({ deny: "talos can't record that right now." })
})

test('the runner says at each call whether a tool may run, and whether a Stop is sent back', async ($, on) => {
  mock.clock(on)
  linked(on)
  const answers: Record<string, unknown> = { '/tool-check': { deny: 'Only mcp__talos__send_poll is allowed this turn.' }, '/stop': { block: 'Call it before finishing.' } }
  const asked = runner(on, answers)
  on('tool.check', () => ({ decision: 'allow' }) as never)
  on('classic.Stop', () => ({}))
  await start($)
  const check = (agentId?: string) => $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u1', approver: 'person', ...(agentId && { agentId }) } as never)
  expect(await check()).toMatchObject({ decision: 'deny', reason: 'Only mcp__talos__send_poll is allowed this turn.' })
  expect(await $.classic.Stop({ stop_hook_active: false } as never)).toEqual({ block: 'Call it before finishing.' })
  // A sub-agent's call isn't asked about: it keeps its tools.
  expect(await check('a1')).toMatchObject({ decision: 'allow' })
  expect(asked.filter(({ route }) => route === '/tool-check')).toHaveLength(1)
  answers['/tool-check'] = {}
  answers['/stop'] = {}
  expect(await check()).toMatchObject({ decision: 'allow' })
  expect(await $.classic.Stop({ stop_hook_active: false } as never)).toEqual({})
})

test("a runner that doesn't answer leaves each call and Stop to Claude Code", async ($, on) => {
  mock.clock(on)
  linked(on)
  runner(on, { '/tool-check': null, '/stop': null })
  on('tool.check', () => ({ decision: 'allow' }) as never)
  on('classic.Stop', () => ({}))
  await start($)
  expect(await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u1', approver: 'person' } as never)).toMatchObject({ decision: 'allow' })
  expect(await $.classic.Stop({ stop_hook_active: false } as never)).toEqual({})
})

// Refusing other mods (plugin.register) can't be raised from the kit; it was
// checked in a session (ref/mod-test-results.md, "Before step 5" and
// "Headless probe").
