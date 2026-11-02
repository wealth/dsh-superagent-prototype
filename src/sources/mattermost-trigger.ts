/** Normalizes Mattermost posts, WebSocket events, and thread posts into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'mattermost'

/** Reply address of a Mattermost post: its channel, and the thread root the reply goes into. */
export const mattermostChannel = (channelId: string, postId: string, rootId?: string, direct = false): ChannelRef =>
  ({ source: SOURCE, thread: `mattermost:${channelId}:${rootId || postId}`, address: { channelId, postId, ...rootId ? { rootId } : {}, ...direct ? { direct: 'true' } : {} } })

/** A post as the REST API and the `posted` WebSocket event carry it (the event stores it as a JSON string under `data.post`). */
export const PostSchema = z.looseObject({
  id: z.string(), channel_id: z.string(), user_id: z.string(), message: z.string().default(''), create_at: z.number(),
  root_id: z.string().default(''), delete_at: z.number().default(0), type: z.string().default(''),
  props: z.record(z.string(), z.unknown()).optional(),
})
export type MattermostPost = z.infer<typeof PostSchema>

/** Deterministic trigger ID for a Mattermost post; every read path for the same post produces the same ID. */
export const mattermostTriggerId = (postId: string): string => key('mattermost', postId)

/** Converts a post into a Trigger, returning undefined for posts by the bot itself or system posts. */
export function mattermostTrigger(post: MattermostPost, botId: string, channel: { name: string; direct: boolean; team?: string },
  senderIsBot: boolean, mentioned: boolean): Trigger | undefined {
  if (post.user_id === botId || post.type.startsWith('system_')) return undefined
  const direct = channel.direct
  const rootId = post.root_id || undefined
  const thread = `${post.channel_id}:${rootId ?? post.id}`
  return { id: mattermostTriggerId(post.id), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: post.user_id }, human: !senderIsBot,
    ...(direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {}),
    at: new Date(post.create_at).toISOString(), text: post.message,
    channel: mattermostChannel(post.channel_id, post.id, rootId, direct), meta: { channelId: post.channel_id, postId: post.id, channelName: channel.name,
      direct, mentioned, ...rootId ? { rootId } : {} } }
}

/** The Trigger's post ID, from the Trigger's meta. */
export const mattermostPostId = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.postId === 'string' ? trigger.meta.postId : undefined

/** The post a Mattermost reply answers: its thread root when it has one, else the post itself has no parent. */
export const mattermostParent = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.rootId === 'string' ? mattermostTriggerId(trigger.meta.rootId) : undefined

/** The retained source reference for a Trigger, used by thread readers and link lookups. */
export interface MattermostRef { triggerId: string; channelId: string; postId: string; at?: string }
export function mattermostRef(trigger: Trigger): MattermostRef | undefined {
  const meta = trigger.meta as { channelId?: string; postId?: string }
  if (trigger.source !== SOURCE || !meta.channelId || !meta.postId) return undefined
  return { triggerId: trigger.id, channelId: meta.channelId, postId: meta.postId, at: trigger.at }
}
