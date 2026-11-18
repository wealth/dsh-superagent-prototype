/** Normalizes Sentry/GlitchTip issues into domain Triggers. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'

export const SOURCE = 'sentry'

/** An issue as the Sentry-compatible API carries it: `count` may be a string, `permalink` and `culprit` may be absent. */
export const IssueSchema = z.looseObject({
  id: z.string(), shortId: z.string().nullish(), title: z.string(), culprit: z.string().nullish(),
  firstSeen: z.string(), lastSeen: z.string().nullish(), count: z.coerce.number().default(0), userCount: z.coerce.number().default(0),
  level: z.string().nullish(), status: z.string().nullish(), permalink: z.string().nullish(),
  project: z.object({ id: z.coerce.string(), slug: z.string(), name: z.string().nullish() }).nullish(),
})
export type SentryIssue = z.infer<typeof IssueSchema>

/** A project slug as the panel's whitelist writes it. */
export const SLUG = '[A-Za-z0-9_.-]+'

/** Deterministic trigger ID for an issue; every poll produces the same ID for the same issue. */
export const sentryTriggerId = (issueId: string): string => key('sentry', issueId)

/** The issue's web permalink: the API's when it carries one, else the URL an installation's issue page would have. */
export const sentryLink = (account: { url: string; orgSlug: string }, issue: SentryIssue): string =>
  issue.permalink ?? `${account.url.replace(/\/+$/, '')}/organizations/${account.orgSlug}/issues/${issue.id}/`

/** Converts an issue into a Trigger. Sentry issues carry no sender and no reply channel, so the trigger is senderless. */
export function sentryTrigger(issue: SentryIssue, account: { url: string; orgSlug: string }): Trigger {
  const project = issue.project?.slug ?? ''
  const where = issue.culprit ? ` — ${issue.culprit}` : ''
  const url = sentryLink(account, issue)
  return { id: sentryTriggerId(issue.id), source: SOURCE, threads: [{ source: SOURCE, id: issue.id }], actor: { source: SOURCE, id: '' },
    human: false, at: issue.firstSeen, url,
    text: `Новая ошибка в проде: «${issue.title}» в проекте ${project}${where} — ${issue.count} событий, ${issue.userCount} пользователей, уровень ${issue.level ?? 'error'}. ${url}`,
    meta: { kind: 'issue', issueId: issue.id, shortId: issue.shortId ?? '', project, title: issue.title, culprit: issue.culprit ?? '',
      level: issue.level ?? 'error', count: issue.count, userCount: issue.userCount, status: issue.status ?? 'unresolved', url,
      firstSeen: issue.firstSeen, lastSeen: issue.lastSeen ?? issue.firstSeen } }
}

/** The retained source reference for a Trigger, used by thread readers. */
export interface SentryRef { issueId: string }
export function sentryRef(trigger: Trigger): SentryRef | undefined {
  if (trigger.source !== SOURCE) return undefined
  const issueId = trigger.meta.issueId
  return typeof issueId === 'string' ? { issueId } : undefined
}
