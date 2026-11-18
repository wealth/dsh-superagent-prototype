import { S as ChannelRef, U as Trigger, ct as AgentmailAccount, l as OutboundMessage, pt as resolveAgentmail } from "./intake-8_Cr7w_z.js";
import { a as ThreadContext, i as SourceKind, n as ChannelLinks, o as SourceContext, t as ChannelLink } from "./kind-CWO16A0Q.js";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
//#region src/sources/agentmail-trigger.d.ts
declare const SOURCE = "agentmail";
/** Reply address of an email: the inbox that received it, its thread, and the message a reply answers. */
declare const agentmailChannel: (inboxId: string, threadId: string, messageId: string) => ChannelRef;
/** A message as the AgentMail API carries it; `timestamp` is ISO, and `in_reply_to` names the parent message. */
declare const MessageSchema: z.ZodObject<{
  message_id: z.ZodString;
  thread_id: z.ZodString;
  from: z.ZodString;
  to: z.ZodDefault<z.ZodArray<z.ZodString>>;
  timestamp: z.ZodString;
  text: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  extracted_text: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  subject: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  in_reply_to: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  labels: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$loose>;
type AgentmailMessage = z.infer<typeof MessageSchema>;
/** Strips the display name from `Display Name <user@domain>` down to the bare address. */
declare const addressOf: (value: string) => string;
/** The message body the model should read: AgentMail's extracted text when it has one, else the plain text body. */
declare const messageText: (message: AgentmailMessage) => string;
/** Deterministic trigger ID for an AgentMail message; every read path for the same message produces the same ID. */
declare const agentmailTriggerId: (messageId: string) => string;
/** Converts a message into a Trigger, returning undefined for the inbox's own outgoing messages. */
declare function agentmailTrigger(message: AgentmailMessage, inboxId: string, senderIsBot?: boolean): Trigger | undefined;
/** The Trigger's message ID, from the Trigger's meta. */
declare const agentmailMessageId: (trigger: Trigger) => string | undefined;
/** The Trigger an email reply answers, named after the message its `In-Reply-To` header carries. */
declare const agentmailParent: (trigger: Trigger) => string | undefined;
/** The retained source reference for a Trigger, used by thread readers. */
interface AgentmailRef {
  triggerId: string;
  inboxId: string;
  threadId: string;
  messageId: string;
  at?: string;
}
declare function agentmailRef(trigger: Trigger): AgentmailRef | undefined;
//#endregion
//#region src/sources/agentmail-channel.d.ts
/** Calls the AgentMail API with the Source's key; the key stays in the request and never reaches a log or the panel. */
declare function agentmailFetch(account: AgentmailAccount, path: string, init?: RequestInit, signal?: AbortSignal): Promise<unknown>;
/**
 * Replies in the thread of the target message. `message.id` is the `Idempotency-Key`: AgentMail keeps keys for a day,
 * so an Outbox retry with the same key returns the original message and sends no second email.
 */
declare function sendAgentmail(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>;
/** AgentMail exposes no web permalink for a thread, so the link carries only its label; the trigger's own link is preferred. */
declare const agentmailLink: (address: Record<string, string>, links: ChannelLinks) => ChannelLink;
//#endregion
//#region src/sources/agentmail-read.d.ts
/** The thread context reader used by assessments and by `orchestrator_read` on a Trigger. */
declare const agentmailThreadContext: ThreadContext<{
  readPageSize: number;
}>;
//#endregion
//#region src/sources/agentmail-loops.d.ts
declare const runAgentmail: (ctx: SourceContext, signal: AbortSignal) => Promise<unknown>;
//#endregion
//#region src/sources/agentmail.d.ts
declare const AgentmailConfigSchema: z.ZodObject<{
  apiKey: z.ZodDefault<z.ZodString>;
  inboxId: z.ZodDefault<z.ZodString>;
  pollSeconds: z.ZodDefault<z.ZodNumber>;
  failuresBeforeError: z.ZodDefault<z.ZodNumber>;
  readPageSize: z.ZodDefault<z.ZodNumber>;
  senders: z.ZodDefault<z.ZodArray<z.ZodObject<{
    address: z.ZodString;
  }, z.core.$strict>>>;
}, z.core.$strict>;
type AgentmailConfig = z.infer<typeof AgentmailConfigSchema>;
declare const agentmailKind: SourceKind<AgentmailConfig>;
declare const name = "dsh-superagent-agentmail";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { type AgentmailAccount, AgentmailConfig, type AgentmailMessage, SOURCE, addressOf, agentmailChannel, agentmailFetch, agentmailKind, agentmailLink, agentmailMessageId, agentmailParent, agentmailRef, agentmailThreadContext, agentmailTrigger, agentmailTriggerId, apply, inject, messageText, name, resolveAgentmail, runAgentmail, sendAgentmail };