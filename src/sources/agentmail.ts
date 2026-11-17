/** AgentMail source kind definition, inbox polling loop, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { agentmailFetch, agentmailLink, sendAgentmail } from './agentmail-channel.ts'
import { agentmailThreadContext } from './agentmail-read.ts'
import { runAgentmail } from './agentmail-loops.ts'
import { agentmailParent, agentmailTriggerId, SOURCE } from './agentmail-trigger.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'

export { SOURCE, agentmailChannel, agentmailMessageId, agentmailParent, agentmailRef, agentmailTrigger, agentmailTriggerId, addressOf, messageText } from './agentmail-trigger.ts'
export type { AgentmailMessage } from './agentmail-trigger.ts'
export { agentmailFetch, agentmailLink, sendAgentmail } from './agentmail-channel.ts'
export { agentmailThreadContext } from './agentmail-read.ts'
export { runAgentmail } from './agentmail-loops.ts'
export { resolveAgentmail, type AgentmailAccount } from '../deployment.ts'

/** Configuration of the AgentMail Source: the account whose inbox it watches, and how it polls. */
const EMAIL = '[^\\s@]+@[^\\s@]+\\.[^\\s@]+'
const AgentmailConfigSchema = z.object({
  apiKey: z.string().trim().default(''),
  inboxId: z.string().trim().default(''),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  readPageSize: z.number().int().min(1).max(50).default(20),
  senders: z.array(z.object({ address: z.string().regex(new RegExp(`^${EMAIL}$`), 'email address') }).strict())
    .refine(entries => new Set(entries.map(entry => entry.address.toLowerCase())).size === entries.length, 'Duplicate addresses').default([]),
}).strict()
export type AgentmailConfig = z.infer<typeof AgentmailConfigSchema>

