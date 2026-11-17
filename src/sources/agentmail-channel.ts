/** AgentMail outbound channel: replies in the email thread of the target message. */
import type { OutboundMessage } from '../core/index.ts'
import { AGENTMAIL_BASE, type AgentmailAccount } from '../deployment.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { agentmailTriggerId } from './agentmail-trigger.ts'

/** Thrown when an AgentMail request fails in a way that may succeed on a later retry. */
export class AgentmailError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

/** Calls the AgentMail API with the Source's key; the key stays in the request and never reaches a log or the panel. */
export async function agentmailFetch(account: AgentmailAccount, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${AGENTMAIL_BASE}${path}`, { ...init,
    headers: { Authorization: `Bearer ${account.apiKey}`, 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...signal ? [signal] : []]) })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new AgentmailError(`AgentMail ${init.method ?? 'GET'} ${path} failed (${response.status}): ${body.slice(0, 300)}`, response.status)
  }
  return response.status === 204 ? undefined : response.json()
}

/**
 * Replies in the thread of the target message. `message.id` is the `Idempotency-Key`: AgentMail keeps keys for a day,
 * so an Outbox retry with the same key returns the original message and sends no second email.
 */
export async function sendAgentmail(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const account = host.commands.agentmail()
  const { threadId, messageId } = message.channel.address
  if (!threadId || !messageId) throw new Error('Missing AgentMail reply target')
  try {
    await agentmailFetch(account, `/inboxes/${account.inboxId}/messages/${encodeURIComponent(messageId)}/reply`,
      { method: 'POST', body: JSON.stringify({ text: message.text }), headers: { 'Idempotency-Key': message.id } })
  } catch (error) {
    if (error instanceof AgentmailError && (error.status === 404 || error.status === 403 || error.status === 410)) return 'gone'
    throw error
  }
  return 'sent'
}

/** AgentMail exposes no web permalink for a thread, so the link carries only its label; the trigger's own link is preferred. */
export const agentmailLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: '',
  label: { zh: '邮件', en: 'Email', ru: 'Письмо' },
  triggerId: address.messageId ? agentmailTriggerId(address.messageId) : undefined,
})
