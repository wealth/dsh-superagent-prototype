/** Trigger-scoped AgentMail context reader: a thread page, the root, or the message a reply answers. */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { AgentmailAccount } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import { agentmailFetch } from './agentmail-channel.ts'
import { addressOf, agentmailRef, MessageSchema, messageText, type AgentmailMessage, type AgentmailRef } from './agentmail-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

/** One thread page from the API: the newest messages, ascending within the page; `next_page_token` continues older. */
const ThreadPageSchema = z.object({ thread_id: z.string(), messages: z.array(MessageSchema), next_page_token: z.string().optional() })
/** Pages followed while searching the whole thread for its root or the replied-to message. */
const SEARCH_PAGES = 10

/** Formats an AgentMail message as context for the model; the author is the bare email address. */
export function agentmailView(message: AgentmailMessage): ContextMessage {
  return { id: message.message_id, from: addressOf(message.from), at: message.timestamp, text: messageText(message),
    ...message.in_reply_to ? { reply_to: message.in_reply_to } : {} }
}

/** Reads one page of the thread the Trigger belongs to, newest first. `cursor` is the previous page's `next_page_token`. */
export async function agentmailThreadPage(account: AgentmailAccount, threadId: string, cursor: string | undefined,
  pageSize: number, signal?: AbortSignal): Promise<{ messages: ContextMessage[]; next?: string }> {
  const query = new URLSearchParams({ limit: String(pageSize) })
  if (cursor) query.set('page_token', cursor)
  const page = ThreadPageSchema.parse(await agentmailFetch(account, `/threads/${encodeURIComponent(threadId)}?${query}`, {}, signal))
  const messages = page.messages.map(agentmailView)
  return { messages, ...page.next_page_token ? { next: page.next_page_token } : {} }
}

/** Follows pages until a predicate matches a message, or the pages end; AgentMail pages a thread newest first. */
async function searchThread(account: AgentmailAccount, ref: AgentmailRef, pageSize: number,
  match: (message: ContextMessage) => boolean): Promise<ContextMessage | undefined> {
  let cursor: string | undefined
  for (let page = 0; page < SEARCH_PAGES; page += 1) {
    const read = await agentmailThreadPage(account, ref.threadId, cursor, pageSize)
    const found = read.messages.find(match)
    if (found) return found
    if (!read.next) return undefined
    cursor = read.next
  }
  return undefined
}

/** The thread context reader used by assessments and by `orchestrator_read` on a Trigger. */
export const agentmailThreadContext: ThreadContext<{ readPageSize: number }> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (commands: Commands, trigger: Trigger, part, cursor, config) => {
    const account = commands.agentmail()
    const ref = agentmailRef(trigger)
    if (!ref) throw new Error('An AgentMail source trigger is required')
    if (part === 'parent') {
      const parent = trigger.meta.inReplyTo
      if (typeof parent !== 'string') return { messages: [], body: { status: 'no_parent' }, status: 'no_parent' }
      const found = await searchThread(account, ref, config.readPageSize, message => message.id === parent)
      return found ? { messages: [found], body: { status: 'available' }, status: 'available' }
        : { messages: [], body: { status: 'no_parent' }, status: 'no_parent' }
    }
    if (part === 'root') {
      // The root is the thread's oldest message: the last page's first one, followed to the end within the bound.
      let cursor: string | undefined
      let oldest: ContextMessage | undefined
      for (let page = 0; page < SEARCH_PAGES; page += 1) {
        const read = await agentmailThreadPage(account, ref.threadId, cursor, config.readPageSize, undefined)
        if (!read.messages.length) break
        oldest = read.messages[0]
        if (!read.next) break
        cursor = read.next
      }
      return oldest ? { messages: [oldest], body: { status: 'available' }, status: 'available' }
        : { messages: [], body: { status: 'no_parent' }, status: 'no_parent' }
    }
    const page = await agentmailThreadPage(account, ref.threadId, cursor, config.readPageSize)
    return { messages: page.messages, next: page.next, body: { status: 'available' }, status: 'available' }
  },
}
