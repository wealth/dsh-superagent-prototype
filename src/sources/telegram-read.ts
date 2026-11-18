/** Trigger-scoped Telegram context reader: a chat yields only the messages the bot itself saw. */
import type { Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { telegramRef, type TelegramRef } from './telegram-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

/**
 * The Bot API exposes no chat history to bots, so a read returns the Trigger's own message and reports no pagination;
 * the ticket's delivery carries the rest of the conversation.
 */
export const telegramThreadContext: ThreadContext<Record<string, unknown>> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (commands: Commands, trigger: Trigger, part) => {
    commands.telegram()
    const ref = telegramRef(trigger)
    if (!ref) throw new Error('A Telegram source trigger is required')
    if (part === 'parent') return { messages: [], body: { status: 'no_parent' }, status: 'no_parent' }
    const message: ContextMessage = { id: ref.messageId, from: trigger.actor.id, at: trigger.at, text: trigger.text }
    return { messages: [message], body: { status: 'available' }, status: 'available' }
  },
}
