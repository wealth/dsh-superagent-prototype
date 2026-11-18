/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const MattermostBotSchema = z.object({ url: z.string().trim().default(''), token: z.string().trim().default('') })
export const AgentmailAccountSchema = z.object({ apiKey: z.string().trim().default(''), inboxId: z.string().trim().default('') })
export const TelegramBotSchema = z.object({ botToken: z.string().trim().default('') })
export const SentryAccountSchema = z.object({ url: z.string().trim().default(''), orgSlug: z.string().trim().default(''), authToken: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), mattermost: Object.keys(MattermostBotSchema.shape), agentmail: Object.keys(AgentmailAccountSchema.shape), telegram: Object.keys(TelegramBotSchema.shape), sentry: Object.keys(SentryAccountSchema.shape) }

export interface Deployment extends Machine {
  repository: string
  github: { cli: string; login: string; noreply: string }
  mattermost?: MattermostBot
  agentmail?: AgentmailAccount
  telegram?: TelegramBot
  sentry?: SentryAccount
}
/** A verified Mattermost bot: the server it talks to, and the account the bot posts as. */
export interface MattermostBot { url: string; token: string; botId: string; username: string }
/** The part of a Mattermost bot the panel may show: never the token. */
export const mattermostPublic = (bot: MattermostBot): Omit<MattermostBot, 'token'> => ({ url: bot.url, botId: bot.botId, username: bot.username })
/** A verified AgentMail account: the key it reads with, and the inbox address the Source watches. */
export interface AgentmailAccount { apiKey: string; inboxId: string }
/** The part of an AgentMail account the panel may show: never the key. */
export const agentmailPublic = (account: AgentmailAccount): Omit<AgentmailAccount, 'apiKey'> => ({ inboxId: account.inboxId })
/** The AgentMail API every Source request goes to. */
export const AGENTMAIL_BASE = 'https://api.agentmail.to/v0'
/** A verified Telegram bot: the token it answers with, and the account the bot posts as. */
export interface TelegramBot { token: string; botId: number; username: string }
/** The part of a Telegram bot the panel may show: never the token. */
export const telegramPublic = (bot: TelegramBot): Omit<TelegramBot, 'token'> => ({ botId: bot.botId, username: bot.username })
/** A verified Sentry-compatible account: the server and organization the Source reads, and the token it reads with. */
export interface SentryAccount { url: string; orgSlug: string; authToken: string }
/** The part of a Sentry account the panel may show: never the token. */
export const sentryPublic = (account: SentryAccount): Omit<SentryAccount, 'authToken'> => ({ url: account.url, orgSlug: account.orgSlug })

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}
/**
 * Verifies the Mattermost bot token against the server and returns the bot account it belongs to.
 * The token is stored in the Source configuration and used only by the Mattermost Source's own requests.
 */
export async function resolveMattermostBot(machine: Machine, mattermost: unknown, fetcher: typeof fetch = fetch): Promise<MattermostBot | undefined> {
  const { url, token } = MattermostBotSchema.parse(mattermost ?? {})
  if (!url || !token) return undefined
  const base = url.replace(/\/+$/, '')
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('mattermostUnreachable', { url: base, output: reason(error) }) }
  const response = await fetcher(`${base}/api/v4/users/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch(fail)
  if (response.status === 401 || response.status === 403) throw new SetupError('mattermostUnauthorized')
  if (!response.ok) fail(new Error(`HTTP ${response.status}`))
  const user = z.object({ id: z.string().regex(/^[a-z0-9]{26}$/), username: z.string(), is_bot: z.boolean().optional() }).safeParse(await response.json())
  if (!user.success) throw new SetupError('mattermostNoBot')
  return { url: base, token, botId: user.data.id, username: user.data.username }
}
/**
 * Verifies the AgentMail key against the account and that the named inbox exists, returning the account the Source reads with.
 * The key is stored in the Source configuration and used only by the AgentMail Source's own requests.
 */
/**
 * Verifies the Telegram bot token against the Bot API and returns the bot it belongs to.
 * The token is stored in the Source configuration and used only by the Telegram Source's own requests.
 */
export async function resolveTelegram(machine: Machine, telegram: unknown, fetcher: typeof fetch = fetch): Promise<TelegramBot | undefined> {
  const { botToken } = TelegramBotSchema.parse(telegram ?? {})
  if (!botToken) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('telegramUnreachable', { output: reason(error) }) }
  const response = await fetcher(`https://api.telegram.org/bot${botToken}/getMe`, { signal: AbortSignal.timeout(15_000) }).catch(fail)
  if (response.status === 401 || response.status === 403) throw new SetupError('telegramUnauthorized')
  if (!response.ok) fail(new Error(`HTTP ${response.status}`))
  const bot = z.object({ ok: z.boolean(), result: z.object({ id: z.number(), username: z.string(), is_bot: z.boolean().optional() }) }).safeParse(await response.json())
  if (!bot.success || !bot.data.ok) throw new SetupError('telegramNoBot')
  return { token: botToken, botId: bot.data.result.id, username: bot.data.result.username }
}
export async function resolveAgentmail(machine: Machine, agentmail: unknown, fetcher: typeof fetch = fetch): Promise<AgentmailAccount | undefined> {
  const { apiKey, inboxId } = AgentmailAccountSchema.parse(agentmail ?? {})
  if (!apiKey || !inboxId) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('agentmailUnreachable', { output: reason(error) }) }
  const headers = { Authorization: `Bearer ${apiKey}` }
  const me = await fetcher(`${AGENTMAIL_BASE}/auth/me`, { headers, signal: AbortSignal.timeout(15_000) }).catch(fail)
  if (me.status === 401 || me.status === 403) throw new SetupError('agentmailUnauthorized')
  if (!me.ok) fail(new Error(`HTTP ${me.status}`))
  const inbox = await fetcher(`${AGENTMAIL_BASE}/inboxes/${inboxId}`, { headers, signal: AbortSignal.timeout(15_000) }).catch(fail)
  if (inbox.status === 404) throw new SetupError('agentmailInboxMissing', { inbox: inboxId })
  if (!inbox.ok) fail(new Error(`HTTP ${inbox.status}`))
  return { apiKey, inboxId }
}
/**
 * Verifies the Sentry-compatible account against its server and that the named organization exists, returning the account
 * the Source reads with. The token is stored in the Source configuration and used only by the Sentry Source's own requests.
 */
export async function resolveSentry(machine: Machine, sentry: unknown, fetcher: typeof fetch = fetch): Promise<SentryAccount | undefined> {
  const { url, orgSlug, authToken } = SentryAccountSchema.parse(sentry ?? {})
  if (!url || !orgSlug || !authToken) return undefined
  const base = url.replace(/\/+$/, '')
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('sentryUnreachable', { url: base, output: reason(error) }) }
  const response = await fetcher(`${base}/api/0/organizations/${encodeURIComponent(orgSlug)}/projects/`,
    { headers: { Authorization: `Bearer ${authToken}` }, signal: AbortSignal.timeout(15_000) }).catch(fail)
  if (response.status === 401 || response.status === 403) throw new SetupError('sentryUnauthorized')
  if (response.status === 404) throw new SetupError('sentryOrgMissing', { org: orgSlug })
  if (!response.ok) fail(new Error(`HTTP ${response.status}`))
  return { url: base, orgSlug, authToken }
}
