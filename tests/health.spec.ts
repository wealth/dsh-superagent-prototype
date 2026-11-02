/** Runtime health reporting: per-component error states and recovery on subsequent success. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { failure, mattermost, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** Advance fake `Date.now()` by `ms` and pump due runtime work. */
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
}
/** Retry a failed effect until it failed three times, after which its kind reports an error. */
async function failThrice() { await at(2000); await at(6000) }

it('reports a relay in error once it failed three times, clears it once the relay reached the main Session, and leaves the runtime ready', async () => {
  const steer = h.agents.get(h.runtime.masterId)!.steer
  for (let count = 0; count < 3; count++) steer.mockImplementationOnce(() => { throw new Error('session busy') })
  h.runtime.sessions.relay('r1', JSON.stringify({ kind: 'note' }))
  await h.runtime.idle()
  expect(h.runtime.health.relay).toMatchObject({ state: 'ready', detail: expect.stringContaining('1 waiting') })
  await failThrice()
  expect(h.runtime.health.relay).toMatchObject({ state: 'error', detail: expect.stringContaining('session busy') })
  await at(14_000)
  expect(h.runtime.health).toMatchObject({ relay: { state: 'ready', detail: 'Nothing waiting' }, runtime: { state: 'ready' } })
})

it('keeps a failing relay\'s error while replies recover, and a failing reply\'s error while relays recover', async () => {
  const master = h.agents.get(h.runtime.masterId)!
  const reply = (id: string) => { h.runtime.outbox.send({ id, channel: mattermost('9', 'x').channel!, text: '已合并。', kind: 'notice' }) }
  master.steer.mockImplementation(() => { throw new Error('master gone') })
  h.runtime.sessions.relay('r2', JSON.stringify({ kind: 'note' }))
  failure.posts = true
  reply('stuck')
  // Each fails three times in a row: the relay after 0, 2 and 6 seconds, the reply after 0, 5 and 15.
  await h.runtime.idle(); await at(5000); await at(15_000)
  expect(h.runtime.health).toMatchObject({ relay: { state: 'error' }, reply: { state: 'error', detail: expect.stringContaining('2200') } })
  failure.posts = false
  await at(35_000)
  expect(h.runtime.health).toMatchObject({ relay: { state: 'error' }, reply: { state: 'ready' } })
  failure.posts = true
  reply('stuck-2')
  master.steer.mockImplementation(() => {})
  await h.runtime.idle(); await at(50_000); await at(70_000)
  expect(h.runtime.health).toMatchObject({ relay: { state: 'ready' }, reply: { state: 'error' }, runtime: { state: 'ready' } })
})

it('reports a notice the main Session did not receive three times, until one reaches it, and injects each notice once', async () => {
  const inject = h.agents.get(h.runtime.masterId)!.inject
  for (let count = 0; count < 3; count++) inject.mockImplementationOnce(() => { throw new Error('session busy') })
  await h.runtime.settings.pause(true, 'panel')
  await failThrice()
  expect(h.runtime.health.notice).toMatchObject({ state: 'error', detail: expect.stringContaining('session busy') })
  inject.mockClear()
  await h.runtime.settings.pause(false, 'panel')
  expect(h.runtime.health).toMatchObject({ notice: { state: 'ready' }, runtime: { state: 'ready' } })
  // The waiting pause notice was updated in place by the resume value and injected once.
  // The stand also saves its policy, which injects its own notice; only the pause notice is counted here.
  const pauses = inject.mock.calls.map(([message]) => message).filter(message => String(message.id).includes(':settings:pause:'))
  expect(pauses).toHaveLength(1)
})
