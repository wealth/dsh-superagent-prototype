/** Sentry-compatible API access for the Sentry Source; the token stays in the request and never reaches a log or the panel. */
import { z } from 'zod'
import type { SentryAccount } from '../deployment.ts'
import { IssueSchema, type SentryIssue } from './sentry-trigger.ts'

/** Thrown when a Sentry-compatible request fails in a way that may succeed on a later retry. */
export class SentryError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

/** Calls the Sentry-compatible API with the Source's token. */
export async function sentryFetch(account: SentryAccount, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  const base = account.url.replace(/\/+$/, '')
  const response = await fetch(`${base}/api/0${path}`, { ...init,
    headers: { Authorization: `Bearer ${account.authToken}`, 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...signal ? [signal] : []]) })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new SentryError(`Sentry API ${init.method ?? 'GET'} ${path} failed (${response.status}): ${body.slice(0, 300)}`, response.status)
  }
  return response.status === 204 ? undefined : response.json()
}

/** Lists an organization's issues, newest activity first; Sentry pages by cursor, one bounded page per poll suffices. */
export async function listIssues(account: SentryAccount, query: { orgSlug: string; filter: string; limit: number },
  signal?: AbortSignal): Promise<SentryIssue[]> {
  const search = new URLSearchParams({ query: query.filter, statsPeriod: '24h', limit: String(query.limit) })
  return z.array(IssueSchema).parse(await sentryFetch(account, `/organizations/${encodeURIComponent(query.orgSlug)}/issues/?${search}`, {}, signal))
}
