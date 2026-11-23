import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// The test stands in for the runner's link socket and the session, and
// records what the mod sends.
test('it checks in with the token, unsets it, starts the helper and sends numbered facts', async ($, on) => {
  const sent: { url: string; body: unknown; authorization?: string }[] = []
  const envSets: { name: string; value?: string }[] = []
  const spawned: string[][] = []
  mock.clock(on)
  mock.env(on, { TALOS_LINK_TOKEN: 'one-use', TALOS_LINK_SOCKET: '/tmp/link.sock', TALOS_BUN: '/bin/bun' })
  on('env.set', (_, e) => {
    envSets.push(e)
    return { value: {} }
  })
  on('http.fetch', (_, e) => {
    sent.push({ url: e.url, body: JSON.parse(String(e.init?.body)), authorization: e.init?.headers?.authorization })
    const text = e.url.endsWith('/check-in') ? '{"secret":"s3cret"}' : `{"acked":${sent.length - 1}}`
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    return { value: { code: 0, signal: null } }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330', builtAt: '' } }))
  on('session.start', (_, e) => e)
  on('turn.start', (_, e) => e)

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ turnId: 't1', text: 'hi' } as never)

  expect(envSets).toEqual([{ name: 'TALOS_LINK_TOKEN' }])
  expect(sent[0]).toEqual({
    url: 'http://talos/check-in',
    body: { token: 'one-use', sessionId: 'session-1', version: '2.1.330', snapshot: expect.any(String) },
    authorization: undefined,
  })
  const facts = sent.slice(1).flatMap(({ body }) => (body as { facts: { seq: number; type: string }[] }).facts)
  expect(facts.map(({ seq, type }) => [seq, type])).toEqual([[1, 'session-start'], [2, 'turn-start']])
  expect(sent.slice(1).every(({ authorization }) => authorization === 'Bearer s3cret')).toBe(true)
  expect(spawned[0]?.[0]).toBe('/bin/bun')
})

