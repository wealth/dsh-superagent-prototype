import { S as ChannelRef, U as Trigger, ft as MattermostBot, ht as resolveMattermostBot } from "./intake-DmDrwTW_.js";
import { i as SourceKind, n as ChannelLinks, o as SourceContext, r as ContextMessage, t as ChannelLink, y as SourceRegistry } from "./kind-Cp_d4Wsz.js";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
//#region src/sources/mattermost-trigger.d.ts
declare const SOURCE = "mattermost";
/** Reply address of a Mattermost post: its channel, and the thread root the reply goes into. */
declare const mattermostChannel: (channelId: string, postId: string, rootId?: string, direct?: boolean) => ChannelRef;
/** A post as the REST API and the `posted` WebSocket event carry it (the event stores it as a JSON string under `data.post`). */
declare const PostSchema: z.ZodObject<{
  id: z.ZodString;
  channel_id: z.ZodString;
  user_id: z.ZodString;
  message: z.ZodDefault<z.ZodString>;
  create_at: z.ZodNumber;
  root_id: z.ZodDefault<z.ZodString>;
  delete_at: z.ZodDefault<z.ZodNumber>;
  type: z.ZodDefault<z.ZodString>;
  props: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$loose>;
type MattermostPost = z.infer<typeof PostSchema>;
/** Deterministic trigger ID for a Mattermost post; every read path for the same post produces the same ID. */
declare const mattermostTriggerId: (postId: string) => string;
/** Converts a post into a Trigger, returning undefined for posts by the bot itself or system posts. */
declare function mattermostTrigger(post: MattermostPost, botId: string, channel: {
  name: string;
  direct: boolean;
  team?: string;
}, senderIsBot: boolean, mentioned: boolean): Trigger | undefined;
/** The Trigger's post ID, from the Trigger's meta. */
declare const mattermostPostId: (trigger: Trigger) => string | undefined;
/** The retained source reference for a Trigger, used by thread readers and link lookups. */
interface MattermostRef {
  triggerId: string;
  channelId: string;
  postId: string;
  at?: string;
}
declare function mattermostRef(trigger: Trigger): MattermostRef | undefined;
//#endregion
//#region src/sources/mattermost-loops.d.ts
/** Refreshes the map of channels the bot is a member of (`channel_id -> name`); throws on failure so the stored list stays. */
declare function refreshChannelNames(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>>;
//#endregion
//#region src/sources/mattermost-read.d.ts
/**
 * Reads one page of the thread the Trigger belongs to, newest first, as the model asked. `cursor` is the post id of the page's
 * oldest post; a page is 20 posts. Returns no `next` when the thread has no older posts.
 */
declare function mattermostThreadPage(bot: MattermostBot, ref: MattermostRef, rootId: string, cursor: string | undefined, pageSize: number, signal?: AbortSignal): Promise<{
  messages: ContextMessage[];
  next?: string;
}>;
//#endregion
//#region src/sources/mattermost-channel.d.ts
/** Calls the Mattermost REST API as the bot; the token stays in the request and never reaches a log or the panel. */
declare function mattermostFetch(bot: MattermostBot, path: string, init?: RequestInit, signal?: AbortSignal): Promise<unknown>;
/** Permalink of the target post on the server, when the server URL and team are known; the trigger's own link is preferred. */
declare const mattermostLink: (address: Record<string, string>, links: ChannelLinks) => ChannelLink;
//#endregion
//#region src/sources/mattermost.d.ts
/** Configuration of the Mattermost Source: its server and bot token, the channels it listens to, and what it receives. */
declare const MattermostConfigSchema: z.ZodObject<{
  url: z.ZodDefault<z.ZodString>;
  token: z.ZodDefault<z.ZodString>;
  readPageSize: z.ZodDefault<z.ZodNumber>;
  channels: z.ZodDefault<z.ZodArray<z.ZodObject<{
    channelId: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    listen: z.ZodEnum<{
      mentions: "mentions";
      all: "all";
    }>;
  }, z.core.$strict>>>;
  directMessages: z.ZodDefault<z.ZodBoolean>;
  otherChannels: z.ZodDefault<z.ZodEnum<{
    mentions: "mentions";
    none: "none";
  }>>;
}, z.core.$strict>;
type MattermostConfig = z.infer<typeof MattermostConfigSchema>;
declare const mattermostKind: SourceKind<MattermostConfig>;
/** Returns the Mattermost Source's settings, falling back to schema defaults while the plugin is disabled. */
declare const mattermostSettings: (sources: SourceRegistry) => MattermostConfig;
declare const name = "dsh-superagent-mattermost";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { type MattermostBot, MattermostConfig, type MattermostPost, SOURCE, apply, inject, mattermostChannel, mattermostFetch, mattermostKind, mattermostLink, mattermostPostId, mattermostRef, mattermostSettings, mattermostThreadPage, mattermostTrigger, mattermostTriggerId, name, refreshChannelNames, resolveMattermostBot };