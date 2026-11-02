/** Mattermost background loops: the WebSocket event stream, subscribed-thread polling, and channel name refresh. */
import { z } from 'zod'
import { threadKey, type Thread, type Trigger } from '../core/index.ts'
import type { MattermostBot } from '../deployment.ts'
import { KV } from '../kv.ts'
import { health, type SourceContext } from './host.ts'
import { mattermostFetch } from './mattermost-channel.ts'
import { mattermostTrigger, PostSchema, SOURCE, type MattermostPost } from './mattermost-trigger.ts'
import { mattermostThreadPage } from './mattermost-read.ts'
import { pollThreads as pollEach } from './poll.ts'
import type { MattermostConfig } from './mattermost.ts'

export const runMattermost = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> =>
  Promise.allSettled([watch, pollLoop, channelNamesLoop].map(loop => loop(ctx, signal)))

const enabled = (ctx: SourceContext): MattermostConfig | undefined => ctx.config<MattermostConfig>(SOURCE)
const bot = (ctx: SourceContext): MattermostBot => {
  const resolved = ctx.deployment.mattermost
  if (!resolved) throw new Error('The Mattermost Source has no working bot')
  return resolved
}

/** Receives a Trigger and labels the Thread with its channel name and URL. */
async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  const channelId = String(trigger.meta.channelId ?? '')
  if (!channelId) return
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[channelId] ?? String(trigger.meta.channelName ?? channelId)
  const channel = trigger.meta.direct === true ? { value: { zh: '私信', en: 'Direct message', ru: 'Личные сообщения' } } : { value: name }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { url: channelLink(ctx, channelId), facts: { channel } })
}
const channelLink = (ctx: SourceContext, channelId: string): string => {
  const server = ctx.deployment.mattermost?.url
  return server ? `${server}/_redirect/channel/${encodeURIComponent(channelId)}` : ''
}
function available(ctx: SourceContext): boolean {
  if (ctx.configured() && ctx.deployment.mattermost) return true
  const waiting = health('paused', ctx.configured() ? 'mattermostUnset' : 'setupPending')
  ctx.report(SOURCE, ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}

/** Runs the WebSocket event stream only while the Source is enabled; disabling it stops the stream within five seconds. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) return
  let retry: number | undefined
  while (!signal.aborted) {
    if (!enabled(ctx)) {
      ctx.report(SOURCE, health('paused', 'sourceOff'))
      await sleep(5000, signal)
      continue
    }
    const running = new AbortController()
    const check = setInterval(() => { if (!enabled(ctx)) running.abort() }, 5000)
    const stop = () => running.abort()
    signal.addEventListener('abort', stop, { once: true })
    const began = Date.now()
    try { await consume(ctx, running.signal) }
    catch (error) { if (!running.signal.aborted) ctx.report(SOURCE, { state: 'error', detail: String(error) }) }
    finally { clearInterval(check); signal.removeEventListener('abort', stop) }
    if (running.signal.aborted) continue
    retry = consumerRetry(retry, Date.now() - began)
    await sleep(retry, signal)
  }
}
/** Wait before reconnecting: 1s after a connection that stayed up for a minute, otherwise exponential backoff up to 60s. */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)
const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
  if (signal.aborted) { resolve(); return }
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
  const stop = () => { clearTimeout(timer); resolve() }
  signal.addEventListener('abort', stop, { once: true })
})

/** One WebSocket session: authenticate with the bot token, then turn each `posted` event into a Trigger. */
async function consume(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const server = bot(ctx)
  const url = `${server.url.replace(/^http/, 'ws')}/api/v4/websocket`
  const socket = new WebSocket(url)
  let chain = Promise.resolve()
  let seq = 1
  await new Promise<void>((resolve, reject) => {
    const close = () => { socket.close(); resolve() }
    signal.addEventListener('abort', close, { once: true })
    socket.onopen = () => socket.send(JSON.stringify({ seq: seq++, action: 'authentication_challenge', data: { token: server.token } }))
    socket.onerror = () => reject(new Error(`Mattermost WebSocket failed at ${server.url}`))
    socket.onclose = event => signal.aborted ? resolve() : reject(new Error(`Mattermost WebSocket closed (${event.code})`))
    socket.onmessage = message => {
      const event = parseEvent(String(message.data))
      if (!event) return
      chain = chain.then(async () => {
        if (event.event === 'hello') { ctx.report(SOURCE, { state: 'ready', detail: 'Listening for bot events', at: new Date().toISOString() }); return }
        if (event.event !== 'posted') return
        if (!enabled(ctx)) return
        const post = PostSchema.parse(JSON.parse(String(event.data.post)))
        const trigger = await triggerOf(ctx, post, event.data)
        if (trigger) await receive(ctx, trigger)
      }).catch(error => { ctx.report(SOURCE, { state: 'error', detail: String(error) }) })
    }
  }).finally(async () => { socket.close(); await chain })
}

