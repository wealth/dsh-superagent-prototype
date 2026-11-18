/** Normalizes AgentMail messages into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'agentmail'

/** Reply address of an email: the inbox that received it, its thread, and the message a reply answers. */
export const agentmailChannel = (inboxId: string, threadId: string, messageId: string): ChannelRef =>
  ({ source: SOURCE, thread: `agentmail:${threadId}`, address: { inboxId, threadId, messageId } })

/** A message as the AgentMail API carries it; `timestamp` is ISO, and `in_reply_to` names the parent message. */
export const MessageSchema = z.looseObject({
  message_id: z.string(), thread_id: z.string(), from: z.string(), to: z.array(z.string()).default([]),
  timestamp: z.string(), text: z.string().nullish(), extracted_text: z.string().nullish(), subject: z.string().nullish(),
  in_reply_to: z.string().nullish(), labels: z.array(z.string()).default([]),
  authentication_results: z.unknown().optional(),
})
export type AgentmailMessage = z.infer<typeof MessageSchema>

/** Strips the display name from `Display Name <user@domain>` down to the bare address. */
export const addressOf = (value: string): string => (/^.*<([^<>]+)>\s*$/.exec(value)?.[1] ?? value).trim()

/** The message body the model should read: AgentMail's extracted text when it has one, else the plain text body. */
export const messageText = (message: AgentmailMessage): string => message.extracted_text ?? message.text ?? ''

/** Deterministic trigger ID for an AgentMail message; every read path for the same message produces the same ID. */
export const agentmailTriggerId = (messageId: string): string => key('agentmail', messageId)

/** Converts a message into a Trigger, returning undefined for the inbox's own outgoing messages. */
export function agentmailTrigger(message: AgentmailMessage, inboxId: string, senderIsBot = false): Trigger | undefined {
  const from = addressOf(message.from)
  if (from === addressOf(inboxId)) return undefined
  return { id: agentmailTriggerId(message.message_id), source: SOURCE, threads: [{ source: SOURCE, id: message.thread_id }],
    actor: { source: SOURCE, id: from }, human: !senderIsBot, addressed: 'direct', at: message.timestamp, text: messageText(message),
    channel: agentmailChannel(addressOf(inboxId), message.thread_id, message.message_id),
    meta: { threadId: message.thread_id, messageId: message.message_id, from, subject: message.subject ?? '',
      ...message.in_reply_to ? { inReplyTo: message.in_reply_to } : {} } }
}

/** The Trigger's message ID, from the Trigger's meta. */
export const agentmailMessageId = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.messageId === 'string' ? trigger.meta.messageId : undefined

/** The Trigger an email reply answers, named after the message its `In-Reply-To` header carries. */
export const agentmailParent = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.inReplyTo === 'string' ? agentmailTriggerId(trigger.meta.inReplyTo) : undefined

/** The retained source reference for a Trigger, used by thread readers. */
export interface AgentmailRef { triggerId: string; inboxId: string; threadId: string; messageId: string; at?: string }
export function agentmailRef(trigger: Trigger): AgentmailRef | undefined {
  const address = trigger.channel?.address as { inboxId?: string; threadId?: string; messageId?: string } | undefined
  if (trigger.source !== SOURCE || !address?.inboxId || !address.threadId || !address.messageId) return undefined
  return { triggerId: trigger.id, inboxId: address.inboxId, threadId: address.threadId, messageId: address.messageId, at: trigger.at }
}
