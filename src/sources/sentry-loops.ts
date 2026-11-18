/** Sentry background loop: polling the Sentry-compatible API for new unresolved issues of the watched projects. */
import { threadKey, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, type Health, type SourceContext } from './host.ts'
import { listIssues } from './sentry-api.ts'
import { sentryTrigger, SOURCE } from './sentry-trigger.ts'
import type { SentryConfig } from './sentry.ts'
import type { SentryAccount } from '../deployment.ts'
import { cursorAt, pause } from './poll.ts'

export const runSentry = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> => pollLoop(ctx, signal)

const account = (ctx: SourceContext): SentryAccount => {
  const resolved = ctx.deployment.sentry
  if (!resolved) throw new Error('The Sentry Source has no working account')
  return resolved
}

/** True when the Source still watches a project: everything while the list is empty, only listed projects after. */
function listened(config: SentryConfig, project: string): boolean {
  return !config.projects.length || config.projects.some(entry => entry.slug.toLowerCase() === project.toLowerCase())
}

/**
 * Polls the issues endpoint at the configured interval. Setup restarts dsh-superagent once it verifies the account, so
 * until then the loop reports what it waits for; disabling the Source pauses it, and enabling it again resumes within one interval.
 */
async function pollLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<SentryConfig>(SOURCE)
    if (!config) ctx.report(SOURCE, health('paused', 'sourceOff'))
    else if (!ctx.configured() || !ctx.deployment.sentry) {
      const waiting = health('paused', ctx.configured() ? 'sentryUnset' : 'setupPending')
      ctx.report(SOURCE, ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
      failures = 0
    } else {
      try {
        await pollRound(ctx, signal, config)
        failures = 0
      } catch (error) {
        failures += 1
        const failed = pollFailure(failures, config.failuresBeforeError, error)
        if (!signal.aborted && failed) ctx.report(SOURCE, failed)
      }
    }
    // A failed poll retries in five seconds; a settled one waits out the configured interval.
    await pause(failures ? 5000 : (config?.pollSeconds ?? 300) * 1000, signal)
  }
}

/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}

/** Lists unresolved issues, receives those first seen since the cursor, and advances the cursor only after every receive. */
async function pollRound(ctx: SourceContext, signal: AbortSignal, config: SentryConfig): Promise<void> {
  const started = new Date().toISOString()
  const since = ctx.state.get(KV.sentry.since) ?? cursorAt(started)
  const issues = await listIssues(account(ctx), { orgSlug: account(ctx).orgSlug, filter: config.query, limit: config.readPageSize }, signal)
  const fresh = issues.filter(issue => Date.parse(issue.firstSeen) > Date.parse(since) - 5000)
    .filter(issue => listened(config, issue.project?.slug ?? ''))
  for (const issue of fresh) {
    if (signal.aborted) return
    await receive(ctx, sentryTrigger(issue, account(ctx)), issue)
  }
  ctx.atomic(() => { ctx.state.set(KV.sentry.since, cursorAt(started)) })
  ctx.report(SOURCE, { state: 'ready', detail: `${issues.length} unresolved issues, ${fresh.length} new; next poll ≥ ${config.pollSeconds}s`, at: started })
}

/** Receives a Trigger and labels its Thread with the issue title. */
async function receive(ctx: SourceContext, trigger: Trigger, issue: { title: string; project?: { slug: string } | null }): Promise<void> {
  await ctx.receive(trigger)
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), {
    label: `${issue.project?.slug ? `${issue.project.slug}: ` : ''}${issue.title}` })
}
