/** The AgentMail source: trigger normalization, the inbox poll loop, its policy part and environment. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { AgentmailError, agentmailFetch, sendAgentmail } from '../src/sources/agentmail-channel.ts'
import { apply as applyAgentmail, agentmailKind } from '../src/sources/agentmail.ts'
import { pollFailure } from '../src/sources/agentmail-loops.ts'
import { KV } from '../src/kv.ts'
import { addressOf, agentmailChannel, agentmailParent, agentmailRef, agentmailTrigger, agentmailTriggerId, SOURCE, type AgentmailMessage } from '../src/sources/agentmail-trigger.ts'
import { agentmailThreadContext } from '../src/sources/agentmail-read.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { mattermostKind } from '../src/sources/mattermost.ts'
import { githubKind } from '../src/sources/github.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

const INBOX = 'agent@agentmail.test'
const SENDER = 'Bob <bob@example.test>'
const message = (overrides: Partial<AgentmailMessage> = {}): AgentmailMessage =>
  ({ message_id: 'm1', thread_id: 't1', from: SENDER, to: [INBOX], timestamp: '2026-09-02T00:00:00Z', text: 'Please fix the login', labels: [], ...overrides })

/** A host whose AgentMail account and inbox polling the fake API serves; rounds are driven by fake timers. */
const healthOf = new WeakMap<SourceRegistry, HealthBoard>()
function host(overrides: Partial<SourceContextDeps> = {}, fetchRoutes: (url: URL, init: RequestInit | undefined) => Response | undefined = () => undefined) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'agentmail-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({ eval: { mode: 'auto' }, sources: { agentmail: { enabled: true, config: { apiKey: 'test-key', inboxId: INBOX, failuresBeforeError: 2 } } },
    policy: { sources: { agentmail: { allowed: [{ id: 'bob@example.test', name: 'Bob' }] } } } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  healthOf.set(sources, board)
  const deployment = testDeployment({ agentmail: { apiKey: 'test-key', inboxId: INBOX } })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => engine.receive(trigger))
  const parts: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    return fetchRoutes(url, init) ?? new Response('{}', { status: 404 })
  })
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const context = sourceContextOf(parts, { kind: SOURCE, health: ['agentmail'] })
  return { ...value, ...context, health: healthOf.get(parts.sources as SourceRegistry)!.all, store, receive, commands, fetchSpy,
    stop: async () => { fetchSpy.mockRestore(); store.close() } }
}

