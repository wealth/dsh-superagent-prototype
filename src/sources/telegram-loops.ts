/** Telegram background loop: long-polling the bot's updates and turning operator messages into Triggers. */
import { threadKey, type Trigger } from '../core/index.ts'
import { z } from 'zod'
import { KV } from '../kv.ts'
import { health, type Health, type SourceContext } from './host.ts'
import { telegramFetch } from './telegram-channel.ts'
import { SOURCE, telegramTrigger, type TelegramUpdate } from './telegram-trigger.ts'
import { UpdateSchema } from './telegram-trigger.ts'
import type { TelegramConfig } from './telegram.ts'
import type { TelegramBot } from '../deployment.ts'
import { pause } from './poll.ts'

export const runTelegram = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> => pollLoop(ctx, signal)

const bot = (ctx: SourceContext): TelegramBot => {
  const resolved = ctx.deployment.telegram
  if (!resolved) throw new Error('The Telegram Source has no working bot')
  return resolved
}

/** True when the Source still receives a message from this sender: everything while the whitelist is empty, only listed users after. */
function listened(config: TelegramConfig, update: TelegramUpdate): boolean {
  const id = String(update.message?.from?.id ?? '')
  const username = update.message?.from?.username ? `@${update.message.from.username}` : ''
  return !config.senders.length || config.senders.some(sender => sender.id === id || sender.id.toLowerCase() === username.toLowerCase())
}

/**
 * Long-polls the bot's updates. Setup restarts dsh-superagent once it verifies the bot, so until then the loop reports
 * what it waits for; disabling the Source pauses it, and enabling it again resumes within one long poll.
 */
async function pollLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<TelegramConfig>(SOURCE)
    if (!config) ctx.report(SOURCE, health('paused', 'sourceOff'))
    else if (!ctx.configured() || !ctx.deployment.telegram) {
      const waiting = health('paused', ctx.configured() ? 'telegramUnset' : 'setupPending')
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
    await pause(config?.failuresBeforeError !== undefined && failures ? 5000 : 1000, signal)
  }
}

/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}

/** The Bot API answer: an ordered list of updates. */
const UpdatesSchema = z.object({ result: z.array(UpdateSchema) })

/** One long poll: updates since the stored offset become Triggers, and the offset advances even when nothing matched. */
async function pollRound(ctx: SourceContext, signal: AbortSignal, config: TelegramConfig): Promise<void> {
  const started = new Date().toISOString()
  const offset = ctx.state.get(KV.telegram.offset) ?? 0
  const query = new URLSearchParams({ timeout: '25', allowed_updates: '["message"]', ...offset ? { offset: String(offset) } : {} })
  const answer = UpdatesSchema.parse(await telegramFetch(bot(ctx), `getUpdates?${query}`, {}, signal)) as { result: TelegramUpdate[] }
  for (const update of answer.result) {
    if (signal.aborted) return
    ctx.atomic(() => { ctx.state.set(KV.telegram.offset, update.update_id + 1) })
    if (!update.message || !listened(config, update)) continue
    await receive(ctx, telegramTrigger(update, bot(ctx).botId))
  }
  ctx.report(SOURCE, { state: 'ready', detail: `${answer.result.length} updates; long poll ≥ 25s`, at: started })
}

/** Receives a Trigger and labels its Thread with the chat. */
async function receive(ctx: SourceContext, trigger: Trigger | undefined): Promise<void> {
  if (!trigger) return
  await ctx.receive(trigger)
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { from: { value: trigger.actor.id } } })
}
