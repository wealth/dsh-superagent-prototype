/** Trigger-scoped Sentry context reader: the latest events of the trigger's issue. */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { sentryFetch } from './sentry-api.ts'
import { sentryRef, SOURCE, type SentryIssue } from './sentry-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

/** An issue event as the API carries it: `message` may be absent for non-message events. */
const EventSchema = z.looseObject({
  id: z.string(), message: z.string().nullish(), culprit: z.string().nullish(), dateCreated: z.string(),
  userCount: z.coerce.number().nullish(), level: z.string().nullish(),
  metadata: z.object({ type: z.string().nullish(), value: z.string().nullish() }).nullish(),
})

/** Formats an issue event as context for the model; the culprit names where it happened. */
export function sentryView(event: z.infer<typeof EventSchema>): ContextMessage {
  const type = event.metadata?.type, value = event.metadata?.value
  return { id: event.id, from: event.culprit ?? type ?? 'sentry', at: event.dateCreated,
    text: value ? `${type ?? 'Ошибка'}: ${value}` : event.message ?? `${type ?? 'Ошибка'} (детали на странице события)` }
}

/** The thread context reader used by assessments and by `orchestrator_read` on a Trigger. */
export const sentryThreadContext: ThreadContext<{ readPageSize: number }> = {
  messageId: trigger => sentryRef(trigger)?.issueId ?? '',
  read: async (commands: Commands, trigger: Trigger, part, _cursor, config) => {
    const account = commands.sentry()
    const ref = sentryRef(trigger)
    if (!ref) throw new Error('A Sentry source trigger is required')
    if (part !== 'thread') return { messages: [], body: { status: 'no_parent' }, status: 'no_parent' }
    const events = z.array(EventSchema).parse(await sentryFetch(account,
      `/issues/${encodeURIComponent(ref.issueId)}/events/?limit=${encodeURIComponent(String(config.readPageSize))}`))
    return { messages: events.map(sentryView), body: { status: 'available' }, status: 'available' }
  },
}

export type { SentryIssue }
