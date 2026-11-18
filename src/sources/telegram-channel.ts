/** Telegram outbound channel: replies in the chat of the target message. */
import type { OutboundMessage } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import type { TelegramBot } from '../deployment.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { telegramTriggerId } from './telegram-trigger.ts'

/** Thrown when a Bot API request fails in a way that may succeed on a later retry. */
export class TelegramError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

/** Calls the Bot API with the Source's token; the token stays in the request and never reaches a log or the panel. */
export async function telegramFetch(bot: TelegramBot, method: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${bot.token}/${method}`, { ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.any([AbortSignal.timeout(35_000), ...signal ? [signal] : []]) })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new TelegramError(`Telegram ${method} failed (${response.status}): ${body.slice(0, 300)}`, response.status)
  }
  const value = await response.json() as { ok?: boolean }
  if (value.ok === false) throw new TelegramError(`Telegram ${method} was refused`, response.status)
  return value
}

/** Sends a reply into the chat of the target message. Telegram dedupes nothing, so retries reuse the same text only after Outbox backs off. */
export async function sendTelegram(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const bot = host.commands.telegram()
  const { chatId } = message.channel.address
  if (!chatId) throw new Error('Missing Telegram reply target')
  const text = checkedImText(message.text)
  try {
    await telegramFetch(bot, 'sendMessage', { method: 'POST', body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }) })
  } catch (error) {
    if (error instanceof TelegramError && (error.status === 403 || error.status === 404 || error.status === 400)) return 'gone'
    throw error
  }
  return 'sent'
}

/** Telegram exposes no permalink for a bot chat, so the link carries only its label; the trigger's own link is preferred. */
export const telegramLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: '',
  label: { zh: 'Telegram 消息', en: 'Telegram message', ru: 'Сообщение в Telegram' },
  triggerId: address.messageId ? telegramTriggerId(Number(address.messageId)) : undefined,
})
