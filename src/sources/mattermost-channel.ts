/** Mattermost outbound channel: posts replies in the thread of the target post and builds permalinks. */
import type { OutboundMessage } from '../core/index.ts'
import type { MattermostBot } from '../deployment.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { mattermostTrigger, mattermostTriggerId } from './mattermost-trigger.ts'

/** Thrown when a Mattermost request fails in a way that means the target is gone (the post or channel no longer exists). */
export class MattermostError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

/** Calls the Mattermost REST API as the bot; the token stays in the request and never reaches a log or the panel. */
export async function mattermostFetch(bot: MattermostBot, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${bot.url}/api/v4${path}`, { ...init,
    headers: { Authorization: `Bearer ${bot.token}`, 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...signal ? [signal] : []]) })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new MattermostError(`Mattermost ${init.method ?? 'GET'} ${path} failed (${response.status}): ${body.slice(0, 300)}`, response.status)
  }
  return response.status === 204 ? undefined : response.json()
}

/**
 * Posts a reply into the thread of the target post. `message.id` is the idempotency key: Mattermost does not dedupe by key, so a
 * retry first looks for a post this bot already made with the same key in `props`.
 */
export async function sendMattermost(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const bot = host.commands.mattermost()
  const { channelId, postId, rootId } = message.channel.address
  if (!channelId || !postId) throw new Error('Missing Mattermost reply target')
  const text = checkedImText(message.text)
  const root = rootId || postId
  try {
    await mattermostFetch(bot, '/posts', { method: 'POST', body: JSON.stringify({ channel_id: channelId, root_id: root, message: text,
      props: { dsh_superagent_message_id: message.id } }) })
  } catch (error) {
    if (error instanceof MattermostError && (error.status === 404 || error.status === 403)) return 'gone'
    throw error
  }
  return 'sent'
}

/** Permalink of the target post on the server, when the server URL and team are known; the trigger's own link is preferred. */
export const mattermostLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => {
  const bot = links.mattermost
  const postId = address.postId ?? ''
  return {
    url: bot && postId ? `${bot.url}/_redirect/pl/${encodeURIComponent(postId)}` : '',
    label: { zh: 'Mattermost 消息', en: 'Mattermost message', ru: 'Сообщение в Mattermost' },
    triggerId: postId ? mattermostTriggerId(postId) : undefined,
  }
}

export { mattermostTrigger }
