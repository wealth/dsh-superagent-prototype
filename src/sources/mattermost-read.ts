/** Trigger-scoped Mattermost context reader: a thread page, the root, or the post a reply answers. */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { MattermostBot } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import { mattermostFetch } from './mattermost-channel.ts'
import { mattermostRef, mattermostTriggerId, PostSchema, type MattermostPost, type MattermostRef } from './mattermost-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

/** A thread page from the REST API: `order` is a post id list, `posts` maps id to post. */
const ThreadSchema = z.object({ order: z.array(z.string()), posts: z.record(z.string(), PostSchema) })
const UserSchema = z.looseObject({ id: z.string(), username: z.string().default(''), is_bot: z.boolean().optional() })

/** Reads one post of the Trigger's channel and checks it belongs there. */
async function readPost(bot: MattermostBot, ref: MattermostRef, postId: string, signal?: AbortSignal): Promise<MattermostPost> {
  const post = PostSchema.parse(await mattermostFetch(bot, `/posts/${encodeURIComponent(postId)}`, {}, signal))
  if (post.channel_id !== ref.channelId) throw new Error('Mattermost returned a post outside the source channel')
  return post
}

/** Formats a Mattermost post as context for the model; the author is the username, and deleted posts show as empty. */
export function mattermostView(post: MattermostPost, username: (userId: string) => string | undefined, isBot: boolean): ContextMessage {
  return { id: post.id, from: username(post.user_id) ?? post.user_id, at: new Date(post.create_at).toISOString(),
    text: post.delete_at ? '' : post.message, ...isBot ? { bot: true } : {}, ...post.delete_at ? { deleted: true } : {},
    ...post.root_id ? { reply_to: post.root_id } : {} }
}

/**
 * Reads one page of the thread the Trigger belongs to, newest first, as the model asked. `cursor` is the post id of the page's
 * oldest post; a page is 20 posts. Returns no `next` when the thread has no older posts.
 */
export async function mattermostThreadPage(bot: MattermostBot, ref: MattermostRef, rootId: string, cursor: string | undefined,
  pageSize: number, signal?: AbortSignal): Promise<{ messages: ContextMessage[]; next?: string }> {
  const query = new URLSearchParams({ per_page: String(pageSize) })
  if (cursor) query.set('before', cursor)
  const thread = ThreadSchema.parse(await mattermostFetch(bot, `/posts/${encodeURIComponent(rootId)}/thread?${query}`, {}, signal))
  const posts = thread.order.flatMap(id => thread.posts[id] ?? [])
  const wrong = posts.find(post => post.channel_id !== ref.channelId)
  if (wrong) throw new Error('Mattermost returned posts outside the source channel')
  const users = await usernames(bot, [...new Set(posts.map(post => post.user_id))], signal)
  const messages = posts.map(post => mattermostView(post, id => users.get(id)?.name, users.get(post.user_id)?.bot === true))
  const oldest = thread.order.at(-1)
  return { messages, ...thread.order.length >= pageSize && oldest ? { next: oldest } : {} }
}

/** Resolves user IDs to usernames and bot flags in one request. */
async function usernames(bot: MattermostBot, ids: string[], signal?: AbortSignal): Promise<Map<string, { name: string; bot: boolean }>> {
  if (!ids.length) return new Map()
  const users = z.array(UserSchema).parse(await mattermostFetch(bot, '/users/ids', { method: 'POST', body: JSON.stringify(ids) }, signal))
  return new Map(users.map(user => [user.id, { name: user.username, bot: user.is_bot === true }]))
}

/** The thread context reader used by assessments and by `orchestrator_read` on a Trigger. */
export const mattermostThreadContext: ThreadContext<{ readPageSize: number }> = {
  messageId: trigger => String(trigger.meta.postId ?? ''),
  read: async (commands: Commands, trigger: Trigger, part, cursor, config) => {
    const bot = commands.mattermost()
    const ref = mattermostRef(trigger)
    if (!ref) throw new Error('A Mattermost source trigger is required')
    const rootId = typeof trigger.meta.rootId === 'string' ? trigger.meta.rootId : ref.postId
    if (part === 'root') {
      const root = await readPost(bot, ref, rootId)
      const users = await usernames(bot, [root.user_id])
      return { messages: [mattermostView(root, id => users.get(id)?.name, users.get(root.user_id)?.bot === true)], body: { status: 'available' }, status: 'available' }
    }
    if (part === 'parent') {
      const parent = trigger.meta.parentId
      if (typeof parent !== 'string') return { messages: [], body: { status: 'no_parent' }, status: 'no_parent' }
      const post = await readPost(bot, ref, parent.replace(/^mattermost:/, ''))
      const users = await usernames(bot, [post.user_id])
      return { messages: [mattermostView(post, id => users.get(id)?.name, users.get(post.user_id)?.bot === true)], body: { status: 'available' }, status: 'available' }
    }
    const page = await mattermostThreadPage(bot, ref, rootId, cursor, config.readPageSize)
    return { messages: page.messages, next: page.next, body: { status: 'available' }, status: 'available' }
  },
}

export { mattermostTriggerId }
