/** Telegram source kind definition, bot long-polling loop, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { telegramFetch, telegramLink, sendTelegram } from './telegram-channel.ts'
import { telegramThreadContext } from './telegram-read.ts'
import { runTelegram } from './telegram-loops.ts'
import { telegramMessageId, telegramRef, telegramTrigger, telegramTriggerId, SOURCE } from './telegram-trigger.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'

export { SOURCE, telegramChannel, telegramMessageId, telegramRef, telegramTrigger, telegramTriggerId } from './telegram-trigger.ts'
export type { TelegramUpdate } from './telegram-trigger.ts'
export { telegramFetch, telegramLink, sendTelegram } from './telegram-channel.ts'
export { telegramThreadContext } from './telegram-read.ts'
export { runTelegram } from './telegram-loops.ts'
export { resolveTelegram, type TelegramBot } from '../deployment.ts'

/** Configuration of the Telegram Source: the bot that talks for the agent, and whose messages it receives. */
const TelegramConfigSchema = z.object({
  botToken: z.string().trim().default(''),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  senders: z.array(z.object({ id: z.string().regex(/^@?[A-Za-z0-9_]{1,64}$|^-?\d{1,20}$/), name: z.string().trim().max(100).optional() }).strict())
    .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate senders').default([]),
}).strict()
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>

export const telegramKind: SourceKind<TelegramConfig> = {
  kind: SOURCE,
  order: 40,
  title: { zh: 'Telegram', en: 'Telegram', ru: 'Telegram' },
  description: {
    zh: '机器人的 Telegram 聊天：接收运维人员发给它的消息，并长轮询机器人的更新。',
    en: 'The bot\'s Telegram chat: receives the operators\' messages to it, and long-polls the bot\'s updates.',
    ru: 'Чат бота в Telegram: принимает сообщения операторов боту и длинным опросом читает его обновления.' },
  schema: TelegramConfigSchema,
  fields: [
    { key: 'botToken', type: 'text', label: { zh: '机器人令牌', en: 'Bot token', ru: 'Токен бота' },
      hint: { zh: '来自 BotFather 的机器人令牌。只保存在本机的 DSH 配置里，不在面板上显示。保存时检查机器人，然后重启 dsh-superagent。',
        en: 'The bot token from BotFather. Kept in the local DSH configuration; the panel never shows it. Saving checks the bot, then restarts dsh-superagent.',
        ru: 'Токен бота от BotFather. Хранится в локальной конфигурации DSH, в панели не показывается. При сохранении бот проверяется, затем dsh-superagent перезапускается.' } },
    { key: 'bot', label: { zh: '机器人', en: 'Bot', ru: 'Бот' }, type: 'fact', settings: 'deployment' },
    { key: 'senders', type: 'rows', label: { zh: '接收的发件人', en: 'Senders to receive', ru: 'От кого принимать сообщения' },
      hint: { zh: '名单为空时接收所有发给机器人的消息；非空时只接收列出的用户（数字 ID 或 @用户名）。它们是否成为候选仍由 Policy 决定。',
        en: 'While the list is empty every message to the bot is received; once it names users, only theirs is. Whether a message becomes a candidate is still up to the Policy.',
        ru: 'Пока список пуст, принимаются все сообщения боту; когда в нём есть пользователи — только их (числовой ID или @имя). Станет ли сообщение кандидатом, по-прежнему решает Политика.' },
      columns: [{ key: 'id', type: 'text', label: { zh: 'ID 或 @用户名', en: 'ID or @username', ru: 'ID или @имя' }, pattern: '@?[A-Za-z0-9_]{1,64}|-?\\d{1,20}' },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name', ru: 'Имя' }, optional: true }] },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error', ru: 'Сколько сбоев опроса подряд до сообщения об ошибке' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.',
        ru: 'Однократный обрыв сети автоматически повторяется при следующем опросе и не сообщается.' } },
  ],
  health: ['telegram'],
  scope: () => ({ listened: true, observed: false, row: 'chats' }),
  channel: { send: sendTelegram, link: telegramLink },
  threadContext: telegramThreadContext,
  find: query => ({ threads: (/^telegram:(-?\d+)$/.exec(query.trim()) ? [query.trim()] : []), terms: [] }),
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^@?[A-Za-z0-9_]{1,64}$|^-?\d{1,20}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate senders').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Telegram 用户', en: 'Telegram users who may originate work', ru: 'Пользователи Telegram, которые могут запускать работу' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'ID 或 @用户名', en: 'ID or @username', ru: 'ID или @имя' }, pattern: '@?[A-Za-z0-9_]{1,64}|-?\\d{1,20}' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name', ru: 'Имя' }, optional: true }] },
    ],
    explicit: { zh: '名单内的用户给机器人发消息，总是明确的请求，不需要配置。',
      en: 'A message to the bot from a user on the list always makes an explicit request; that needs no setting.',
      ru: 'Сообщение боту от пользователя из списка — всегда явный запрос; настройка не нужна.' },
    rows() {
      return [{ id: 'chats', label: { zh: '机器人聊天', en: 'Bot chats', ru: 'Чаты бота' }, note: { zh: '接收', en: 'Received', ru: 'Принимать' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_TELEGRAM_CHAT', description: {
        zh: '接下工单的 Telegram 聊天 id；工单不是从 Telegram 来的时为空',
        en: 'Chat id of the Telegram conversation that started the ticket; empty when the ticket did not start on Telegram',
        ru: 'ID чата Telegram, в котором начался тикет; пусто, если тикет начался не в Telegram' } },
    ],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_TELEGRAM_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.telegram ? {
    bot: { zh: `当前机器人 @${deployment.telegram.username}`, en: `Current bot @${deployment.telegram.username}`, ru: `Текущий бот @${deployment.telegram.username}` } } : {},
}

export const name = 'dsh-superagent-telegram'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(telegramKind), 'telegram: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runTelegram(sourceContext(ctx.orchestrator, telegramKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
