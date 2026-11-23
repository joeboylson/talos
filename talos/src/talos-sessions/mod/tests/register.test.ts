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
const runnerBeneath = (on: Parameters<Parameters<typeof test>[1]>[1], posts: number[][], reply = (text: string) => text, isUp = () => true) =>
  on('http.fetch', (_, e) => {
    if (e.url.endsWith('/check-in')) return { value: { status: 200, ok: true, headers: {}, text: '{"secret":"s"}' } }
    if (!isUp()) return DOWN
    const seqs = (JSON.parse(String(e.init?.body)).facts as { seq: number }[]).map(({ seq }) => seq)
    posts.push(seqs)
    return { value: { status: 200, ok: true, headers: {}, text: reply(`{"acked":${seqs.at(-1)}}`) } }
  })

const startLinked = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  mock.env(on, { TALOS_LINK_TOKEN: 't', TALOS_LINK_SOCKET: '/tmp/link.sock' })
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
