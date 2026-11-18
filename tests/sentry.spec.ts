/** The Sentry/GlitchTip source: issue triggers, the issues poll loop, its policy part, environment and resolver probe. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { apply as applySentry, sentryKind, resolveSentry } from '../src/sources/sentry.ts'
import { pollFailure } from '../src/sources/sentry-loops.ts'
import { KV } from '../src/kv.ts'
import { IssueSchema, sentryRef, sentryTrigger, sentryTriggerId, SOURCE, type SentryIssue } from '../src/sources/sentry-trigger.ts'
import { sentryThreadContext } from '../src/sources/sentry-read.ts'
import { sentryFetch } from '../src/sources/sentry-api.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SetupError } from '../src/setup.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

const URL_ = 'https://glitchtip.test'
const ORG = 'acme'
const ACCOUNT = { url: URL_, orgSlug: ORG, authToken: 'sentry-token' }

const issue = (overrides: Partial<SentryIssue> = {}): SentryIssue =>
  ({ id: '42', shortId: 'WEB-7', title: 'TypeError: x is not a function', culprit: 'web/app.js in submit',
    firstSeen: '2026-09-02T00:00:00Z', lastSeen: '2026-09-02T01:00:00Z', count: 12, userCount: 3, level: 'error',
    status: 'unresolved', permalink: undefined, project: { id: '2', slug: 'web', name: 'Web' }, ...overrides })

/** A host whose Sentry account and issues polling the fake API serves; rounds are driven by fake timers. */
const healthOf = new WeakMap<SourceRegistry, HealthBoard>()
function host(overrides: Partial<SourceContextDeps> = {}, fetchRoutes: (url: URL, init: RequestInit | undefined) => Response | undefined = () => undefined) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sentry-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({ eval: { mode: 'auto' }, sources: { sentry: { enabled: true, config: { url: URL_, orgSlug: ORG, authToken: 'sentry-token', pollSeconds: 60, failuresBeforeError: 2 } } } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  healthOf.set(sources, board)
  const deployment = testDeployment({ sentry: ACCOUNT })
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
  const context = sourceContextOf(parts, { kind: SOURCE, health: ['sentry'] })
  return { ...value, ...context, health: healthOf.get(parts.sources as SourceRegistry)!.all, store, receive, commands, fetchSpy,
    stop: async () => { fetchSpy.mockRestore(); store.close() } }
}

describe('sentry source', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('turns an issue into a senderless observation trigger, and links its page', () => {
    const trigger = sentryTrigger(issue(), ACCOUNT)
    expect(trigger).toMatchObject({ source: SOURCE, id: sentryTriggerId('42'), human: false,
      at: '2026-09-02T00:00:00Z', url: 'https://glitchtip.test/organizations/acme/issues/42/' })
    expect(trigger.actor).toEqual({ source: SOURCE, id: '' })
    expect(trigger.threads).toEqual([{ source: SOURCE, id: '42' }])
    expect(trigger.channel).toBeUndefined()
    expect(trigger.text).toContain('TypeError: x is not a function')
    expect(trigger.text).toContain('в проекте web')
    expect(trigger.text).toContain('12 событий')
    expect(trigger.meta).toMatchObject({ kind: 'issue', issueId: '42', shortId: 'WEB-7', project: 'web', level: 'error', count: 12, userCount: 3 })
    expect(sentryRef(trigger)).toEqual({ issueId: '42' })
    expect(sentryRef({ ...trigger, source: 'github' })).toBeUndefined()
  })

  it('prefers the API\'s permalink over the composed issue URL', () => {
    expect(sentryTrigger(issue({ permalink: 'https://glitchtip.test/acme/web/issues/42/' }), ACCOUNT).url).toBe('https://glitchtip.test/acme/web/issues/42/')
    expect(sentryTrigger(IssueSchema.parse({ ...issue(), count: '123' }), ACCOUNT).meta.count).toBe(123)
  })

  it('reads the latest events of the issue as thread context, and nothing for other parts', async () => {
    const h = host({}, url => {
      if (url.pathname !== `/api/0/issues/42/events/`) return undefined
      return Response.json([{ id: 'e2', message: 'TypeError: x is not a function', culprit: 'web/app.js in submit',
        dateCreated: '2026-09-02T01:00:00Z', userCount: 1, level: 'error', metadata: { type: 'TypeError', value: 'x is not a function' } },
        { id: 'e1', dateCreated: '2026-09-02T00:00:00Z', metadata: { type: 'SyntaxError', value: 'unexpected token' } }])
    })
    const trigger = sentryTrigger(issue(), ACCOUNT)
    expect(sentryThreadContext.messageId(trigger)).toBe('42')
    const thread = await sentryThreadContext.read(h.commands, trigger, 'thread', undefined, { readPageSize: 20 })
    expect(thread.messages).toEqual([
      { id: 'e2', from: 'web/app.js in submit', at: '2026-09-02T01:00:00Z', text: 'TypeError: x is not a function' },
      { id: 'e1', from: 'SyntaxError', at: '2026-09-02T00:00:00Z', text: 'SyntaxError: unexpected token' }])
    const other = await sentryThreadContext.read(h.commands, trigger, 'parent', undefined, { readPageSize: 20 })
    expect(other.status).toBe('no_parent')
    await h.stop()
  })

  it('rejects requests without a working account', async () => {
    await expect(sentryFetch({ url: URL_, orgSlug: ORG, authToken: '' }, '/issues/42/')).rejects.toThrow()
  })

  it('admits every project while enabled, and searches Threads by their key', () => {
    const config = sentryKind.schema.parse({ url: URL_, orgSlug: ORG, authToken: 'k' })
    expect(sentryKind.scope!.call(sentryKind, { meta: { project: 'web' } }, config)).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(sentryKind.find!('sentry:42')).toEqual({ threads: ['sentry:42'], terms: [] })
    expect(sentryKind.find!('WEB-7')).toEqual({ threads: [], terms: [] })
  })

  it('receives only the whitelisted projects once the list names any, case-insensitively', () => {
    const config = sentryKind.schema.parse({ url: URL_, orgSlug: ORG, authToken: 'k', projects: [{ slug: 'Web' }] })
    expect(sentryKind.scope!.call(sentryKind, { meta: { project: 'WEB' } }, config)).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(sentryKind.scope!.call(sentryKind, { meta: { project: 'api' } }, config))
      .toEqual({ listened: false, reason: 'project_not_listened' })
    expect(() => sentryKind.schema.parse({ url: URL_, orgSlug: ORG, authToken: 'k', projects: [{ slug: 'not a slug' }] })).toThrow()
  })

  it('lists one admission row for issues, which the Policy admission table decides', () => {
    const rows = sentryKind.policy!.rows!({})
    expect(rows).toEqual([{ id: 'issues', note: expect.anything(), label: expect.anything(),
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true } }])
  })

  it('names the watched project, short id and page link in the execution environment', () => {
    const trigger = sentryTrigger(issue(), ACCOUNT)
    const values = sentryKind.environment!.values({ deployment: testDeployment({ sentry: ACCOUNT }), trigger, config: sentryKind.schema.parse({}) })
    expect(values).toEqual({ DSH_SUPERAGENT_SENTRY_PROJECT: 'web', DSH_SUPERAGENT_SENTRY_ISSUE: 'WEB-7', DSH_SUPERAGENT_SENTRY_URL: 'https://glitchtip.test/organizations/acme/issues/42/' })
    const elsewhere = sentryKind.environment!.values({ deployment: testDeployment({ sentry: ACCOUNT }),
      trigger: { ...trigger, source: 'github' }, config: sentryKind.schema.parse({}) })
    expect(elsewhere.DSH_SUPERAGENT_SENTRY_PROJECT).toBe('')
  })

  it('polls the issues endpoint for issues first seen since the cursor, and skips unlisted projects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const issues: SentryIssue[] = []
      const h = host({}, url => {
        if (url.pathname !== `/api/0/organizations/${ORG}/issues/`) return undefined
        expect(url.searchParams.get('query')).toBe('is:unresolved')
        return Response.json(issues)
      })
      const add = (overrides: Partial<SentryIssue>) => { const item = issue(overrides); issues.push(item); return item }
      const disposers: (() => unknown)[] = []
      applySentry({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      await vi.advanceTimersByTimeAsync(1000)
      // The first round starts from now, so older issues stay unread; an issue first seen afterwards is received next round.
      const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()
      add({ id: '42', firstSeen: at(2) })
      await vi.advanceTimersByTimeAsync(61_000)
      expect(h.receive).toHaveBeenCalledTimes(1)
      expect(h.receive.mock.calls[0]![0]).toMatchObject({ id: sentryTriggerId('42') })
      expect(h.health.sentry).toMatchObject({ state: 'ready', detail: expect.stringContaining('1 new') })
      // An unlisted project's new issue is skipped, and the cursor still advances.
      const only = SettingsSchema.parse({ ...h.store.settings(),
        sources: { sentry: { enabled: true, config: { url: URL_, orgSlug: ORG, authToken: 'sentry-token', pollSeconds: 60, failuresBeforeError: 2, projects: [{ slug: 'web' }] } } } })
      h.store.saveSettings(only)
      add({ id: '43', project: { id: '3', slug: 'api', name: 'API' }, firstSeen: at(62) })
      await vi.advanceTimersByTimeAsync(61_000)
      expect(h.receive).toHaveBeenCalledTimes(1)
      expect(h.state.get(KV.sentry.since)).toBeTruthy()
      for (const dispose of disposers) await dispose()
      await h.stop()
    } finally { vi.useRealTimers() }
  })

  it('reports an error health once consecutive polls fail, and retries sooner while failing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const h = host({}, () => new Response('{}', { status: 503 }))
      const disposers: (() => unknown)[] = []
      applySentry({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.health.sentry).toMatchObject({ state: 'starting' }) // one failure is quiet
      await vi.advanceTimersByTimeAsync(61_000)
      expect(h.health.sentry).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: expect.any(String) } })
      for (const dispose of disposers) await dispose()
      await h.stop()
    } finally { vi.useRealTimers() }
  })

  it('returns an error health once `failures` reach the threshold', () => {
    expect(pollFailure(1, 2, new Error('boom'))).toBeUndefined()
    expect(pollFailure(2, 2, new Error('boom'))).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '2' } })
  })

  it('reads the Sentry-compatible account after checking the organization, or finds none when the Source names none', async () => {
    expect(await resolveSentry({ stateDir: '/tmp/x' } as never, {})).toBeUndefined()
    const respond = (status: number, body: object | string): typeof fetch => async (url, init) => {
      expect(url).toBe(`${URL_}/api/0/organizations/${ORG}/projects/`)
      expect(init?.headers).toEqual({ Authorization: 'Bearer sentry-token' })
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }
    expect(await resolveSentry({ stateDir: '/tmp/x' } as never, ACCOUNT, respond(200, []))).toEqual(ACCOUNT)
    const refuses = async (code: string, values: Record<string, unknown>, status: number, body: object | string) =>
      expect(resolveSentry({ stateDir: '/tmp/x' } as never, ACCOUNT, respond(status, body))).rejects.toEqual(setupError(code, values))
    await refuses('sentryUnauthorized', {}, 401, '{"detail":"Invalid token"}')
    await refuses('sentryOrgMissing', { org: ORG }, 404, '{"detail":"Not found"}')
    await refuses('sentryUnreachable', { url: URL_, output: 'HTTP 503' }, 503, 'boom')
  })
})

const setupError = (code: string, values: Record<string, unknown>) => {
  const error = new SetupError(code as never, values as never)
  return expect.objectContaining({ place: error.place, code: error.code, values: error.values })
}
