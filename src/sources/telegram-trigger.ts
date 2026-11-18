/** Normalizes Telegram bot updates into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'telegram'

/** Reply address of a Telegram message: the chat it was posted in, and the message a reply answers. */
export const telegramChannel = (chatId: string, messageId: string): ChannelRef =>
  ({ source: SOURCE, thread: `telegram:${chatId}`, address: { chatId, messageId } })

/** A Telegram update as the Bot API carries it; only text messages of a user become Triggers. */
export const UpdateSchema = z.looseObject({
  update_id: z.number(),
  message: z.looseObject({
    message_id: z.number(), date: z.number(), chat: z.looseObject({ id: z.number() }),
    from: z.looseObject({ id: z.number(), username: z.string().nullish(), first_name: z.string().nullish(), is_bot: z.boolean().nullish() }).nullish(),
    text: z.string().nullish(),
  }).nullish(),
})
export type TelegramUpdate = z.infer<typeof UpdateSchema>

/** Deterministic trigger ID for a Telegram message; every read path for the same message produces the same ID. */
export const telegramTriggerId = (messageId: number): string => key('telegram', String(messageId))

/** Converts a text message into a Trigger, returning undefined for the bot's own outgoing messages and non-text updates. */
export function telegramTrigger(update: TelegramUpdate, botId: number): Trigger | undefined {
  const message = update.message
  const from = message?.from
  if (!message || !from || !message.text?.trim() || from.is_bot || from.id === botId) return undefined
  return { id: telegramTriggerId(message.message_id), source: SOURCE, threads: [{ source: SOURCE, id: String(message.chat.id) }],
    actor: { source: SOURCE, id: String(from.id) }, human: true, addressed: 'direct', at: new Date(message.date * 1000).toISOString(),
    text: message.text, channel: telegramChannel(String(message.chat.id), String(message.message_id)),
    meta: { chatId: String(message.chat.id), messageId: String(message.message_id) } }
}

/** The Trigger's message ID, from the Trigger's meta. */
export const telegramMessageId = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.messageId === 'string' ? trigger.meta.messageId : undefined

/** The retained source reference for a Trigger, used by thread readers. */
export interface TelegramRef { triggerId: string; chatId: string; messageId: string; at?: string }
export function telegramRef(trigger: Trigger): TelegramRef | undefined {
  const address = trigger.channel?.address as { chatId?: string; messageId?: string } | undefined
  if (trigger.source !== SOURCE || !address?.chatId || !address.messageId) return undefined
  return { triggerId: trigger.id, chatId: address.chatId, messageId: address.messageId, at: trigger.at }
}