/** Parses one WebSocket frame; frames that are not JSON objects are ignored. */
export function parseEvent(text: string): { event: string; data: Record<string, unknown> } | undefined {
  try {
    const value = JSON.parse(text) as { event?: string; data?: Record<string, unknown> }
    return typeof value.event === 'string' ? { event: value.event, data: value.data ?? {} } : undefined
  } catch { return undefined }
}

/** Builds a Trigger from a posted event; the channel type and the bot mention come from the event data. */
async function triggerOf(ctx: SourceContext, post: MattermostPost, data: Record<string, unknown>): Promise<Trigger | undefined> {
  const server = bot(ctx)
  const direct = data.channel_type === 'D'
  const channelName = String(data.channel_display_name ?? data.channel_name ?? post.channel_id)
  const mentioned = typeof data.mentions === 'string' && data.mentions.split(',').includes(server.botId)
  const senderIsBot = data.sender_type === 'bot'
  const channel = { name: channelName, direct }
  if (!direct) ctx.state.set(KV.mattermost.channels, { ...ctx.state.get(KV.mattermost.channels) ?? {}, [post.channel_id]: direct })
  return mattermostTrigger(post, server.botId, channel, senderIsBot, mentioned)
}

/** Refreshes the map of channels the bot is a member of (`channel_id -> name`); throws on failure so the stored list stays. */
export async function refreshChannelNames(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>> {
  const server = bot(ctx)
  const channels = z.array(z.looseObject({ id: z.string(), display_name: z.string().default(''), name: z.string().default(''), type: z.string().default('O') }))
    .parse(await mattermostFetch(server, `/users/${server.botId}/channels?team_id=`, {}, signal))
  const names = Object.fromEntries(channels.filter(channel => channel.type !== 'D').map(channel => [channel.id, channel.display_name || channel.name]))
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}

/** Rereads the channel list every minute so newly joined channels appear within a minute. */
async function channelNamesLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) return
  while (!signal.aborted) {
    if (enabled(ctx)) {
      try { await refreshChannelNames(ctx, signal) }
      catch { /* Names are a display aid; the stored list stays until a later read succeeds. */ }
    }
    await sleep(60_000, signal)
  }
}

/** Polls subscribed threads within the polling horizon so replies missed by the live stream become triggers. */
async function pollLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) return
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report(SOURCE, health('paused', 'sourceOff'))
    } else {
      try {
        await pollEach(ctx, SOURCE, () => signal.aborted, thread => pollThread(ctx, thread, signal, config.readPageSize))
        ctx.report(SOURCE, { state: 'ready', detail: 'Subscribed Threads polled', at: new Date().toISOString() })
      } catch (error) { if (!signal.aborted) ctx.report(SOURCE, { state: 'error', detail: String(error) }) }
    }
    await sleep(60_000, signal)
  }
}

/** Polls one subscribed Thread: new posts since the last checkpoint become Triggers, older ones are not re-read. */
async function pollThread(ctx: SourceContext, thread: Thread, signal: AbortSignal, pageSize: number): Promise<void> {
  // A Thread keeps its channel and root post in its meta, set when its first Trigger arrived.
  const channelId = String(thread.meta.channelId ?? '')
  const rootId = String(thread.meta.rootId ?? '')
  if (!channelId || !rootId) throw new Error('Subscribed thread has no retained source post')
  const ref = { triggerId: '', channelId, postId: rootId }
  const checkpoint = KV.mattermost.seen(thread.key)
  const known = new Set(ctx.state.get(checkpoint) ?? [])
  const since = Date.parse(thread.createdAt)
  const page = await mattermostThreadPage(bot(ctx), ref, rootId, undefined, pageSize, signal)
  const fresh = page.messages.filter(message => !known.has(message.id) && Date.parse(message.at) >= since - 5000)
  for (const message of fresh.reverse()) {
    if (signal.aborted) return
    const trigger = mattermostTrigger(PostSchema.parse({ id: message.id, channel_id: ref.channelId, user_id: message.from, message: message.text,
      create_at: Date.parse(message.at), root_id: rootId }), bot(ctx).botId, { name: String(thread.meta.channelName ?? channelId), direct: false }, message.bot === true, false)
    if (trigger) await receive(ctx, trigger)
  }
  page.messages.forEach(message => known.add(message.id))
  ctx.state.set(checkpoint, [...known].slice(-500))
}
