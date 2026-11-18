/** Sentry/GlitchTip source kind definition, issues polling loop, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { sentryThreadContext } from './sentry-read.ts'
import { runSentry } from './sentry-loops.ts'
import { SLUG, sentryRef, sentryTrigger, sentryTriggerId, SOURCE } from './sentry-trigger.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'

export { SOURCE, sentryRef, sentryTrigger, sentryTriggerId, sentryLink, SLUG, type SentryIssue } from './sentry-trigger.ts'
export type { SentryRef } from './sentry-trigger.ts'
export { sentryFetch } from './sentry-api.ts'
export { sentryThreadContext } from './sentry-read.ts'
export { runSentry, pollFailure } from './sentry-loops.ts'
export { resolveSentry, type SentryAccount } from '../deployment.ts'

/** Configuration of the Sentry Source: the Sentry-compatible account it reads with, and what it watches. */
const SentryConfigSchema = z.object({
  url: z.string().trim().default(''),
  orgSlug: z.string().trim().max(80).default(''),
  authToken: z.string().trim().default(''),
  pollSeconds: z.number().int().min(60).max(3600).default(300),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  readPageSize: z.number().int().min(1).max(100).default(50),
  query: z.string().trim().max(200).default('is:unresolved'),
  projects: z.array(z.object({ slug: z.string().regex(new RegExp(`^${SLUG}$`), 'project slug') }).strict())
    .refine(entries => new Set(entries.map(entry => entry.slug.toLowerCase())).size === entries.length, 'Duplicate projects').default([]),
}).strict()
export type SentryConfig = z.infer<typeof SentryConfigSchema>