export const agentmailKind: SourceKind<AgentmailConfig> = {
  kind: SOURCE,
  order: 30,
  title: { zh: 'AgentMail', en: 'AgentMail', ru: 'AgentMail' },
  description: {
    zh: '智能体在 AgentMail 的收件箱：接收发到它的邮件，并轮询已订阅线程的新回复。',
    en: 'The agent\'s AgentMail inbox: receives email addressed to it, and polls subscribed Threads for new replies.',
    ru: 'Почтовый ящик агента в AgentMail: принимает письма, адресованные ему, и опрашивает подписанные треды на новые ответы.' },
  schema: AgentmailConfigSchema,
  fields: [
    { key: 'apiKey', type: 'text', label: { zh: 'API 密钥', en: 'API key', ru: 'Ключ API' },
      hint: { zh: '来自 AgentMail 控制台的密钥。只保存在本机的 DSH 配置里，不在面板上显示。', en: 'A key from the AgentMail console. Kept in the local DSH configuration; the panel never shows it.',
        ru: 'Ключ из консоли AgentMail. Хранится в локальной конфигурации DSH, в панели не показывается.' } },
    { key: 'inboxId', type: 'text', pattern: EMAIL, label: { zh: '收件箱', en: 'Inbox', ru: 'Ящик' },
      hint: { zh: '写作邮箱地址，例如 agent@example.com。保存时用密钥检查账号和收件箱，然后重启 dsh-superagent。',
        en: 'Written as the email address, for example agent@example.com. Saving checks the account and the inbox with the key, then restarts dsh-superagent.',
        ru: 'Пишется как адрес электронной почты, например agent@example.com. При сохранении ключом проверяются аккаунт и ящик, затем dsh-superagent перезапускается.' } },
    { key: 'inbox', label: { zh: '收件箱', en: 'Inbox', ru: 'Ящик' }, type: 'fact', settings: 'deployment' },
    { key: 'senders', type: 'rows', label: { zh: '接收的发件人', en: 'Senders to receive', ru: 'От кого принимать письма' },
      hint: { zh: '名单为空时接收所有来信；非空时只接收这些地址的邮件。它们是否成为候选仍由 Policy 决定。',
        en: 'While the list is empty every message is received; once it names addresses, only their mail is received. Whether a message becomes a candidate is still up to the Policy.',
        ru: 'Пока список пуст, принимаются все письма; когда в нём есть адреса — только письма от них. Станет ли письмо кандидатом, по-прежнему решает Политика.' },
      columns: [{ key: 'address', type: 'text', label: { zh: '地址', en: 'Address', ru: 'Адрес' }, pattern: EMAIL }] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds', ru: 'Интервал опроса / сек' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error', ru: 'Сколько сбоев опроса подряд до сообщения об ошибке' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.',
        ru: 'Однократный обрыв сети автоматически повторяется при следующем опросе и не сообщается.' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页消息数', en: 'Messages per page', ru: 'Сообщений на странице' },
      hint: { zh: '智能体读取线程时，每页的消息数。', en: 'Messages per page when agents read Threads.', ru: 'Сообщений на странице, когда агенты читают треды.' } },
  ],
  health: ['agentmail'],
  // Every message to the inbox addresses the agent directly; the Policy's admission table decides candidacy.
  // A non-empty sender list narrows what the Source receives.
  scope({ meta }, config) {
    const from = String(meta.from ?? '')
    if (config.senders.length && !config.senders.some(sender => sender.address.toLowerCase() === from.toLowerCase()))
      return { listened: false, reason: 'sender_not_listened' }
    return { listened: true, observed: false, row: 'inbox' }
  },
  channel: { send: sendAgentmail, link: agentmailLink },
  threadContext: agentmailThreadContext,
  // A query naming a thread key (`agentmail:<thread id>`) names that Thread; opaque AgentMail IDs search Triggers by ID.
  find: query => ({ threads: (/^agentmail:([^\s]+)$/.exec(query.trim()) ? [query.trim()] : []), terms: [] }),
  repliesTo: agentmailParent,
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(new RegExp(`^${EMAIL}$`)), name: z.string().trim().max(100).optional() }).strict())
        .refine(entries => new Set(entries.map(entry => entry.id.toLowerCase())).size === entries.length, 'Duplicate addresses').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的发件地址', en: 'Senders who may originate work', ru: 'Отправители, которые могут запускать работу' },
        columns: [{ key: 'id', type: 'text', label: { zh: '地址', en: 'Address', ru: 'Адрес' }, pattern: EMAIL },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name', ru: 'Имя' }, optional: true }] },
    ],
    explicit: { zh: '名单内的地址给收件箱写信，总是明确的请求，不需要配置。',
      en: 'A message to the inbox from an address on the list always makes an explicit request; that needs no setting.',
      ru: 'Письмо в ящик агента от адреса из списка — всегда явный запрос; настройка не нужна.' },
    rows() {
      return [{ id: 'inbox', label: { zh: '收件箱', en: 'Inbox', ru: 'Ящик' }, note: { zh: '接收', en: 'Received', ru: 'Принимать' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_AGENTMAIL_INBOX', description: {
        zh: '监听的收件箱地址。智能体从这里回复邮件', en: 'The inbox address this Source watches. The agent replies to email from here',
        ru: 'Адрес отслеживаемого ящика. Агент отвечает на письма отсюда' } },
      { key: 'DSH_SUPERAGENT_AGENTMAIL_FROM', description: {
        zh: '接下工单的邮件发件人地址；工单不是从 AgentMail 来的时为空',
        en: 'Sender address of the email that started the ticket; empty when the ticket did not start on AgentMail',
        ru: 'Адрес отправителя письма, с которого начался тикет; пусто, если тикет начался не в AgentMail' } },
    ],
    values: ({ deployment, trigger }) => ({
      DSH_SUPERAGENT_AGENTMAIL_INBOX: deployment.agentmail?.inboxId ?? '',
      DSH_SUPERAGENT_AGENTMAIL_FROM: trigger?.source === SOURCE ? trigger.actor.id : '',
    }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.agentmail ? {
    inbox: { zh: `当前收件箱 ${deployment.agentmail.inboxId}`, en: `Current inbox ${deployment.agentmail.inboxId}`, ru: `Текущий ящик ${deployment.agentmail.inboxId}` },
  } : {},
}

export const name = 'dsh-superagent-agentmail'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(agentmailKind), 'agentmail: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runAgentmail(sourceContext(ctx.orchestrator, agentmailKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