describe('agentmail source', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('turns an email into a trigger addressed to the agent, and names its parent from In-Reply-To', () => {
    const trigger = agentmailTrigger(message(), INBOX)!
    expect(trigger).toMatchObject({ source: SOURCE, id: agentmailTriggerId('m1'), human: true, addressed: 'direct',
      at: '2026-09-02T00:00:00Z', text: 'Please fix the login' })
    expect(trigger.threads).toEqual([{ source: SOURCE, id: 't1' }])
    expect(trigger.actor).toEqual({ source: SOURCE, id: 'bob@example.test' })
    expect(trigger.channel).toEqual(agentmailChannel(INBOX, 't1', 'm1'))
    // The extracted text wins over the raw body, and a reply names the message it answers.
    expect(agentmailTrigger(message({ extracted_text: 'just the reply', text: 'quoted history below' }), INBOX)!.text).toBe('just the reply')
    expect(agentmailParent(agentmailTrigger(message({ in_reply_to: 'm0' }), INBOX)!)).toBe(agentmailTriggerId('m0'))
    expect(agentmailParent(agentmailTrigger(message(), INBOX)!)).toBeUndefined()
  })

  it('skips the inbox\'s own outgoing mail, and reads the reply address from a display name', () => {
    expect(agentmailTrigger(message({ from: INBOX }), INBOX)).toBeUndefined()
    expect(agentmailTrigger(message({ from: `AgentMail <${INBOX}>` }), INBOX)).toBeUndefined()
    expect(addressOf(SENDER)).toBe('bob@example.test')
    expect(addressOf('plain@example.test')).toBe('plain@example.test')
  })

  it('keeps the retained reference the thread reader needs', () => {
    const trigger = agentmailTrigger(message(), INBOX)!
    expect(agentmailRef(trigger)).toEqual({ triggerId: agentmailTriggerId('m1'), inboxId: INBOX, threadId: 't1', messageId: 'm1', at: '2026-09-02T00:00:00Z' })
    expect(agentmailRef({ ...trigger, source: 'github' })).toBeUndefined()
  })

  it('reads a thread page, the parent of a reply, and the root of the thread', async () => {
    const h = host({}, url => {
      if (url.pathname !== '/v0/threads/t1') return undefined
      return url.searchParams.get('page_token') === 'p2'
        ? Response.json({ thread_id: 't1', count: 1, messages: [message({ message_id: 'm0', timestamp: '2026-09-01T00:00:00Z' })] })
        : Response.json({ thread_id: 't1', count: 2, next_page_token: 'p2',
          messages: [message({ message_id: 'm1' }), message({ message_id: 'm2', in_reply_to: 'm1', timestamp: '2026-09-02T00:01:00Z' })] })
    })
    const trigger = agentmailTrigger(message(), INBOX)!
    const context = agentmailThreadContext
    expect(context.messageId(trigger)).toBe('m1')
    const thread = await context.read(h.commands, trigger, 'thread', undefined, { readPageSize: 20 })
    expect(thread.messages.map(item => item.id)).toEqual(['m1', 'm2'])
    expect(thread.next).toBe('p2')
    const parent = await context.read(h.commands, agentmailTrigger(message({ in_reply_to: 'm0' }), INBOX)!, 'parent', undefined, { readPageSize: 20 })
    expect(parent.messages.map(item => item.id)).toEqual(['m0'])
    const missing = await context.read(h.commands, agentmailTrigger(message({ in_reply_to: 'gone' }), INBOX)!, 'parent', undefined, { readPageSize: 20 })
    expect(missing.status).toBe('no_parent')
    const root = await context.read(h.commands, trigger, 'root', undefined, { readPageSize: 20 })
    expect(root.messages.map(item => item.id)).toEqual(['m0'])
    await h.stop()
  })

  it('answers a reply through the API with the message id as its idempotency key, and calls a deleted thread gone', async () => {
    const sent: { path: string; key?: string; body?: unknown }[] = []
    let refuse = false
    const h = host({}, (url, init) => {
      if (init?.method === 'POST' && url.pathname.endsWith('/reply')) {
        if (refuse) return new Response('{}', { status: 404 })
        sent.push({ path: url.pathname, key: new Headers(init.headers).get('Idempotency-Key') ?? undefined, body: JSON.parse(String(init.body)) })
        return Response.json({ message_id: 'out1', thread_id: 't1' })
      }
      return new Response('{}', { status: 404 })
    })
    const outcome = await sendAgentmail(h, { id: key('ack', 'trigger-1'), kind: 'reply', channel: agentmailChannel(INBOX, 't1', 'm1'), text: '收到，修复回归。' } as never)
    expect(outcome).toBe('sent')
    expect(sent[0]).toMatchObject({ path: `/v0/inboxes/${INBOX}/messages/m1/reply`, key: key('ack', 'trigger-1'), body: { text: '收到，修复回归。' } })
    refuse = true
    await expect(sendAgentmail(h, { id: 'k', kind: 'reply', channel: agentmailChannel(INBOX, 't1', 'm1'), text: 'x' } as never)).resolves.toBe('gone')
    await expect(agentmailFetch({ apiKey: 'k', inboxId: INBOX }, '/threads/t1')).rejects.toThrow(AgentmailError)
    await h.stop()
  })

  it('admits any address while enabled, and searches Threads by their key', () => {
    const config = agentmailKind.schema.parse({ apiKey: 'k', inboxId: INBOX })
    expect(agentmailKind.scope!.call(agentmailKind, { meta: {} }, config)).toEqual({ listened: true, observed: false, row: 'inbox' })
    expect(agentmailKind.channel!.allowed).toBeUndefined() // every address may receive a reply
    expect(agentmailKind.find!('agentmail:t1')).toEqual({ threads: ['agentmail:t1'], terms: [] })
    expect(agentmailKind.find!('bob@example.test')).toEqual({ threads: [], terms: [] })
  })

  it('receives only the whitelisted senders once the list names any, case-insensitively', () => {
    const config = agentmailKind.schema.parse({ apiKey: 'k', inboxId: INBOX, senders: [{ address: 'Bob@example.test' }] })
    expect(agentmailKind.scope!.call(agentmailKind, { meta: { from: 'BOB@example.test' } }, config)).toEqual({ listened: true, observed: false, row: 'inbox' })
    expect(agentmailKind.scope!.call(agentmailKind, { meta: { from: 'someone@else.test' } }, config))
      .toEqual({ listened: false, reason: 'sender_not_listened' })
    // The whitelist rejects a malformed address at save time.
    expect(() => agentmailKind.schema.parse({ apiKey: 'k', inboxId: INBOX, senders: [{ address: 'not-an-email' }] })).toThrow()
  })

  it('skips mail whose authentication results show no pass, and names the skips in health', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const threads: { thread_id: string; timestamp: string; last_message_id: string; message_count: number; subject?: string }[] = []
      const messages: AgentmailMessage[] = []
      const h = host({}, url => {
        if (url.pathname === `/v0/inboxes/${INBOX}/threads`) return Response.json({ threads })
        if (url.pathname.startsWith('/v0/threads/')) {
          const id = decodeURIComponent(url.pathname.slice('/v0/threads/'.length))
          return Response.json({ thread_id: id, messages: messages.filter(item => item.thread_id === id) })
        }
        return undefined
      })
      const disposers: (() => unknown)[] = []
      applyAgentmail({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      await vi.advanceTimersByTimeAsync(1000)
      const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()
      messages.push(message({ message_id: 'm1', thread_id: 't1', timestamp: at(2),
        authentication_results: 'spf=fail smtp.mailfrom=bob@example.test; dkim=none; dmarc=fail' }))
      threads.push({ thread_id: 't1', timestamp: at(2), last_message_id: 'm1', message_count: 1 })
      await vi.advanceTimersByTimeAsync(61_000)
      expect(h.receive).not.toHaveBeenCalled() // failed mail is skipped
      expect(h.health.agentmail).toMatchObject({ state: 'ready', detail: expect.stringContaining('1 unauthenticated messages skipped') })
      const passed = message({ message_id: 'm2', thread_id: 't2', timestamp: at(62),
        authentication_results: 'spf=pass smtp.mailfrom=bob@example.test; dkim=pass; dmarc=pass' })
      messages.push(passed)
      threads.push({ thread_id: 't2', timestamp: at(62), last_message_id: 'm2', message_count: 1 })
      await vi.advanceTimersByTimeAsync(61_000)
      expect(h.receive).toHaveBeenCalledTimes(1) // passing mail is received
      for (const dispose of disposers) await dispose()
      await h.stop()
    } finally { vi.useRealTimers() }
  })

  it('skips mail from senders outside the whitelist while still advancing the thread cursor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const threads: { thread_id: string; timestamp: string; last_message_id: string; message_count: number; subject?: string }[] = []
      const messages: AgentmailMessage[] = []
      const h = host({}, url => {
        if (url.pathname === `/v0/inboxes/${INBOX}/threads`) return Response.json({ threads })
        if (url.pathname.startsWith('/v0/threads/')) {
          const id = decodeURIComponent(url.pathname.slice('/v0/threads/'.length))
          return Response.json({ thread_id: id, messages: messages.filter(item => item.thread_id === id) })
        }
        return undefined
      })
      // The whitelist names only Bob; the saved config carries it to the poll loop through the Source's settings.
      const whitelisted = SettingsSchema.parse({ ...h.store.settings(),
        sources: { agentmail: { enabled: true, config: { apiKey: 'test-key', inboxId: INBOX, failuresBeforeError: 2, senders: [{ address: 'bob@example.test' }] } } } })
      h.store.saveSettings(whitelisted)
      const disposers: (() => unknown)[] = []
      applyAgentmail({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      await vi.advanceTimersByTimeAsync(1000)
      const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()
      messages.push(message({ message_id: 'm1', thread_id: 't1', timestamp: at(2) }))
      threads.push({ thread_id: 't1', timestamp: at(2), last_message_id: 'm1', message_count: 1 })
      await vi.advanceTimersByTimeAsync(61_000)
      expect(h.receive).toHaveBeenCalledTimes(1) // Bob's mail is received
      const secondAt = at(62)
      messages.push(message({ message_id: 'm2', thread_id: 't1', from: 'someone@else.test', timestamp: secondAt }))
      threads[0] = { ...threads[0]!, timestamp: secondAt, last_message_id: 'm2', message_count: 2 }
      await vi.advanceTimersByTimeAsync(61_000)
      expect(h.receive).toHaveBeenCalledTimes(1) // the stranger's mail is not, and the cursor moved on
      expect(h.state.get(KV.agentmail.thread('t1'))).toEqual({ lastMessageId: 'm2', lastAt: secondAt })
      for (const dispose of disposers) await dispose()
      await h.stop()
    } finally { vi.useRealTimers() }
  })

  it('lists one admission row for the inbox where any sender writing to it is a candidate', () => {
    const rows = agentmailKind.policy!.rows!({})
    expect(rows).toEqual([{ id: 'inbox', note: expect.anything(), label: expect.anything(),
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }])
  })

  it('names the watched inbox and the ticket\'s sender in the execution environment', () => {
    const trigger = agentmailTrigger(message(), INBOX)!
    const values = agentmailKind.environment!.values({ deployment: testDeployment({ agentmail: { apiKey: 'k', inboxId: INBOX } }), trigger, config: agentmailKind.schema.parse({}) })
    expect(values).toEqual({ DSH_SUPERAGENT_AGENTMAIL_INBOX: INBOX, DSH_SUPERAGENT_AGENTMAIL_FROM: 'bob@example.test' })
    const elsewhere = agentmailKind.environment!.values({ deployment: testDeployment({ agentmail: { apiKey: 'k', inboxId: INBOX } }),
      trigger: { ...trigger, source: 'github' }, config: agentmailKind.schema.parse({}) })
    expect(elsewhere.DSH_SUPERAGENT_AGENTMAIL_FROM).toBe('')
  })

  it('polls the inbox for updated threads, reads each thread\'s new messages once, and skips its own outgoing mail', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const threads: { thread_id: string; timestamp: string; last_message_id: string; message_count: number; subject?: string }[] = []
      const read: string[] = []
      const messages: AgentmailMessage[] = []
      const h = host({}, url => {
        if (url.pathname === `/v0/inboxes/${INBOX}/threads`) return Response.json({ threads })
        if (url.pathname.startsWith('/v0/threads/')) {
          const id = decodeURIComponent(url.pathname.slice('/v0/threads/'.length))
          read.push(id)
          return Response.json({ thread_id: id, messages: messages.filter(item => item.thread_id === id) })
        }
        return undefined
      })
      const add = (overrides: Partial<AgentmailMessage>) => { const item = message(overrides); messages.push(item); return item }
      const disposers: (() => unknown)[] = []
      applyAgentmail({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      // The first round starts from now, so older mail stays unread; a message added afterwards is read on the next round.
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.health.agentmail).toMatchObject({ state: 'ready' })
      expect(h.receive).not.toHaveBeenCalled()
      const first = add({ message_id: 'm1', thread_id: 't1', timestamp: new Date(Date.now() + 2000).toISOString(), subject: 'Fix the login' })
      threads.push({ thread_id: 't1', timestamp: first.timestamp, last_message_id: 'm1', message_count: 1, subject: 'Fix the login' })
      await vi.advanceTimersByTimeAsync(61_000)
      expect(h.receive).toHaveBeenCalledTimes(1)
      expect(h.receive.mock.calls[0]![0]).toMatchObject({ id: agentmailTriggerId('m1'), text: 'Please fix the login', actor: { id: 'bob@example.test' } })
      expect(read).toEqual(['t1'])
      // An unchanged thread list is not re-read, and the inbox's own mail creates no trigger while still advancing the cursor.
      await vi.advanceTimersByTimeAsync(61_000)
      expect(read).toEqual(['t1'])
      expect(h.receive).toHaveBeenCalledTimes(1)
      add({ message_id: 'own1', thread_id: 't1', from: INBOX, timestamp: new Date(Date.now() + 120_000).toISOString() })
      threads[0] = { ...threads[0]!, timestamp: messages.at(-1)!.timestamp, last_message_id: 'own1', message_count: 2 }
      await vi.advanceTimersByTimeAsync(61_000)
      expect(read).toEqual(['t1', 't1'])
      expect(h.receive).toHaveBeenCalledTimes(1)
      // A second message on the thread arrives as its own trigger.
      const second = add({ message_id: 'm2', thread_id: 't1', timestamp: new Date(Date.now() + 180_000).toISOString() })
      threads[0] = { ...threads[0]!, timestamp: second.timestamp, last_message_id: 'm2', message_count: 3 }
      await vi.advanceTimersByTimeAsync(61_000)
      expect(h.receive).toHaveBeenCalledTimes(2)
      await disposers[0]?.()
      await h.stop()
    } finally { vi.useRealTimers() }
  })

  it('waits for setup, pauses while the Source is off, and counts only consecutive failed polls towards an error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const start = async (overrides: Partial<SourceContextDeps>, enabled: boolean) => {
        const settings = SettingsSchema.parse({ sources: { agentmail: { enabled, config: { apiKey: 'test-key', inboxId: INBOX, failuresBeforeError: 2 } } } })
        const board = new HealthBoard()
        const sources = new SourceRegistry(() => settings, board)
        healthOf.set(sources, board)
        const value = host({ sources, ...overrides })
        const disposers: (() => unknown)[] = []
        applyAgentmail({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
        return { value, stop: async () => { for (const dispose of disposers) await dispose(); value.stop() } }
      }
      const pending = await start({ configured: () => false, deployment: testDeployment() }, true)
      await vi.waitFor(() => expect(pending.value.health.agentmail).toMatchObject({ state: 'paused', code: 'setupPending' }))
      await pending.stop()
      const off = await start({ deployment: testDeployment() }, false)
      await vi.waitFor(() => expect(off.value.health.agentmail).toMatchObject({ state: 'paused', code: 'sourceOff' }))
      await off.stop()
      const unset = await start({ deployment: testDeployment() }, true)
      await vi.waitFor(() => expect(unset.value.health.agentmail).toMatchObject({ state: 'paused', code: 'agentmailUnset' }))
      await unset.stop()
      // Rounds fail, succeed, fail, fail: only the last two in a row make the error.
      let round = 0
      const outcomes = [false, true, false, false]
      const flaky = host({ deployment: testDeployment({ agentmail: { apiKey: 'test-key', inboxId: INBOX } }) }, url => {
        if (url.pathname === `/v0/inboxes/${INBOX}/threads`) {
          round += 1
          if (!outcomes[round - 1]) return new Response('{}', { status: 502 })
          return Response.json({ threads: [] })
        }
        return undefined
      })
      const disposers: (() => unknown)[] = []
      applyAgentmail({ orchestrator: flaky, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      // Each round reads the thread list once, then waits a minute for the next.
      const until = async (count: number) => {
        while (round < count) {
          await vi.waitFor(() => expect(round).toBeGreaterThan(0))
          if (round < count) await vi.advanceTimersByTimeAsync(60_000)
        }
      }
      await until(3)
      expect(flaky.health.agentmail).toMatchObject({ state: 'ready' })
      await until(4)
      await vi.waitFor(() => expect(flaky.health.agentmail).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '2' } }))
      for (const dispose of disposers) await dispose()
      await flaky.stop()
    } finally { vi.useRealTimers() }
  })

  it('counts failures with the same threshold helper the GitHub poll uses', () => {
    expect(pollFailure(1, 2, new Error('x'))).toBeUndefined()
    expect(pollFailure(2, 2, new Error('x'))).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '2', error: 'Error: x' } })
  })

  it('orders the Source cards GitHub, Mattermost, AgentMail whatever way the kinds registered', () => {
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
    sources.register(agentmailKind); sources.register(mattermostKind); sources.register(githubKind)
    expect(sources.instances().map(instance => instance.kind)).toEqual(['github', 'mattermost', 'agentmail'])
  })

  it('labels each polled thread with its subject', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = host({}, url => {
        if (url.pathname === `/v0/inboxes/${INBOX}/threads`) return Response.json({ threads: [{ thread_id: 't1', timestamp: new Date().toISOString(),
          last_message_id: 'm1', message_count: 1, subject: 'Fix the login' }] })
        if (url.pathname === '/v0/threads/t1') return Response.json({ thread_id: 't1', messages: [message({ message_id: 'm1', timestamp: new Date().toISOString() })] })
        return undefined
      })
      const disposers: (() => unknown)[] = []
      applyAgentmail({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      await vi.advanceTimersByTimeAsync(61_000)
      const thread = h.store.threads.get('agentmail:t1')
      expect(thread?.meta.label).toBe('Fix the login')
      for (const dispose of disposers) await dispose()
      await h.stop()
    } finally { vi.useRealTimers() }
  })
})
