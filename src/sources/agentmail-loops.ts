/** AgentMail background loop: inbox polling that turns new messages of updated threads into Triggers. */
import { z } from 'zod'
import { threadKey, type Trigger } from '../core/index.ts'
import { cursorAt, pause } from './poll.ts'
import { KV } from '../kv.ts'
import { health, type Health, type SourceContext } from './host.ts'
import { agentmailFetch } from './agentmail-channel.ts'
import { agentmailTrigger, addressOf, MessageSchema, SOURCE, type AgentmailMessage } from './agentmail-trigger.ts'
import type { AgentmailConfig } from './agentmail.ts'
import type { AgentmailAccount } from '../deployment.ts'

/** One updated thread as the inbox's thread list carries it. */
const ThreadItemSchema = z.object({
  thread_id: z.string(), timestamp: z.string(), last_message_id: z.string(), message_count: z.number(),
  subject: z.string().nullish(), senders: z.array(z.string()).default([]),
})
const ThreadsSchema = z.object({ threads: z.array(ThreadItemSchema) })

export const runAgentmail = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> => pollLoop(ctx, signal)

const account = (ctx: SourceContext): AgentmailAccount => {
  const resolved = ctx.deployment.agentmail
  if (!resolved) throw new Error('The AgentMail Source has no working account')
  return resolved
}

/**
 * Polls the inbox at the configured interval. Setup restarts dsh-superagent once it resolves the account, so until then the
 * loop reports what it waits for; disabling the Source pauses it, and enabling it again resumes within one interval.
 */
async function pollLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let interval = 60
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<AgentmailConfig>(SOURCE)
    if (!config) ctx.report(SOURCE, health('paused', 'sourceOff'))
    else if (!ctx.configured() || !ctx.deployment.agentmail) {
      const waiting = health('paused', ctx.configured() ? 'agentmailUnset' : 'setupPending')
      ctx.report(SOURCE, ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
      failures = 0
    } else {
      try {
        interval = await pollRound(ctx, signal, config)
        failures = 0
      } catch (error) {
        failures += 1
        const failed = pollFailure(failures, config.failuresBeforeError, error)
        if (!signal.aborted && failed) ctx.report(SOURCE, failed)
      }
    }
    await pause(Math.max(interval, config?.pollSeconds ?? 60) * 1000, signal)
  }
}

/** True when the Source still receives a message from this sender: everything while the whitelist is empty, only listed addresses after. */
function listened(config: AgentmailConfig, message: AgentmailMessage): boolean {
  return !config.senders.length || config.senders.some(sender => sender.address.toLowerCase() === addressOf(message.from).toLowerCase())
}
/**
 * True when the mail's SPF/DKIM/DMARC results, when the API carries them, show a pass: a listed address is not proof of
 * the sender, so failed mail is skipped instead of becoming Triggers. AgentMail also withholds such mail from every list
 * endpoint, so this check is a belt-and-braces guard for whatever still surfaces here.
 */
function authenticated(message: AgentmailMessage): boolean {
  const results = message.authentication_results
  if (results === undefined || results === null) return true
  const blob = typeof results === 'string' ? results : JSON.stringify(results)
  // Fail only on positive failure evidence: AgentMail withholds unauthenticated mail from list endpoints, so a
  // message without readable results defaults to trusted. The identity the allowlist trusts is the domain, so a
  // failed DMARC is what disqualifies; spf/dkim pass-fails alone do not.
  return !/dmarc[^;\n]{0,80}\b(?:fail|softfail|permerror)\b/i.test(blob)
    && !/unauthenticated[^;\n]{0,80}\btrue\b/i.test(blob)
}

/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}

/** Lists the threads updated since the cursor and reads the new messages of each; a thread is read only when its last message changed. */
async function pollRound(ctx: SourceContext, signal: AbortSignal, config: AgentmailConfig): Promise<number> {
  const started = new Date().toISOString()
  const stored = ctx.state.get(KV.agentmail.since)
  const since = stored ?? cursorAt(started)
  const query = new URLSearchParams({ after: since, ascending: 'true', limit: '100' })
  const list = ThreadsSchema.parse(await agentmailFetch(account(ctx),
    `/inboxes/${account(ctx).inboxId}/threads?${query}`, {}, signal))
  for (const item of list.threads) {
    if (signal.aborted) return config.pollSeconds
    const checkpoint = KV.agentmail.thread(item.thread_id)
    const known = ctx.state.get(checkpoint)
    if (known?.lastMessageId === item.last_message_id) continue
    await readThread(ctx, account(ctx), item, known, config, signal, since)
    if (signal.aborted) return config.pollSeconds
  }
  ctx.atomic(() => { ctx.state.set(KV.agentmail.since, cursorAt(started)) })
  const skipped = ctx.state.get(KV.agentmail.unauthenticated)
  const detail = `${list.threads.length} updated threads; next poll ≥ ${config.pollSeconds}s`
    + (skipped ? `; ${skipped.count} unauthenticated messages skipped since ${skipped.at}` : '')
  ctx.report(SOURCE, { state: 'ready', detail, at: started })
  return config.pollSeconds
}

/** Reads the messages of one updated thread that are newer than what was already seen, oldest first. */
async function readThread(ctx: SourceContext, inbox: AgentmailAccount, item: z.infer<typeof ThreadItemSchema>,
  known: { lastMessageId: string; lastAt: string } | undefined, config: AgentmailConfig, signal: AbortSignal, since: string): Promise<void> {
  const query = new URLSearchParams({ limit: '100' })
  const page = z.object({ messages: z.array(MessageSchema), next_page_token: z.string().optional() })
    .parse(await agentmailFetch(inbox, `/threads/${encodeURIComponent(item.thread_id)}?${query}`, {}, signal))
  // A thread seen before yields only what arrived after its last read; a new one yields what arrived since the round's
  // cursor, so its earlier history stays unread until the next email revives the thread.
  const fresh = page.messages.filter(message => Date.parse(message.timestamp) >
    (known ? Date.parse(known.lastAt) : Date.parse(since) - 5000))
    .filter(message => listened(config, message))
  for (const message of fresh.filter(authenticated)) {
    if (signal.aborted) return
    await receive(ctx, agentmailTrigger(message, inbox.inboxId), item)
  }
  const rejected = fresh.length - fresh.filter(authenticated).length
  if (rejected) {
    const skipped = ctx.state.get(KV.agentmail.unauthenticated)
    ctx.state.set(KV.agentmail.unauthenticated, { count: (skipped?.count ?? 0) + rejected, at: skipped?.at ?? new Date().toISOString() })
  }
  ctx.state.set(KV.agentmail.thread(item.thread_id), { lastMessageId: item.last_message_id, lastAt: item.timestamp })
}

/** Receives a Trigger and labels its Thread with the email subject. */
async function receive(ctx: SourceContext, trigger: Trigger | undefined, item: z.infer<typeof ThreadItemSchema>): Promise<void> {
  if (!trigger) return
  await ctx.receive(trigger)
  const subject = String(item.subject ?? '')
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), {
    label: subject || `Email thread ${item.thread_id}`, facts: { from: { value: trigger.actor.id } },
  })
}