export const sentryKind: SourceKind<SentryConfig> = {
  kind: SOURCE,
  order: 50,
  title: { zh: 'Sentry / GlitchTip', en: 'Sentry / GlitchTip', ru: 'Sentry / GlitchTip' },
  description: {
    zh: '错误跟踪系统（Sentry 兼容 API，如 GlitchTip）：轮询项目的新未解决 issue，把它交给评估。',
    en: 'The error tracker (Sentry-compatible API, such as GlitchTip): polls the projects for new unresolved issues and hands them to an assessment.',
    ru: 'Трекер ошибок (Sentry-совместимый API, например GlitchTip): опрашивает проекты на новые нерешённые issue и передаёт их оценке.' },
  schema: SentryConfigSchema,
  fields: [
    { key: 'url', type: 'text', label: { zh: 'API 地址', en: 'API base URL', ru: 'Адрес сервера' },
      hint: { zh: '例如 https://glitchtip.example.com。保存时会用令牌检查账号，然后重启 dsh-superagent。',
        en: 'For example https://glitchtip.example.com. Saving checks the account with the token, then restarts dsh-superagent.',
        ru: 'Например https://glitchtip.example.com. При сохранении аккаунт проверяется токеном, затем dsh-superagent перезапускается.' } },
    { key: 'orgSlug', type: 'text', label: { zh: '组织 slug', en: 'Organization slug', ru: 'Slug организации' } },
    { key: 'authToken', type: 'text', label: { zh: 'API 令牌', en: 'API token', ru: 'Токен API' },
      hint: { zh: '来自 Sentry/GlitchTip 的 API 令牌。只保存在本机的 DSH 配置里，不在面板上显示。',
        en: 'The API token from Sentry or GlitchTip. Kept in the local DSH configuration; the panel never shows it.',
        ru: 'Токен API из Sentry/GlitchTip. Хранится в локальной конфигурации DSH, в панели не показывается.' } },
    { key: 'org', label: { zh: '组织', en: 'Organization', ru: 'Организация' }, type: 'fact', settings: 'deployment' },
    { key: 'projects', type: 'rows', label: { zh: '接收的项目', en: 'Projects to watch', ru: 'Проекты, по которым принимать ошибки' },
      hint: { zh: '名单为空时接收所有项目的新 issue；非空时只接收列出的项目。它们是否成为候选仍由 Policy 决定。',
        en: 'While the list is empty every project\'s issues are received; once it names slugs, only theirs is. Whether an issue becomes a candidate is still up to the Policy.',
        ru: 'Пока список пуст, принимаются новые issue всех проектов; когда в нём есть slug — только их. Станет ли issue кандидатом, по-прежнему решает Политика.' },
      columns: [{ key: 'slug', type: 'text', label: { zh: '项目 slug', en: 'Project slug', ru: 'Slug проекта' }, pattern: SLUG }] },
    { key: 'query', type: 'text', advanced: true, label: { zh: '查询', en: 'Query', ru: 'Запрос' },
      hint: { zh: 'Sentry 查询语法，默认 is:unresolved。', en: 'A Sentry query; the default is is:unresolved.', ru: 'Запрос в синтаксисе Sentry; по умолчанию is:unresolved.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds', ru: 'Интервал опроса / сек' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error', ru: 'Сколько сбоев опроса подряд до сообщения об ошибке' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.',
        ru: 'Однократный обрыв сети автоматически повторяется при следующем опросе и не сообщается.' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 100, label: { zh: '每次轮询的 issue 数', en: 'Issues per poll', ru: 'Issue за опрос' } },
  ],
  health: ['sentry'],
  // Issues carry no sender and address nobody: the Source observes them, and the Policy's admission table row `issues` decides candidacy.
  // A non-empty project list narrows what the Source receives.
  scope({ meta }, config) {
    const project = String(meta.project ?? '')
    if (config.projects.length && !config.projects.some(entry => entry.slug.toLowerCase() === project.toLowerCase()))
      return { listened: false, reason: 'project_not_listened' }
    return { listened: true, observed: true, row: 'issues' }
  },
  threadContext: sentryThreadContext,
  // A query naming a thread key (`sentry:<issue id>`) names that Thread; issue ids search Triggers by ID.
  find: query => ({ threads: (/^sentry:([^\s]+)$/.exec(query.trim()) ? [query.trim()] : []), terms: [] }),
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]+$/) }).strict()).default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的账号（此来源未用）', en: 'Accounts that may originate work (unused by this Source)', ru: 'Учётные записи, которые могут запускать работу (источником не используются)' },
        hint: { zh: 'Issue 由来源自己发出，没有发件人，此名单不使用。', en: 'Issues come from the Source itself and name no sender, so this list stays unused.',
          ru: 'Issue приходят от самого источника без отправителя, поэтому список не используется.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account', ru: 'Учётная запись' }, pattern: '[A-Za-z0-9\\-]+' }] },
    ],
    explicit: { zh: '此来源不产生明确请求。', en: 'This Source never makes an explicit request.', ru: 'Этот источник не создаёт явных запросов.' },
    rows() {
      return [{ id: 'issues', label: { zh: '新未解决 issue', en: 'New unresolved issues', ru: 'Новые нерешённые issue' }, note: { zh: '接收', en: 'Received', ru: 'Принимать' },
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_SENTRY_PROJECT', description: {
        zh: '产生工单的 issue 的项目 slug；工单不是从 Sentry 来的时为空',
        en: 'Project slug of the issue that started the ticket; empty when the ticket did not start on Sentry',
        ru: 'Slug проекта issue, с которого начался тикет; пусто, если тикет начался не в Sentry' } },
      { key: 'DSH_SUPERAGENT_SENTRY_ISSUE', description: {
        zh: '产生工单的 issue 的短 ID（如 PROJ-42）；不是来自 Sentry 时为空',
        en: 'Short id of the issue that started the ticket (such as PROJ-42); empty when the ticket did not start on Sentry',
        ru: 'Короткий id issue, с которого начался тикет (например PROJ-42); пусто, если тикет начался не в Sentry' } },
      { key: 'DSH_SUPERAGENT_SENTRY_URL', description: {
        zh: '产生工单的 issue 的网页链接；不是来自 Sentry 时为空',
        en: 'Web link of the issue that started the ticket; empty when the ticket did not start on Sentry',
        ru: 'Ссылка на страницу issue, с которого начался тикет; пусто, если тикет начался не в Sentry' } },
    ],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_SENTRY_PROJECT: trigger?.source === SOURCE ? String(trigger.meta.project ?? '') : '',
      DSH_SUPERAGENT_SENTRY_ISSUE: trigger?.source === SOURCE ? String(trigger.meta.shortId ?? '') : '',
      DSH_SUPERAGENT_SENTRY_URL: trigger?.source === SOURCE && typeof trigger.url === 'string' ? trigger.url : '',
    }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.sentry ? {
    org: { zh: `当前组织 ${deployment.sentry.orgSlug}`, en: `Current organization ${deployment.sentry.orgSlug}`, ru: `Текущая организация ${deployment.sentry.orgSlug}` },
  } : {},
}

export const name = 'dsh-superagent-sentry'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(sentryKind), 'sentry: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, sentryKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = runSentry(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error), at: new Date().toISOString() }) })
    return async () => { controller.abort(); await running }
  })
}
