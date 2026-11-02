import { expect, it, vi } from 'vitest'
import { admissionContext, threadWindow } from '../src/sources/admission-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { mattermostKind } from '../src/sources/mattermost.ts'
import type { ContextMessage } from '../src/sources/kind.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import { testDeployment } from './fixtures/deployment.ts'
import type { Trigger } from '../src/core/index.ts'
const message = (index: number): ContextMessage => ({ id: `om_${index}`, from: 'ou_user', at: String(index), text: `Message ${index}` })
/** The same message as a Feishu topic page lists it. */
const listed = (index: number) => ({ message_id: `om_${index}`, chat_id: 'oc_chat', content: `Message ${index}`, msg_type: 'text',
  sender: { id: 'ou_user', sender_type: 'user' }, create_time: String(index) })
it('returns the thread opening and trigger neighbors with exact internal and trailing gaps', () => {
  const result = threadWindow(Array.from({ length: 40 }, (_, i) => message(i)), 'om_25')
  expect(result.entries.map((item: { position: number }) => item.position)).toEqual([1, 2, 3, 4, 5, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31])
  expect(result.entries[5]?.omitted_before).toBe(15)
  expect(result.omitted_after).toBe(9)
  expect(result.source_found).toBe(true)
})
it('deduplicates overlapping windows and reports an absent source without inventing neighbors', () => {
  const messages = Array.from({ length: 12 }, (_, i) => message(i))
  expect(threadWindow(messages, 'om_3').entries.map((item: { position: number }) => item.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(threadWindow(messages, 'om_absent')).toMatchObject({ source_found: false, loaded_messages: 12, omitted_after: 7 })
})
it('retains pagination limits and exact loaded counts rather than claiming complete history', async () => {
  const bot = testDeployment().mattermost!
  const post = (n: number) => ({ id: `p${n}`, channel_id: 'c1000000000000000000000000', user_id: 'u1000000000000000000000001',
    message: `Message ${n}`, create_at: 1757376000000 + n * 1000, root_id: 'proot0000000000000000000001', delete_at: 0, type: '' })
  const ids = ['p9', 'p8']
  const fetch = vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (path === '/api/v4/posts/proot0000000000000000000001/thread') return json({ order: ids, posts: { p9: post(9), p8: post(8) } })
    if (path === '/api/v4/users/ids') return json([{ id: 'u1000000000000000000000001', username: 'alice' }])
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  const trigger: Trigger = { id: 'event', source: 'mattermost', threads: [{ source: 'mattermost', id: 'c1000000000000000000000000:proot0000000000000000000001' }],
    actor: { source: 'mattermost', id: 'u1000000000000000000000001' }, human: true, text: 'Trigger', at: '', channel: undefined as never,
    meta: { channelId: 'c1000000000000000000000000', postId: 'p9', direct: false, mentioned: false, rootId: 'proot0000000000000000000001' } }
  const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { mattermost: { enabled: true, config: { readPageSize: 2 } } } }))
  sources.register(mattermostKind)
  const result = await admissionContext(sources.threadContext(trigger)!, new Commands(() => testDeployment(), {}, new AbortController().signal), 1)
  expect(result).toMatchObject({ complete: false, window: { loaded_messages: 2, source_found: true } })
  // The next page continues from the oldest post of the loaded page.
  expect(result.next).toBe('p8')
  expect(fetch).toHaveBeenCalledTimes(2)
  vi.unstubAllGlobals()
})
it('reads the root post as the whole context when the trigger names no separate thread', async () => {
  const bot = testDeployment().mattermost!
  const root = { id: 'p0', channel_id: 'c1000000000000000000000000', user_id: 'u1000000000000000000000001',
    message: 'message 0', create_at: 1757376000000, root_id: '', delete_at: 0, type: '' }
  const fetch = vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (path === '/api/v4/posts/p0/thread') return json({ order: ['p0'], posts: { p0: root } })
    if (path === '/api/v4/posts/p0') return json(root)
    if (path === '/api/v4/users/ids') return json([{ id: 'u1000000000000000000000001', username: 'alice' }])
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  const trigger: Trigger = { id: 'event', source: 'mattermost', threads: [{ source: 'mattermost', id: 'c1000000000000000000000000:p0' }],
    actor: { source: 'mattermost', id: 'u1000000000000000000000001' }, human: true, text: 'message 0', at: new Date(1757376000000).toISOString(),
    channel: undefined as never, meta: { channelId: 'c1000000000000000000000000', postId: 'p0', direct: false, mentioned: false } }
  const sources = new SourceRegistry(() => SettingsSchema.parse({}))
  sources.register(mattermostKind)
  const result = await admissionContext(sources.threadContext(trigger)!, new Commands(() => testDeployment(), {}, new AbortController().signal), 3)
  expect(result).toMatchObject({ complete: true, window: { source_found: true, loaded_messages: 1 } })
  expect(result.messages.map(message => message.id)).toEqual(['p0'])
  vi.unstubAllGlobals()
})
