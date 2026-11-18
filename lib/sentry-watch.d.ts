import { U as Trigger, _t as resolveSentry, pt as SentryAccount } from "./intake-DP1lP5GM.js";
import { a as ThreadContext, i as SourceKind, o as Health, s as SourceContext } from "./kind-o5b7wYsR.js";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
//#region src/sources/sentry-trigger.d.ts
declare const SOURCE = "sentry";
/** An issue as the Sentry-compatible API carries it: `count` may be a string, `permalink` and `culprit` may be absent. */
declare const IssueSchema: z.ZodObject<{
  id: z.ZodString;
  shortId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  title: z.ZodString;
  culprit: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  firstSeen: z.ZodString;
  lastSeen: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  count: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
  userCount: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
  level: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  status: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  permalink: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  project: z.ZodOptional<z.ZodNullable<z.ZodObject<{
    id: z.ZodCoercedString<unknown>;
    slug: z.ZodString;
    name: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  }, z.core.$strip>>>;
}, z.core.$loose>;
type SentryIssue = z.infer<typeof IssueSchema>;
/** A project slug as the panel's whitelist writes it. */
declare const SLUG = "[A-Za-z0-9_.-]+";
/** Deterministic trigger ID for an issue; every poll produces the same ID for the same issue. */
declare const sentryTriggerId: (issueId: string) => string;
/** The issue's web permalink: the API's when it carries one, else the URL an installation's issue page would have. */
declare const sentryLink: (account: {
  url: string;
  orgSlug: string;
}, issue: SentryIssue) => string;
/** Converts an issue into a Trigger. Sentry issues carry no sender and no reply channel, so the trigger is senderless. */
declare function sentryTrigger(issue: SentryIssue, account: {
  url: string;
  orgSlug: string;
}): Trigger;
/** The retained source reference for a Trigger, used by thread readers. */
interface SentryRef {
  issueId: string;
}
declare function sentryRef(trigger: Trigger): SentryRef | undefined;
//#endregion
//#region src/sources/sentry-api.d.ts
/** Calls the Sentry-compatible API with the Source's token. */
declare function sentryFetch(account: SentryAccount, path: string, init?: RequestInit, signal?: AbortSignal): Promise<unknown>;
//#endregion
//#region src/sources/sentry-read.d.ts
/** The thread context reader used by assessments and by `orchestrator_read` on a Trigger. */
declare const sentryThreadContext: ThreadContext<{
  readPageSize: number;
}>;
//#endregion
//#region src/sources/sentry-loops.d.ts
declare const runSentry: (ctx: SourceContext, signal: AbortSignal) => Promise<unknown>;
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
declare function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined;
//#endregion
//#region src/sources/sentry.d.ts
/** Configuration of the Sentry Source: the Sentry-compatible account it reads with, and what it watches. */
declare const SentryConfigSchema: z.ZodObject<{
  url: z.ZodDefault<z.ZodString>;
  orgSlug: z.ZodDefault<z.ZodString>;
  authToken: z.ZodDefault<z.ZodString>;
  pollSeconds: z.ZodDefault<z.ZodNumber>;
  failuresBeforeError: z.ZodDefault<z.ZodNumber>;
  readPageSize: z.ZodDefault<z.ZodNumber>;
  query: z.ZodDefault<z.ZodString>;
  projects: z.ZodDefault<z.ZodArray<z.ZodObject<{
    slug: z.ZodString;
  }, z.core.$strict>>>;
}, z.core.$strict>;
type SentryConfig = z.infer<typeof SentryConfigSchema>;
declare const sentryKind: SourceKind<SentryConfig>;
declare const name = "dsh-superagent-sentry";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { SLUG, SOURCE, type SentryAccount, SentryConfig, type SentryIssue, type SentryRef, apply, inject, name, pollFailure, resolveSentry, runSentry, sentryFetch, sentryKind, sentryLink, sentryRef, sentryThreadContext, sentryTrigger, sentryTriggerId };