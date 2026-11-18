import { S as ChannelRef, U as Trigger, gt as resolveTelegram, l as OutboundMessage, pt as TelegramBot } from "./intake-DmDrwTW_.js";
import { a as ThreadContext, i as SourceKind, n as ChannelLinks, o as SourceContext, t as ChannelLink } from "./kind-CgJZhbQ4.js";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
//#region src/sources/telegram-trigger.d.ts
declare const SOURCE = "telegram";
/** Reply address of a Telegram message: the chat it was posted in, and the message a reply answers. */
declare const telegramChannel: (chatId: string, messageId: string) => ChannelRef;
/** A Telegram update as the Bot API carries it; only text messages of a user become Triggers. */
declare const UpdateSchema: z.ZodObject<{
  update_id: z.ZodNumber;
  message: z.ZodOptional<z.ZodNullable<z.ZodObject<{
    message_id: z.ZodNumber;
    date: z.ZodNumber;
    chat: z.ZodObject<{
      id: z.ZodNumber;
    }, z.core.$loose>;
    from: z.ZodOptional<z.ZodNullable<z.ZodObject<{
      id: z.ZodNumber;
      username: z.ZodOptional<z.ZodNullable<z.ZodString>>;
      first_name: z.ZodOptional<z.ZodNullable<z.ZodString>>;
      is_bot: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    }, z.core.$loose>>>;
    text: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  }, z.core.$loose>>>;
}, z.core.$loose>;
type TelegramUpdate = z.infer<typeof UpdateSchema>;
/** Deterministic trigger ID for a Telegram message; every read path for the same message produces the same ID. */
declare const telegramTriggerId: (messageId: number) => string;
/** Converts a text message into a Trigger, returning undefined for the bot's own outgoing messages and non-text updates. */
declare function telegramTrigger(update: TelegramUpdate, botId: number): Trigger | undefined;
/** The Trigger's message ID, from the Trigger's meta. */
declare const telegramMessageId: (trigger: Trigger) => string | undefined;
/** The retained source reference for a Trigger, used by thread readers. */
interface TelegramRef {
  triggerId: string;
  chatId: string;
  messageId: string;
  at?: string;
}
declare function telegramRef(trigger: Trigger): TelegramRef | undefined;
//#endregion
//#region src/sources/telegram-channel.d.ts
/** Calls the Bot API with the Source's token; the token stays in the request and never reaches a log or the panel. */
declare function telegramFetch(bot: TelegramBot, method: string, init?: RequestInit, signal?: AbortSignal): Promise<unknown>;
/** Sends a reply into the chat of the target message. Telegram dedupes nothing, so retries reuse the same text only after Outbox backs off. */
declare function sendTelegram(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>;
/** Telegram exposes no permalink for a bot chat, so the link carries only its label; the trigger's own link is preferred. */
declare const telegramLink: (address: Record<string, string>, links: ChannelLinks) => ChannelLink;
//#endregion
//#region src/sources/telegram-read.d.ts
/**
 * The Bot API exposes no chat history to bots, so a read returns the Trigger's own message and reports no pagination;
 * the ticket's delivery carries the rest of the conversation.
 */
declare const telegramThreadContext: ThreadContext<Record<string, unknown>>;
//#endregion
//#region src/sources/telegram-loops.d.ts
declare const runTelegram: (ctx: SourceContext, signal: AbortSignal) => Promise<unknown>;
//#endregion
//#region src/sources/telegram.d.ts
/** Configuration of the Telegram Source: the bot that talks for the agent, and whose messages it receives. */
declare const TelegramConfigSchema: z.ZodObject<{
  botToken: z.ZodDefault<z.ZodString>;
  failuresBeforeError: z.ZodDefault<z.ZodNumber>;
  senders: z.ZodDefault<z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>>>;
}, z.core.$strict>;
type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
declare const telegramKind: SourceKind<TelegramConfig>;
declare const name = "dsh-superagent-telegram";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { SOURCE, type TelegramBot, TelegramConfig, type TelegramUpdate, apply, inject, name, resolveTelegram, runTelegram, sendTelegram, telegramChannel, telegramFetch, telegramKind, telegramLink, telegramMessageId, telegramRef, telegramThreadContext, telegramTrigger, telegramTriggerId };