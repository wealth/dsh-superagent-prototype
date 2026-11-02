/** Mattermost source kind definition, policy synchronization, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { resolveMattermostBot, type MattermostBot } from '../deployment.ts'
import { mattermostFetch, mattermostLink, sendMattermost } from './mattermost-channel.ts'
import { mattermostThreadContext } from './mattermost-read.ts'
import { refreshChannelNames, runMattermost } from './mattermost-loops.ts'
import { mattermostParent, SOURCE } from './mattermost-trigger.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export { SOURCE, mattermostChannel, mattermostPostId, mattermostRef, mattermostTrigger, mattermostTriggerId } from './mattermost-trigger.ts'
export type { MattermostPost } from './mattermost-trigger.ts'
export { refreshChannelNames } from './mattermost-loops.ts'
export { mattermostThreadPage } from './mattermost-read.ts'
export { mattermostFetch, mattermostLink } from './mattermost-channel.ts'

/** Configuration of the Mattermost Source: its server and bot token, the channels it listens to, and what it receives. */
const MattermostConfigSchema = z.object({
  url: z.string().trim().default(''),
  token: z.string().trim().default(''),
  readPageSize: z.number().int().min(1).max(50).default(20),
  channels: z.array(z.object({ channelId: z.string().regex(/^[a-z0-9]{26}$/), name: z.string().trim().max(60).optional(),
    listen: z.enum(['mentions', 'all']) }).strict())
    .refine(channels => new Set(channels.map(channel => channel.channelId)).size === channels.length, 'Duplicate channel IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChannels: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type MattermostConfig = z.infer<typeof MattermostConfigSchema>

export const mattermostKind: SourceKind<MattermostConfig> = {
  kind: SOURCE,
  refreshLabels: (host, signal) => refreshChannelNames(sourceContext(host, mattermostKind), signal),
  title: { zh: 'Mattermost', en: 'Mattermost', ru: 'Mattermost' },
  description: { zh: '接收下列频道和私信里发给机器人的消息，并轮询订阅的线程。', en: 'Receives messages to the bot in these channels and direct messages, and polls subscribed Threads.',
    ru: 'Принимает сообщения боту в перечисленных каналах и личных сообщениях и опрашивает подписанные треды.' },
  schema: MattermostConfigSchema,
  fields: [
    { key: 'url', type: 'text', label: { zh: '服务器地址', en: 'Server URL', ru: 'Адрес сервера' },
      hint: { zh: '写作 https://mattermost.example.com，不带末尾斜杠。保存时用机器人令牌检查服务器并重启 dsh-superagent。', en: 'Written as https://mattermost.example.com, without a trailing slash. Saving checks the server with the bot token, then restarts dsh-superagent.',
        ru: 'Пишется как https://mattermost.example.com, без завершающего слеша. При сохранении сервер проверяется токеном бота, затем dsh-superagent перезапускается.' } },
    { key: 'token', type: 'text', label: { zh: '机器人令牌', en: 'Bot token', ru: 'Токен бота' },
      hint: { zh: '机器人账号的个人访问令牌。只保存在本机的 DSH 配置里，不在面板上显示。', en: 'A personal access token of the bot account. Kept in the local DSH configuration; the panel never shows it.',
        ru: 'Персональный токен доступа учётной записи бота. Хранится в локальной конфигурации DSH, в панели не показывается.' } },
    { key: 'bot', type: 'fact', settings: 'deployment' },
    { key: 'channels', type: 'rows', label: { zh: '接收的频道', en: 'Channels', ru: 'Каналы' },
      hint: { zh: '“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可以按规则从中推断工作。', en: '"@ only" receives messages that mention the bot and Threads that have Tickets; "All" also receives the rest, from which Eval may infer work under the rules.',
        ru: '«Только @» принимает сообщения с упоминанием бота и треды с тикетами; «Все сообщения» принимает и остальные, из которых оценка может вывести работу по правилам.' },
      columns: [
        { key: 'channelId', type: 'text', label: { zh: '频道', en: 'Channel', ru: 'Канал' }, pattern: '[a-z0-9]{26}', choose: { zh: '选择机器人所在的频道', en: 'Choose a channel the bot is in', ru: 'Выберите канал, в котором есть бот' }, refresh: { zh: '刷新频道列表', en: 'Refresh channels', ru: 'Обновить список каналов' } },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive', ru: 'Принимать' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only', ru: 'Только @' } }, { value: 'all', label: { zh: '全部消息', en: 'All', ru: 'Все сообщения' } }] },
      ] },
    { key: 'otherChannels', type: 'select', label: { zh: '其他频道', en: 'Other channels', ru: 'Другие каналы' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received', ru: 'Не принимать' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only', ru: 'Только @' } }],
      hint: { zh: '机器人所在、但没列在上面的频道。“仅 @”接收那里 @ 机器人的消息。', en: 'Channels the bot is in that are not listed above. "@ only" receives messages there that mention the bot.', ru: 'Каналы, в которых есть бот, но которых нет в списке выше. «Только @» принимает там сообщения с упоминанием бота.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私信', en: 'Direct messages', ru: 'Личные сообщения' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页消息数', en: 'Messages per page', ru: 'Сообщений на странице' }, hint: { zh: '智能体读取线程时，每页的消息数。', en: 'Messages per page when agents read Threads.', ru: 'Сообщений на странице, когда агенты читают треды.' } },
  ],
  health: ['mattermost', 'history'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const channel = config.channels.find(item => item.channelId === meta.channelId)
    if (channel) return { listened: true, observed: channel.listen === 'all', row: channel.channelId }
    return config.otherChannels === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'channel_not_allowed' }
  },
  // A reply goes only to a channel the Source still receives.
  channel: {
    allowed: (address, config) =>
      mattermostKind.scope!({ meta: { channelId: address.channelId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendMattermost, link: mattermostLink,
  },
  threadContext: mattermostThreadContext,
  find: query => ({ threads: [], terms: [...new Set(query.match(/\b[a-z0-9]{26}\b/g) ?? [])] }),
  // A post's Trigger is named after the post, so the one it answers is named after its thread root.
  repliesTo: trigger => { const parent = mattermostParent(trigger); return parent },
  policy: {
    unnamed: { person: { zh: 'Mattermost 用户', en: 'Mattermost user', ru: 'Пользователь Mattermost' }, bot: { zh: 'Mattermost 机器人', en: 'Mattermost bot', ru: 'Бот Mattermost' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[a-z0-9]{26}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user IDs').default([]),
      syncChannel: z.string().regex(/^([a-z0-9]{26})?$/).default(''),
      bots: z.array(z.object({ id: z.string().regex(/^[a-z0-9]{26}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Mattermost 用户', en: 'Mattermost users who may originate work', ru: 'Пользователи Mattermost, которые могут запускать работу' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID', ru: 'ID пользователя' }, pattern: '[a-z0-9]{26}' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name', ru: 'Имя' }, optional: true }] },
      { key: 'syncChannel', type: 'text', pattern: '([a-z0-9]{26})?', label: { zh: '同步来源频道', en: 'Sync channel', ru: 'Канал синхронизации' }, choose: { zh: '不同步', en: 'Do not sync', ru: 'Не синхронизировать' },
        hint: { zh: '同步时，名单变成这个频道里的人：新成员加入，离开的人移除，名字取用户名。启动时和点同步时进行。', en: 'Syncing makes the list the people in this channel: new members join, people who left are removed, and names follow usernames. It runs at startup and on Sync.', ru: 'При синхронизации список становится участниками этого канала: новые добавляются, ушедшие удаляются, имена берутся из логинов.' } },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates', ru: 'Боты, чьи сообщения могут стать кандидатами' },
        hint: { zh: '名单里的机器人在接收的频道里发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。', en: 'Messages of a bot on this list, in channels the Source receives, become inferred candidates for an assessment; they never make an explicit request or stop a ticket.', ru: 'Сообщения бота из этого списка в принимаемых каналах становятся выведенными кандидатами для оценки; они не могут запустить явный запрос или остановить тикет.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID', ru: 'ID пользователя' }, pattern: '[a-z0-9]{26}' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name', ru: 'Имя' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私信机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.', ru: 'Человек из списка, который упоминает бота или пишет ему лично, всегда делает явный запрос; настройка не нужна.' },
    rows(stored) {
      const config = MattermostConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only', ru: 'Только @' }
      return [
        ...config.channels.map(channel => ({ id: channel.channelId, label: channel.name || channel.channelId, note: channel.listen === 'all' ? { zh: '全部消息', en: 'All', ru: 'Все сообщения' } : mentions,
          cells: { listedUnaddressed: channel.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: channel.listen === 'all' } })),
        { id: 'other', label: { zh: '其他频道', en: 'Other channels', ru: 'Другие каналы' }, note: config.otherChannels === 'mentions' ? mentions : { zh: '不接收', en: 'Not received', ru: 'Не принимать' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChannels === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私信', en: 'Direct messages', ru: 'Личные сообщения' }, note: config.directMessages ? { zh: '接收', en: 'Received', ru: 'Принимать' } : { zh: '不接收', en: 'Not received', ru: 'Не принимать' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
    sync: {
      label: { zh: '立即同步', en: 'Sync now', ru: 'Синхронизировать' },
      ready: part => !!part.syncChannel,
      async run(host, part, signal) {
        const commands = sourceContext(host, mattermostKind).commands.withSignal(signal)
        const bot = commands.mattermost()
        const members = z.array(z.looseObject({ user_id: z.string(), delete_at: z.number().default(0) }))
          .parse(await mattermostFetch(bot, `/channels/${part.syncChannel}/members?per_page=200`, {}, signal))
        const active = members.filter(member => !member.delete_at).map(member => member.user_id)
        const users = z.array(z.looseObject({ id: z.string(), username: z.string() })).parse(await mattermostFetch(bot, '/users/ids', { method: 'POST', body: JSON.stringify(active) }, signal))
        const names = new Map(users.map(user => [user.id, user.username]))
        // Preserve existing member order so policy version hashes stay stable; update names in place and append new members.
        const known = new Set(part.allowed.map(entry => entry.id))
        return { ...part, allowed: [...part.allowed.filter(entry => names.has(entry.id)).map(entry => ({ ...entry, name: names.get(entry.id)! })),
          ...users.filter(user => !known.has(user.id)).map(user => ({ id: user.id, name: user.username }))] }
      },
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_MATTERMOST_BOT', description: { zh: 'Mattermost 机器人用户名', en: 'The Mattermost bot username', ru: 'Имя пользователя бота Mattermost' } },
      { key: 'DSH_SUPERAGENT_MATTERMOST_CHANNEL', description: { zh: '接下工单的 Mattermost 频道 ID；工单不是从 Mattermost 来的时为空', en: 'Channel ID of the Mattermost channel that started the ticket; empty when the ticket did not start on Mattermost', ru: 'ID канала Mattermost, в котором начался тикет; пусто, если тикет начался не в Mattermost' } },
    ],
    values: ({ deployment, trigger }) => ({ DSH_SUPERAGENT_MATTERMOST_BOT: deployment.mattermost?.username ?? '', DSH_SUPERAGENT_MATTERMOST_CHANNEL: trigger?.source === SOURCE ? String(trigger.meta.channelId ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.mattermost ? { bot: { zh: `当前机器人 @${deployment.mattermost.username}`, en: `Current bot @${deployment.mattermost.username}`, ru: `Текущий бот @${deployment.mattermost.username}` } } : {},
}

/** Returns the Mattermost Source's settings, falling back to schema defaults while the plugin is disabled. */
export const mattermostSettings = (sources: SourceRegistry): MattermostConfig => sources.instance<MattermostConfig>(SOURCE)?.config ?? MattermostConfigSchema.parse({})

export { resolveMattermostBot, type MattermostBot }
export const name = 'dsh-superagent-mattermost'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(mattermostKind), 'mattermost: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runMattermost(sourceContext(ctx.orchestrator, mattermostKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
