/** The Telegram source: trigger normalization, the long-poll loop, its policy part and environment. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { TelegramError, sendTelegram } from '../src/sources/telegram-channel.ts'
import { apply as applyTelegram, telegramKind } from '../src/sources/telegram.ts'
import { pollFailure, runTelegram } from '../src/sources/telegram-loops.ts'
import { SOURCE, telegramChannel, telegramRef, telegramTrigger, telegramTriggerId, type TelegramUpdate } from '../src/sources/telegram-trigger.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

const CHAT = 100
const USER = 200
/** A Telegram update from the operator carrying `text`, as the Bot API getUpdates returns it. */
const update = (id: number, text: string, overrides: Partial<TelegramUpdate['message']> = {}): TelegramUpdate =>
  ({ update_id: id, message: { message_id: id, date: 1_700_000_000 + id, chat: { id: CHAT },
    from: { id: USER, username: 'op', is_bot: false }, text, ...overrides } })

const healthOf = new WeakMap<SourceRegistry, HealthBoard>()
function host(overrides: Partial<SourceContextDeps> = {}, fetchRoutes: (url: URL, init: RequestInit | undefined) => Response | undefined = () => undefined) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'telegram-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({ eval: { mode: 'auto' }, sources: { telegram: { enabled: true, config: { botToken: 'test-token', failuresBeforeError: 2, senders: [{ id: String(USER) }] } } },
    policy: { sources: { telegram: { allowed: [{ id: String(USER), name: 'Op' }] } } } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  healthOf.set(sources, board)
  const deployment = testDeployment({ telegram: { token: 'test-token', botId: 5, username: 'dsh_bot' } })
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
  const context = sourceContextOf(parts, { kind: SOURCE, health: ['telegram'] })
  return { ...value, ...context, health: healthOf.get(parts.sources as SourceRegistry)!.all, store, receive, commands, fetchSpy,
    stop: async () => { fetchSpy.mockRestore(); store.close() } }
}