test('with no token it sends nothing', async ($, on) => {
  const sent: string[] = []
  mock.env(on, {})
  on('http.fetch', (_, e) => {
    sent.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('session.start', (_, e) => e)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
  expect(sent).toEqual([])
})

// Answers a check-in, then acks each facts post as the runner would: up to the
// last fact in it. While isUp says no, it turns facts away.
const DOWN = { value: { status: 503, ok: false, headers: {}, text: '' } }
const runnerBeneath = (on: On, posts: number[][], reply = (text: string) => text, isUp = () => true) =>
  on('http.fetch', (_, e) => {
    if (e.url.endsWith('/check-in')) return { value: { status: 200, ok: true, headers: {}, text: '{"secret":"s"}' } }
    if (!isUp()) return DOWN
    const seqs = (JSON.parse(String(e.init?.body)).facts as { seq: number }[]).map(({ seq }) => seq)
    posts.push(seqs)
    return { value: { status: 200, ok: true, headers: {}, text: reply(`{"acked":${seqs.at(-1)}}`) } }
  })

// With a Bun path the mod starts its helper, which the test then stands in for.
const startLinked = (on: On, bun?: string) => {
  mock.env(on, { TALOS_LINK_TOKEN: 't', TALOS_LINK_SOCKET: '/tmp/link.sock', ...(bun && { TALOS_BUN: bun }) })
  on('env.set', () => ({ value: {} }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330', builtAt: '' } }))
  on('session.start', (_, e) => e)
  on('turn.start', (_, e) => e)
}

test('facts that piled up go a post at a time, none past the runner cap', async ($, on) => {
  const posts: number[][] = []
  const clock = mock.clock(on)
  startLinked(on)
  // Down at first, so the facts pile up.
  let isRunnerUp = false
  runnerBeneath(on, posts, text => text, () => isRunnerUp)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
  for (let turn = 0; turn < 250; turn += 1) await $.turn.start({ turnId: `t${turn}`, text: '' } as never)
  isRunnerUp = true
  await clock.advance(1000)
  await clock.advance(1000)
  expect(posts.map(seqs => seqs.length)).toEqual([200, 51])
  expect(posts.flat().at(-1)).toBe(251)
})

test('a reply that is no ack is tried again, and reporting carries on', async ($, on) => {
  const posts: number[][] = []
  const clock = mock.clock(on)
  startLinked(on)
  let replies = 0
  runnerBeneath(on, posts, text => (replies++ === 0 ? 'not json' : text))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(1000)
  await $.turn.start({ turnId: 't1', text: '' } as never)
  await clock.advance(1000)
  expect(posts[0]).toEqual([1])
  expect(posts.flat().at(-1)).toBe(2)
})

const factsOf = (posts: { facts: { type: string; details: Record<string, unknown> }[] }[]) => posts.flatMap(({ facts }) => facts)

const recordFacts = (on: On) => {
  const posts: { facts: { type: string; details: Record<string, unknown> }[] }[] = []
  on('http.fetch', (_, e) => {
    if (e.url.endsWith('/check-in')) return { value: { status: 200, ok: true, headers: {}, text: '{"secret":"s"}' } }
    const body = JSON.parse(String(e.init?.body))
    posts.push(body)
    const last = body.facts.at(-1)?.seq ?? 0
    return { value: { status: 200, ok: true, headers: {}, text: `{"acked":${last}}` } }
  })
  return posts
}

test('a turn says who started it: the person, talos, or Claude Code itself', async ($, on) => {
  mock.clock(on)
  startLinked(on)
  const posts = recordFacts(on)
  on('prompt.submit', (_, e) => ({ text: e.text, origin: e.origin }) as never)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
  await $.prompt.submit({ text: 'typed', origin: { kind: 'composer' } } as never)
  await $.turn.start({ turnId: 't1', text: 'typed' } as never)
  await $.prompt.submit({ text: 'sent', origin: { kind: 'plugin', name: 'talos', asUser: true } } as never)
  await $.turn.start({ turnId: 't2', text: 'sent' } as never)
  await $.turn.start({ turnId: 't3', text: 'a task finished' } as never)
  await $.turn.start({ turnId: 't4', text: 'typed', agentId: 'a1' } as never)
  const starts = factsOf(posts).filter(({ type }) => type === 'turn-start').map(({ details }) => details.startedBy)
  expect(starts).toEqual(['person', 'talos', 'self', 'self'])
})

// That a declined or allowed call then reports permission-settled needs the
// call's real id, which the kit mints itself; it was checked in a session
// (ref/mod-test-results.md, "Before step 4").
test('a permission prompt is reported only when the person is the one asked', async ($, on) => {
  mock.clock(on)
  startLinked(on)
  const posts = recordFacts(on)
  on('tool.check', (_, e) => ((e.input as { ask?: boolean }).ask ? { decision: 'ask' } : { decision: 'allow' }) as never)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
  await $.tool.check({ tool: 'Bash', input: { ask: true }, tool_use_id: 'u1', approver: 'person' } as never)
  await $.tool.check({ tool: 'Bash', input: { ask: false }, tool_use_id: 'u2', approver: 'person' } as never)
  await $.tool.check({ tool: 'Bash', input: { ask: true }, tool_use_id: 'u3', approver: 'host' } as never)
  const permissionFacts = factsOf(posts)
    .filter(({ type }) => type.startsWith('permission'))
    .map(({ type, details }) => [type, details.toolUseId])
  expect(permissionFacts).toEqual([['permission-asked', 'u1']])
})

test('a fact that comes before the one ahead of it is resent after a pause, not at once', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { TALOS_LINK_TOKEN: 't', TALOS_LINK_SOCKET: '/tmp/link.sock' })
  on('env.set', () => ({ value: {} }))
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330', builtAt: '' } }))
  const posts: number[][] = []
  // The runner takes facts only in order: past a gap it acks what it had.
  let lastTaken = 0
  on('http.fetch', (_, e) => {
    if (e.url.endsWith('/check-in')) return { value: { status: 200, ok: true, headers: {}, text: '{"secret":"s"}' } }
    const seqs = (JSON.parse(String(e.init?.body)).facts as { seq: number }[]).map(({ seq }) => seq)
    posts.push(seqs)
    seqs.forEach(seq => (lastTaken = seq === lastTaken + 1 ? seq : lastTaken))
    return { value: { status: 200, ok: true, headers: {}, text: `{"acked":${lastTaken}}` } }
  })
  // The second fact's id comes late, so the third is ready first.
  let idCalls = 0
  on('session.id', async () => {
    idCalls += 1
    if (idCalls === 3) await clock.sleep(5000)
    return { value: 'session-1' }
  })
  on('session.start', (_, e) => e)
  on('turn.start', (_, e) => e)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
  void $.turn.start({ turnId: 't1', text: '' } as never)
  void $.turn.start({ turnId: 't2', text: '' } as never)
  await clock.settle()
  const postsBeforeTheGapFills = posts.length
  await clock.advance(4000)
  expect(posts.length - postsBeforeTheGapFills).toBeLessThanOrEqual(5)
  await clock.advance(2000)
  expect(lastTaken).toBe(3)
})

test('/fork is refused with a reason, and other commands run', async ($, on) => {
  on('command.run', (_, e) => ({ text: `ran ${e.command}` }))
  expect(await $.command.run({ command: 'fork' } as never)).toMatchObject({ text: "talos sessions can't fork; start a new session instead" })
  expect(await $.command.run({ command: 'compact' } as never)).toMatchObject({ text: 'ran compact' })
})

// Refusing other mods (plugin.register) can't be raised from the kit; it was
// checked in a session (ref/mod-test-results.md, "Before step 5").

test("a submit from the runner goes in as the person or framed, reports done, and its turn says who started it", async ($, on) => {
  const clock = mock.clock(on)
  startLinked(on, '/bin/bun')
  const posts = recordFacts(on)
  const submitted: { text: string; asUser?: true }[] = []
  on('prompt.submit', (_, e) => {
    submitted.push({ text: e.text, ...((e.origin as { asUser?: true }).asUser && { asUser: true as const }) })
    return { text: e.text }
  })
  // The helper's output, in pieces that split a line, as a process's may.
  const lines = [
    JSON.stringify({ type: 'submit', sendId: 's1', text: 'from the page', isPerson: true }),
    JSON.stringify({ type: 'submit', sendId: 's2', text: 'an ask', isPerson: false }),
  ].join('\n') + '\n'
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: lines.slice(0, 20) }
    yield { stream: 'stdout' as const, text: lines.slice(20) }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  await $.turn.start({ turnId: 't1', text: 'from the page' } as never)
  await $.turn.start({ turnId: 't2', text: 'an ask' } as never)
  expect(submitted).toEqual([{ text: 'from the page', asUser: true }, { text: 'an ask' }])
  const facts = factsOf(posts)
  expect(facts.filter(({ type }) => type === 'submit-done').map(({ details }) => details.sendId)).toEqual(['s1', 's2'])
  expect(facts.filter(({ type }) => type === 'turn-start').map(({ details }) => details.startedBy)).toEqual(['person', 'talos'])
})
