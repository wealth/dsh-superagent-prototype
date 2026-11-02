/** Concurrency, retry, and validation tests for settings saves, pause toggling, and policy synchronization. */
import { afterEach, expect, it, vi } from 'vitest'
import { UserError } from '../src/core/index.ts'
import { Setup } from '../src/app/setup.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

/** Members the fake Mattermost channel answers with; a test sets `members.next` to `Error`s or lists to change the next read. */
const members = { reply: vi.fn<() => Promise<{ members: { user_id: string; delete_at: number }[]; users: { id: string; username: string }[] }>>() }
/** Makes the next member read answer `users`, as Mattermost does: the channel's members, then the users' names. */
function answerMembers(users: { id: string; username: string }[]) {
  members.reply.mockImplementationOnce(async () => ({ members: users.map(user => ({ user_id: user.id, delete_at: 0 })), users }))
}
/** The sync reads the member list first and the users' names second; one read of `members.reply` serves both. */
let lastRead: { members: { user_id: string; delete_at: number }[]; users: { id: string; username: string }[] } | undefined
/** Installs the member stub after the stand starts, since the stand stubs `fetch` itself. */
function stubMembers() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (path.endsWith('/members')) { lastRead = await members.reply(); return json(lastRead.members) }
    if (path === '/api/v4/users/ids') return json(lastRead?.users ?? [])
    return new Response('{}', { status: 404 })
  }))
}
afterEach(() => { vi.unstubAllGlobals(); members.reply.mockReset() })

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
const model = { provider: 'worker-provider', model: 'worker-model' }
const MEMBER_ID = 'user0000000000000000000001'
const NEW_ID = 'user0000000000000000000002'

it('refuses a save of a block that another save changed during its model or account check, and saves nothing of it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  const check = deferred<unknown>()
  llm.resolveCallConfig.mockImplementationOnce(() => check.promise)
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const slow = settings.save('executor', { ...executor, model, maxWorkers: 5 }, revision, 'panel')
  await settings.save('executor', { ...executor, maxWorkers: 2 }, revision, 'panel')
  check.resolve(model)
  await expect(slow).rejects.toThrow(SettingsConflict)
  expect(store.settings().executor).toMatchObject({ maxWorkers: 2, model: executor.model })
  // An account check that a save of the same Source outruns is refused the same way.
  const accounts = deferred<void>()
  vi.spyOn(Setup.prototype, 'checkAccounts').mockImplementationOnce(() => accounts.promise)
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const moved = settings.save('source:github', { ...value, config: { ...value.config, cli: '/opt/bin/gh-other' } }, github.revision,
    'panel')
  await settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 90 } }, github.revision, 'panel')
  accounts.resolve()
  await expect(moved).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.github!.config).toMatchObject({ cli: value.config.cli, pollSeconds: 90 })
})

it('refuses a Policy sync that a Policy save outran, reports it on sync:mattermost, and keeps the save', async () => {
  h = await startRuntime()
  stubMembers()
  const { settings, store } = h.runtime
  const reading = deferred<unknown>()
  members.reply.mockImplementationOnce(() => reading.promise)
  const syncing = settings.sync('mattermost')
  const policy = store.settings().policy
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
  await settings.save('policy', { ...policy, rules }, store.blockRevision('policy'), 'panel')
  reading.resolve({ members: [{ user_id: MEMBER_ID, delete_at: 0 }, { user_id: NEW_ID, delete_at: 0 }],
    users: [{ id: MEMBER_ID, username: 'alice' }, { id: NEW_ID, username: 'new' }] })
  await expect(syncing).rejects.toThrow(SettingsConflict)
  expect(h.runtime.health['sync:mattermost']).toMatchObject({ state: 'error',
    detail: expect.stringContaining('Policy changed during synchronization') })
  // The refused sync changed nothing: the listed person keeps the name the stand gave her.
  expect(store.settings().policy).toMatchObject({ rules, sources: { mattermost: { allowed: [{ id: MEMBER_ID, name: 'Alice' }] } } })
})

it('syncs a Policy part again after a failed sync, a minute later and then after a wait that doubles, until it succeeds', async () => {
  h = await startRuntime()
  stubMembers()
  const { settings } = h.runtime
  // The syncs the Runtime runs as it starts finish first.
  await vi.waitFor(() => expect(h!.runtime.health['sync:mattermost']).toMatchObject({ state: 'ready' }))
  await h.runtime.idle()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    members.reply.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
    await expect(settings.sync('mattermost')).rejects.toThrow('network down')
    expect(h.runtime.health['sync:mattermost']).toMatchObject({ state: 'error', detail: expect.stringContaining('network down') })
    const calls = () => members.reply.mock.calls.length
    const before = calls()
    await vi.advanceTimersByTimeAsync(60_000)
    // The first retry fails too, so the next waits two minutes.
    expect(calls()).toBe(before + 1)
    answerMembers([{ id: MEMBER_ID, username: 'alice' }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h!.runtime.health['sync:mattermost']).toMatchObject({ state: 'ready' }))
    expect(calls()).toBe(before + 2)
    // A success ends the retries.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls()).toBe(before + 2)
  } finally { vi.useRealTimers() }
})
it('records nothing for a pause that changes nothing, refuses a sync while setup waits, and names an unknown block', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('pause')
  const inject = h.agents.get(h.runtime.masterId)!.inject
  inject.mockClear()
  expect(await settings.pause(false, 'panel')).toEqual({ paused: false })
  await h.runtime.idle()
  expect([store.blockRevision('pause'), inject.mock.calls.length, h.runtime.effects.pending('notice')]).toEqual([revision, 0, false])
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(false)
  await expect(settings.sync('mattermost')).rejects.toThrow(new UserError('nothingToSync', { source: 'mattermost' }))
  vi.mocked(Setup.prototype.configured).mockRestore()
  expect(() => settings.block('source:x')).toThrow(new UserError('unknownBlock', { block: 'source:x' }))
})