describe('telegram source', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('turns a text message from a user into a trigger addressed to the agent, and skips the bot and non-text', () => {
    const trigger = telegramTrigger(update(7, 'Почини регресс'), 5)!
    expect(trigger).toMatchObject({ source: SOURCE, id: telegramTriggerId(7), human: true, addressed: 'direct',
      actor: { id: String(USER) }, text: 'Почини регресс' })
    expect(trigger.threads).toEqual([{ source: SOURCE, id: String(CHAT) }])
    expect(trigger.channel).toEqual(telegramChannel(String(CHAT), '7'))
    expect(telegramTrigger(update(8, 'служебное', { from: { id: 5, is_bot: true } }), 5)).toBeUndefined()
    expect(telegramTrigger({ update_id: 10, message: undefined }, 5)).toBeUndefined()
    expect(telegramTrigger(update(11, ''), 5)).toBeUndefined()
    expect(telegramRef(trigger)).toEqual({ triggerId: telegramTriggerId(7), chatId: String(CHAT), messageId: '7', at: trigger.at })
  })

  it('answers in the chat through sendMessage, and calls an unreachable chat gone', async () => {
    const sent: { method: string; body?: unknown }[] = []
    let refuse = false
    const h = host({}, (url, init) => {
      if (init?.method === 'POST' && url.pathname.endsWith('/sendMessage')) {
        if (refuse) return new Response('{}', { status: 403 })
        sent.push({ method: 'sendMessage', body: JSON.parse(String(init.body)) })
        return Response.json({ ok: true, result: { message_id: 900 } })
      }
      return new Response('{}', { status: 404 })
    })
    const outcome = await sendTelegram(h, { id: key('ack', 'trigger-1'), kind: 'reply', channel: telegramChannel(String(CHAT), '7'), text: '收到，修复回归。' } as never)
    expect(outcome).toBe('sent')
    expect(sent[0]).toMatchObject({ body: { chat_id: String(CHAT), text: '收到，修复回归。' } })
    refuse = true
    await expect(sendTelegram(h, { id: 'k', kind: 'reply', channel: telegramChannel(String(CHAT), '7'), text: 'x' } as never)).resolves.toBe('gone')
    await h.stop()
  })

  it('admits chat messages and searches Threads by their key', () => {
    const config = telegramKind.schema.parse({ botToken: 'k' })
    expect(telegramKind.scope!.call(telegramKind, { meta: {} }, config)).toEqual({ listened: true, observed: false, row: 'chats' })
    expect(telegramKind.channel!.allowed).toBeUndefined()
    expect(telegramKind.find!('telegram:100')).toEqual({ threads: ['telegram:100'], terms: [] })
    expect(telegramKind.find!('где баг')).toEqual({ threads: [], terms: [] })
  })

  it('long-polls updates, receives only whitelisted senders, and advances the offset', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = host({}, url => {
        if (!url.pathname.endsWith('/getUpdates')) return undefined
        const offset = url.searchParams.get('offset')
        const updates = offset ? [] : [update(7, 'Почини регресс'), update(8, 'другое', { from: { id: 999, username: 'stranger', is_bot: false } })]
        return Response.json({ ok: true, result: updates })
      })
      const disposers: (() => unknown)[] = []
      applyTelegram({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.receive).toHaveBeenCalledTimes(1)
      expect(h.receive.mock.calls[0]![0]).toMatchObject({ id: telegramTriggerId(7), actor: { id: String(USER) } })
      expect(h.state.get((await import('../src/kv.ts')).KV.telegram.offset)).toBe(9)
      expect(h.health.telegram).toMatchObject({ state: 'ready' })
      // The offset moved on, so the next poll returns nothing new and the stranger stays unreceived.
      await vi.advanceTimersByTimeAsync(2000)
      expect(h.receive).toHaveBeenCalledTimes(1)
      for (const dispose of disposers) await dispose()
      await h.stop()
    } finally { vi.useRealTimers() }
  })

  it('waits for setup, pauses while the Source is off, and counts consecutive failed polls towards an error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const start = async (overrides: Partial<SourceContextDeps>, enabled: boolean, outcome: 'ok' | 'fail' | 'unauthorized') => {
        const settings = SettingsSchema.parse({ sources: { telegram: { enabled, config: { botToken: 'test-token', failuresBeforeError: 2 } } } })
        const board = new HealthBoard()
        const sources = new SourceRegistry(() => settings, board)
        healthOf.set(sources, board)
        const value = host({ sources, ...overrides }, url => {
          if (!url.pathname.endsWith('/getUpdates')) return undefined
          return outcome === 'ok' ? Response.json({ ok: true, result: [] }) : outcome === 'fail' ? new Response('{}', { status: 502 })
            : Response.json({ ok: false }, { status: 401 })
        })
        const disposers: (() => unknown)[] = []
        applyTelegram({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
        return { value, stop: async () => { for (const dispose of disposers) await dispose(); value.stop() } }
      }
      const pending = await start({ configured: () => false, deployment: testDeployment() }, true, 'ok')
      await vi.waitFor(() => expect(pending.value.health.telegram).toMatchObject({ state: 'paused', code: 'setupPending' }))
      await pending.stop()
      const off = await start({ deployment: testDeployment() }, false, 'ok')
      await vi.waitFor(() => expect(off.value.health.telegram).toMatchObject({ state: 'paused', code: 'sourceOff' }))
      await off.stop()
      // Long polls fail, succeed, fail, fail: only the last two in a row make the error.
      let round = 0
      const outcomes = ['fail', 'ok', 'fail', 'fail'] as const
      const flaky = host({ deployment: testDeployment({ telegram: { token: 'test-token', botId: 5, username: 'dsh_bot' } }) }, url => {
        if (!url.pathname.endsWith('/getUpdates')) return undefined
        const outcome = outcomes[Math.min(round++, 3)]
        return outcome === 'ok' ? Response.json({ ok: true, result: [] }) : new Response('{}', { status: 502 })
      })
      const disposers: (() => unknown)[] = []
      applyTelegram({ orchestrator: flaky, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      const until = async (count: number) => {
        while (round < count) {
          await vi.waitFor(() => expect(round).toBeGreaterThan(0))
          if (round < count) await vi.advanceTimersByTimeAsync(6000)
        }
      }
      await until(3)
      expect(flaky.health.telegram).toMatchObject({ state: 'ready' })
      await until(4)
      await vi.waitFor(() => expect(flaky.health.telegram).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '2' } }))
      for (const dispose of disposers) await dispose()
      await flaky.stop()
    } finally { vi.useRealTimers() }
  })

  it('counts failures with the shared threshold helper', () => {
    expect(pollFailure(1, 2, new Error('x'))).toBeUndefined()
    expect(pollFailure(2, 2, new Error('x'))).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '2', error: 'Error: x' } })
  })
})
