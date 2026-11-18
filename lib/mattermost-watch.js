import { L as key, M as checkedImText, _ as pollThreads, f as resolveMattermostBot, n as sourceContext, q as threadKey, t as health, v as KV } from "./host-BhHizDUL.js";
import { z } from "zod";
//#region src/sources/mattermost-trigger.ts
/** Normalizes Mattermost posts, WebSocket events, and thread posts into domain Triggers. */
const SOURCE = "mattermost";
/** Reply address of a Mattermost post: its channel, and the thread root the reply goes into. */
const mattermostChannel = (channelId, postId, rootId, direct = false) => ({
	source: SOURCE,
	thread: `mattermost:${channelId}:${rootId || postId}`,
	address: {
		channelId,
		postId,
		...rootId ? { rootId } : {},
		...direct ? { direct: "true" } : {}
	}
});
/** A post as the REST API and the `posted` WebSocket event carry it (the event stores it as a JSON string under `data.post`). */
const PostSchema = z.looseObject({
	id: z.string(),
	channel_id: z.string(),
	user_id: z.string(),
	message: z.string().default(""),
	create_at: z.number(),
	root_id: z.string().default(""),
	delete_at: z.number().default(0),
	type: z.string().default(""),
	props: z.record(z.string(), z.unknown()).optional()
});
/** Deterministic trigger ID for a Mattermost post; every read path for the same post produces the same ID. */
const mattermostTriggerId = (postId) => key("mattermost", postId);
/** Converts a post into a Trigger, returning undefined for posts by the bot itself or system posts. */
function mattermostTrigger(post, botId, channel, senderIsBot, mentioned) {
	if (post.user_id === botId || post.type.startsWith("system_")) return void 0;
	const direct = channel.direct;
	const rootId = post.root_id || void 0;
	const thread = `${post.channel_id}:${rootId ?? post.id}`;
	return {
		id: mattermostTriggerId(post.id),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: thread
		}],
		actor: {
			source: SOURCE,
			id: post.user_id
		},
		human: !senderIsBot,
		...direct ? { addressed: "direct" } : mentioned ? { addressed: "mention" } : {},
		at: new Date(post.create_at).toISOString(),
		text: post.message,
		channel: mattermostChannel(post.channel_id, post.id, rootId, direct),
		meta: {
			channelId: post.channel_id,
			postId: post.id,
			channelName: channel.name,
			direct,
			mentioned,
			...rootId ? { rootId } : {}
		}
	};
}
/** The Trigger's post ID, from the Trigger's meta. */
const mattermostPostId = (trigger) => trigger.source === "mattermost" && typeof trigger.meta.postId === "string" ? trigger.meta.postId : void 0;
/** The post a Mattermost reply answers: its thread root when it has one, else the post itself has no parent. */
const mattermostParent = (trigger) => trigger.source === "mattermost" && typeof trigger.meta.rootId === "string" ? mattermostTriggerId(trigger.meta.rootId) : void 0;
function mattermostRef(trigger) {
	const meta = trigger.meta;
	if (trigger.source !== "mattermost" || !meta.channelId || !meta.postId) return void 0;
	return {
		triggerId: trigger.id,
		channelId: meta.channelId,
		postId: meta.postId,
		at: trigger.at
	};
}
//#endregion
//#region src/sources/mattermost-channel.ts
/** Thrown when a Mattermost request fails in a way that means the target is gone (the post or channel no longer exists). */
var MattermostError = class extends Error {
	status;
	constructor(message, status) {
		super(message);
		this.status = status;
	}
};
/** Calls the Mattermost REST API as the bot; the token stays in the request and never reaches a log or the panel. */
async function mattermostFetch(bot, path, init = {}, signal) {
	const response = await fetch(`${bot.url}/api/v4${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${bot.token}`,
			"Content-Type": "application/json",
			...init.headers
		},
		signal: AbortSignal.any([AbortSignal.timeout(3e4), ...signal ? [signal] : []])
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new MattermostError(`Mattermost ${init.method ?? "GET"} ${path} failed (${response.status}): ${body.slice(0, 300)}`, response.status);
	}
	return response.status === 204 ? void 0 : response.json();
}
/**
* Posts a reply into the thread of the target post. `message.id` is the idempotency key: Mattermost does not dedupe by key, so a
* retry first looks for a post this bot already made with the same key in `props`.
*/
async function sendMattermost(host, message) {
	const bot = host.commands.mattermost();
	const { channelId, postId, rootId } = message.channel.address;
	if (!channelId || !postId) throw new Error("Missing Mattermost reply target");
	const text = checkedImText(message.text);
	const root = rootId || postId;
	try {
		await mattermostFetch(bot, "/posts", {
			method: "POST",
			body: JSON.stringify({
				channel_id: channelId,
				root_id: root,
				message: text,
				props: { dsh_superagent_message_id: message.id }
			})
		});
	} catch (error) {
		if (error instanceof MattermostError && (error.status === 404 || error.status === 403)) return "gone";
		throw error;
	}
	return "sent";
}
/** Permalink of the target post on the server, when the server URL and team are known; the trigger's own link is preferred. */
const mattermostLink = (address, links) => {
	const bot = links.mattermost;
	const postId = address.postId ?? "";
	return {
		url: bot && postId ? `${bot.url}/_redirect/pl/${encodeURIComponent(postId)}` : "",
		label: {
			zh: "Mattermost 消息",
			en: "Mattermost message",
			ru: "Сообщение в Mattermost"
		},
		triggerId: postId ? mattermostTriggerId(postId) : void 0
	};
};
//#endregion
//#region src/sources/mattermost-read.ts
/** Trigger-scoped Mattermost context reader: a thread page, the root, or the post a reply answers. */
/** A thread page from the REST API: `order` is a post id list, `posts` maps id to post. */
const ThreadSchema = z.object({
	order: z.array(z.string()),
	posts: z.record(z.string(), PostSchema)
});
const UserSchema = z.looseObject({
	id: z.string(),
	username: z.string().default(""),
	is_bot: z.boolean().optional()
});
/** Reads one post of the Trigger's channel and checks it belongs there. */
async function readPost(bot, ref, postId, signal) {
	const post = PostSchema.parse(await mattermostFetch(bot, `/posts/${encodeURIComponent(postId)}`, {}, signal));
	if (post.channel_id !== ref.channelId) throw new Error("Mattermost returned a post outside the source channel");
	return post;
}
/** Formats a Mattermost post as context for the model; the author is the username, and deleted posts show as empty. */
function mattermostView(post, username, isBot) {
	return {
		id: post.id,
		from: username(post.user_id) ?? post.user_id,
		at: new Date(post.create_at).toISOString(),
		text: post.delete_at ? "" : post.message,
		...isBot ? { bot: true } : {},
		...post.delete_at ? { deleted: true } : {},
		...post.root_id ? { reply_to: post.root_id } : {}
	};
}
/**
* Reads one page of the thread the Trigger belongs to, newest first, as the model asked. `cursor` is the post id of the page's
* oldest post; a page is 20 posts. Returns no `next` when the thread has no older posts.
*/
async function mattermostThreadPage(bot, ref, rootId, cursor, pageSize, signal) {
	const query = new URLSearchParams({ per_page: String(pageSize) });
	if (cursor) query.set("before", cursor);
	const thread = ThreadSchema.parse(await mattermostFetch(bot, `/posts/${encodeURIComponent(rootId)}/thread?${query}`, {}, signal));
	const posts = thread.order.flatMap((id) => thread.posts[id] ?? []);
	if (posts.find((post) => post.channel_id !== ref.channelId)) throw new Error("Mattermost returned posts outside the source channel");
	const users = await usernames(bot, [...new Set(posts.map((post) => post.user_id))], signal);
	const messages = posts.map((post) => mattermostView(post, (id) => users.get(id)?.name, users.get(post.user_id)?.bot === true));
	const oldest = thread.order.at(-1);
	return {
		messages,
		...thread.order.length >= pageSize && oldest ? { next: oldest } : {}
	};
}
/** Resolves user IDs to usernames and bot flags in one request. */
async function usernames(bot, ids, signal) {
	if (!ids.length) return /* @__PURE__ */ new Map();
	const users = z.array(UserSchema).parse(await mattermostFetch(bot, "/users/ids", {
		method: "POST",
		body: JSON.stringify(ids)
	}, signal));
	return new Map(users.map((user) => [user.id, {
		name: user.username,
		bot: user.is_bot === true
	}]));
}
/** The thread context reader used by assessments and by `orchestrator_read` on a Trigger. */
const mattermostThreadContext = {
	messageId: (trigger) => String(trigger.meta.postId ?? ""),
	read: async (commands, trigger, part, cursor, config) => {
		const bot = commands.mattermost();
		const ref = mattermostRef(trigger);
		if (!ref) throw new Error("A Mattermost source trigger is required");
		const rootId = typeof trigger.meta.rootId === "string" ? trigger.meta.rootId : ref.postId;
		if (part === "root") {
			const root = await readPost(bot, ref, rootId);
			const users = await usernames(bot, [root.user_id]);
			return {
				messages: [mattermostView(root, (id) => users.get(id)?.name, users.get(root.user_id)?.bot === true)],
				body: { status: "available" },
				status: "available"
			};
		}
		if (part === "parent") {
			const parent = trigger.meta.parentId;
			if (typeof parent !== "string") return {
				messages: [],
				body: { status: "no_parent" },
				status: "no_parent"
			};
			const post = await readPost(bot, ref, parent.replace(/^mattermost:/, ""));
			const users = await usernames(bot, [post.user_id]);
			return {
				messages: [mattermostView(post, (id) => users.get(id)?.name, users.get(post.user_id)?.bot === true)],
				body: { status: "available" },
				status: "available"
			};
		}
		const page = await mattermostThreadPage(bot, ref, rootId, cursor, config.readPageSize);
		return {
			messages: page.messages,
			next: page.next,
			body: { status: "available" },
			status: "available"
		};
	}
};
//#endregion
//#region src/sources/mattermost-loops.ts
/** Mattermost background loops: the WebSocket event stream, subscribed-thread polling, and channel name refresh. */
const runMattermost = (ctx, signal) => Promise.allSettled([
	watch,
	pollLoop,
	channelNamesLoop
].map((loop) => loop(ctx, signal)));
const enabled = (ctx) => ctx.config(SOURCE);
const bot = (ctx) => {
	const resolved = ctx.deployment.mattermost;
	if (!resolved) throw new Error("The Mattermost Source has no working bot");
	return resolved;
};
/** Receives a Trigger and labels the Thread with its channel name and URL. */
async function receive(ctx, trigger) {
	await ctx.receive(trigger);
	const channelId = String(trigger.meta.channelId ?? "");
	if (!channelId) return;
	const name = ctx.state.get(KV.sources.labels("mattermost"))?.[channelId] ?? String(trigger.meta.channelName ?? channelId);
	const channel = trigger.meta.direct === true ? { value: {
		zh: "私信",
		en: "Direct message",
		ru: "Личные сообщения"
	} } : { value: name };
	for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), {
		url: channelLink(ctx, channelId),
		facts: { channel }
	});
}
const channelLink = (ctx, channelId) => {
	const server = ctx.deployment.mattermost?.url;
	return server ? `${server}/_redirect/channel/${encodeURIComponent(channelId)}` : "";
};
function available(ctx) {
	if (ctx.configured() && ctx.deployment.mattermost) return true;
	const waiting = health("paused", ctx.configured() ? "mattermostUnset" : "setupPending");
	ctx.report(SOURCE, ctx.problem ? {
		state: "paused",
		detail: ctx.problem.detail
	} : waiting);
	return false;
}
/** Runs the WebSocket event stream only while the Source is enabled; disabling it stops the stream within five seconds. */
async function watch(ctx, signal) {
	await ctx.ready;
	if (!available(ctx)) return;
	let retry;
	while (!signal.aborted) {
		if (!enabled(ctx)) {
			ctx.report(SOURCE, health("paused", "sourceOff"));
			await sleep(5e3, signal);
			continue;
		}
		const running = new AbortController();
		const check = setInterval(() => {
			if (!enabled(ctx)) running.abort();
		}, 5e3);
		const stop = () => running.abort();
		signal.addEventListener("abort", stop, { once: true });
		const began = Date.now();
		try {
			await consume(ctx, running.signal);
		} catch (error) {
			if (!running.signal.aborted) ctx.report(SOURCE, {
				state: "error",
				detail: String(error)
			});
		} finally {
			clearInterval(check);
			signal.removeEventListener("abort", stop);
		}
		if (running.signal.aborted) continue;
		retry = consumerRetry(retry, Date.now() - began);
		await sleep(retry, signal);
	}
}
/** Wait before reconnecting: 1s after a connection that stayed up for a minute, otherwise exponential backoff up to 60s. */
const consumerRetry = (previous, ranMs) => previous === void 0 || ranMs >= 6e4 ? 1e3 : Math.min(previous * 2, 6e4);
const sleep = (ms, signal) => new Promise((resolve) => {
	if (signal.aborted) {
		resolve();
		return;
	}
	const timer = setTimeout(() => {
		signal.removeEventListener("abort", stop);
		resolve();
	}, ms);
	const stop = () => {
		clearTimeout(timer);
		resolve();
	};
	signal.addEventListener("abort", stop, { once: true });
});
/** One WebSocket session: authenticate with the bot token, then turn each `posted` event into a Trigger. */
async function consume(ctx, signal) {
	const server = bot(ctx);
	const url = `${server.url.replace(/^http/, "ws")}/api/v4/websocket`;
	const socket = new WebSocket(url);
	let chain = Promise.resolve();
	let seq = 1;
	await new Promise((resolve, reject) => {
		const close = () => {
			socket.close();
			resolve();
		};
		signal.addEventListener("abort", close, { once: true });
		socket.onopen = () => socket.send(JSON.stringify({
			seq: seq++,
			action: "authentication_challenge",
			data: { token: server.token }
		}));
		socket.onerror = () => reject(/* @__PURE__ */ new Error(`Mattermost WebSocket failed at ${server.url}`));
		socket.onclose = (event) => signal.aborted ? resolve() : reject(/* @__PURE__ */ new Error(`Mattermost WebSocket closed (${event.code})`));
		socket.onmessage = (message) => {
			const event = parseEvent(String(message.data));
			if (!event) return;
			chain = chain.then(async () => {
				if (event.event === "hello") {
					ctx.report(SOURCE, {
						state: "ready",
						detail: "Listening for bot events",
						at: (/* @__PURE__ */ new Date()).toISOString()
					});
					return;
				}
				if (event.event !== "posted") return;
				if (!enabled(ctx)) return;
				const trigger = await triggerOf(ctx, PostSchema.parse(JSON.parse(String(event.data.post))), event.data);
				if (trigger) await receive(ctx, trigger);
			}).catch((error) => {
				ctx.report(SOURCE, {
					state: "error",
					detail: String(error)
				});
			});
		};
	}).finally(async () => {
		socket.close();
		await chain;
	});
}
/** Parses one WebSocket frame; frames that are not JSON objects are ignored. */
function parseEvent(text) {
	try {
		const value = JSON.parse(text);
		return typeof value.event === "string" ? {
			event: value.event,
			data: value.data ?? {}
		} : void 0;
	} catch {
		return;
	}
}
/** Builds a Trigger from a posted event; the channel type and the bot mention come from the event data. */
async function triggerOf(ctx, post, data) {
	const server = bot(ctx);
	const direct = data.channel_type === "D";
	const channelName = String(data.channel_display_name ?? data.channel_name ?? post.channel_id);
	const mentioned = typeof data.mentions === "string" && data.mentions.split(",").includes(server.botId);
	const senderIsBot = data.sender_type === "bot";
	const channel = {
		name: channelName,
		direct
	};
	if (!direct) ctx.state.set(KV.mattermost.channels, {
		...ctx.state.get(KV.mattermost.channels) ?? {},
		[post.channel_id]: direct
	});
	return mattermostTrigger(post, server.botId, channel, senderIsBot, mentioned);
}
/** Refreshes the map of channels the bot is a member of (`channel_id -> name`); throws on failure so the stored list stays. */
async function refreshChannelNames(ctx, signal) {
	const server = bot(ctx);
	const channels = z.array(z.looseObject({
		id: z.string(),
		display_name: z.string().default(""),
		name: z.string().default(""),
		type: z.string().default("O")
	})).parse(await mattermostFetch(server, `/users/${server.botId}/channels?team_id=`, {}, signal));
	const names = Object.fromEntries(channels.filter((channel) => channel.type !== "D").map((channel) => [channel.id, channel.display_name || channel.name]));
	ctx.state.set(KV.sources.labels(SOURCE), names);
	return names;
}
/** Rereads the channel list every minute so newly joined channels appear within a minute. */
async function channelNamesLoop(ctx, signal) {
	await ctx.ready;
	if (!available(ctx)) return;
	while (!signal.aborted) {
		if (enabled(ctx)) try {
			await refreshChannelNames(ctx, signal);
		} catch {}
		await sleep(6e4, signal);
	}
}
/** Polls subscribed threads within the polling horizon so replies missed by the live stream become triggers. */
async function pollLoop(ctx, signal) {
	await ctx.ready;
	if (!available(ctx)) return;
	while (!signal.aborted) {
		const config = enabled(ctx);
		if (!config) ctx.report(SOURCE, health("paused", "sourceOff"));
		else try {
			await pollThreads(ctx, SOURCE, () => signal.aborted, (thread) => pollThread(ctx, thread, signal, config.readPageSize));
			ctx.report(SOURCE, {
				state: "ready",
				detail: "Subscribed Threads polled",
				at: (/* @__PURE__ */ new Date()).toISOString()
			});
		} catch (error) {
			if (!signal.aborted) ctx.report(SOURCE, {
				state: "error",
				detail: String(error)
			});
		}
		await sleep(6e4, signal);
	}
}
/** Polls one subscribed Thread: new posts since the last checkpoint become Triggers, older ones are not re-read. */
async function pollThread(ctx, thread, signal, pageSize) {
	const channelId = String(thread.meta.channelId ?? "");
	const rootId = String(thread.meta.rootId ?? "");
	if (!channelId || !rootId) throw new Error("Subscribed thread has no retained source post");
	const ref = {
		triggerId: "",
		channelId,
		postId: rootId
	};
	const checkpoint = KV.mattermost.seen(thread.key);
	const known = new Set(ctx.state.get(checkpoint) ?? []);
	const since = Date.parse(thread.createdAt);
	const page = await mattermostThreadPage(bot(ctx), ref, rootId, void 0, pageSize, signal);
	const fresh = page.messages.filter((message) => !known.has(message.id) && Date.parse(message.at) >= since - 5e3);
	for (const message of fresh.reverse()) {
		if (signal.aborted) return;
		const trigger = mattermostTrigger(PostSchema.parse({
			id: message.id,
			channel_id: ref.channelId,
			user_id: message.from,
			message: message.text,
			create_at: Date.parse(message.at),
			root_id: rootId
		}), bot(ctx).botId, {
			name: String(thread.meta.channelName ?? channelId),
			direct: false
		}, message.bot === true, false);
		if (trigger) await receive(ctx, trigger);
	}
	page.messages.forEach((message) => known.add(message.id));
	ctx.state.set(checkpoint, [...known].slice(-500));
}
//#endregion
//#region src/sources/mattermost.ts
/** Configuration of the Mattermost Source: its server and bot token, the channels it listens to, and what it receives. */
const MattermostConfigSchema = z.object({
	url: z.string().trim().default(""),
	token: z.string().trim().default(""),
	readPageSize: z.number().int().min(1).max(50).default(20),
	channels: z.array(z.object({
		channelId: z.string().regex(/^[a-z0-9]{26}$/),
		name: z.string().trim().max(60).optional(),
		listen: z.enum(["mentions", "all"])
	}).strict()).refine((channels) => new Set(channels.map((channel) => channel.channelId)).size === channels.length, "Duplicate channel IDs").default([]),
	directMessages: z.boolean().default(true),
	otherChannels: z.enum(["none", "mentions"]).default("none")
}).strict();
const mattermostKind = {
	kind: SOURCE,
	order: 20,
	refreshLabels: (host, signal) => refreshChannelNames(sourceContext(host, mattermostKind), signal),
	title: {
		zh: "Mattermost",
		en: "Mattermost",
		ru: "Mattermost"
	},
	description: {
		zh: "接收下列频道和私信里发给机器人的消息，并轮询订阅的线程。",
		en: "Receives messages to the bot in these channels and direct messages, and polls subscribed Threads.",
		ru: "Принимает сообщения боту в перечисленных каналах и личных сообщениях и опрашивает подписанные треды."
	},
	schema: MattermostConfigSchema,
	fields: [
		{
			key: "url",
			type: "text",
			label: {
				zh: "服务器地址",
				en: "Server URL",
				ru: "Адрес сервера"
			},
			hint: {
				zh: "写作 https://mattermost.example.com，不带末尾斜杠。保存时用机器人令牌检查服务器并重启 dsh-superagent。",
				en: "Written as https://mattermost.example.com, without a trailing slash. Saving checks the server with the bot token, then restarts dsh-superagent.",
				ru: "Пишется как https://mattermost.example.com, без завершающего слеша. При сохранении сервер проверяется токеном бота, затем dsh-superagent перезапускается."
			}
		},
		{
			key: "token",
			type: "text",
			label: {
				zh: "机器人令牌",
				en: "Bot token",
				ru: "Токен бота"
			},
			hint: {
				zh: "机器人账号的个人访问令牌。只保存在本机的 DSH 配置里，不在面板上显示。",
				en: "A personal access token of the bot account. Kept in the local DSH configuration; the panel never shows it.",
				ru: "Персональный токен доступа учётной записи бота. Хранится в локальной конфигурации DSH, в панели не показывается."
			}
		},
		{
			key: "bot",
			label: {
				zh: "机器人",
				en: "Bot",
				ru: "Бот"
			},
			type: "fact",
			settings: "deployment"
		},
		{
			key: "channels",
			type: "rows",
			label: {
				zh: "接收的频道",
				en: "Channels",
				ru: "Каналы"
			},
			hint: {
				zh: "“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可以按规则从中推断工作。",
				en: "\"@ only\" receives messages that mention the bot and Threads that have Tickets; \"All\" also receives the rest, from which Eval may infer work under the rules.",
				ru: "«Только @» принимает сообщения с упоминанием бота и треды с тикетами; «Все сообщения» принимает и остальные, из которых оценка может вывести работу по правилам."
			},
			columns: [{
				key: "channelId",
				type: "text",
				label: {
					zh: "频道",
					en: "Channel",
					ru: "Канал"
				},
				pattern: "[a-z0-9]{26}",
				choose: {
					zh: "选择机器人所在的频道",
					en: "Choose a channel the bot is in",
					ru: "Выберите канал, в котором есть бот"
				},
				refresh: {
					zh: "刷新频道列表",
					en: "Refresh channels",
					ru: "Обновить список каналов"
				}
			}, {
				key: "listen",
				type: "select",
				label: {
					zh: "接收",
					en: "Receive",
					ru: "Принимать"
				},
				options: [{
					value: "mentions",
					label: {
						zh: "仅 @",
						en: "@ only",
						ru: "Только @"
					}
				}, {
					value: "all",
					label: {
						zh: "全部消息",
						en: "All",
						ru: "Все сообщения"
					}
				}]
			}]
		},
		{
			key: "otherChannels",
			type: "select",
			label: {
				zh: "其他频道",
				en: "Other channels",
				ru: "Другие каналы"
			},
			options: [{
				value: "none",
				label: {
					zh: "不接收",
					en: "Not received",
					ru: "Не принимать"
				}
			}, {
				value: "mentions",
				label: {
					zh: "仅 @",
					en: "@ only",
					ru: "Только @"
				}
			}],
			hint: {
				zh: "机器人所在、但没列在上面的频道。“仅 @”接收那里 @ 机器人的消息。",
				en: "Channels the bot is in that are not listed above. \"@ only\" receives messages there that mention the bot.",
				ru: "Каналы, в которых есть бот, но которых нет в списке выше. «Только @» принимает там сообщения с упоминанием бота."
			}
		},
		{
			key: "directMessages",
			type: "switch",
			label: {
				zh: "接收私信",
				en: "Direct messages",
				ru: "Личные сообщения"
			}
		},
		{
			key: "readPageSize",
			type: "number",
			advanced: true,
			min: 1,
			max: 50,
			label: {
				zh: "每页消息数",
				en: "Messages per page",
				ru: "Сообщений на странице"
			},
			hint: {
				zh: "智能体读取线程时，每页的消息数。",
				en: "Messages per page when agents read Threads.",
				ru: "Сообщений на странице, когда агенты читают треды."
			}
		}
	],
	health: ["mattermost", "history"],
	scope({ meta }, config) {
		if (meta.direct === true) return config.directMessages ? {
			listened: true,
			observed: false,
			row: "direct"
		} : {
			listened: false,
			reason: "direct_messages_not_allowed"
		};
		const channel = config.channels.find((item) => item.channelId === meta.channelId);
		if (channel) return {
			listened: true,
			observed: channel.listen === "all",
			row: channel.channelId
		};
		return config.otherChannels === "mentions" ? {
			listened: true,
			observed: false,
			row: "other"
		} : {
			listened: false,
			reason: "channel_not_allowed"
		};
	},
	channel: {
		allowed: (address, config) => mattermostKind.scope({ meta: {
			channelId: address.channelId ?? "",
			direct: address.direct === "true"
		} }, config).listened,
		send: sendMattermost,
		link: mattermostLink
	},
	threadContext: mattermostThreadContext,
	find: (query) => ({
		threads: [],
		terms: [...new Set(query.match(/\b[a-z0-9]{26}\b/g) ?? [])]
	}),
	repliesTo: (trigger) => {
		return mattermostParent(trigger);
	},
	policy: {
		unnamed: {
			person: {
				zh: "Mattermost 用户",
				en: "Mattermost user",
				ru: "Пользователь Mattermost"
			},
			bot: {
				zh: "Mattermost 机器人",
				en: "Mattermost bot",
				ru: "Бот Mattermost"
			}
		},
		schema: z.object({
			allowed: z.array(z.object({
				id: z.string().regex(/^[a-z0-9]{26}$/),
				name: z.string().trim().max(100).optional()
			}).strict()).refine((users) => new Set(users.map((user) => user.id)).size === users.length, "Duplicate user IDs").default([]),
			syncChannel: z.string().regex(/^([a-z0-9]{26})?$/).default(""),
			bots: z.array(z.object({
				id: z.string().regex(/^[a-z0-9]{26}$/),
				name: z.string().trim().max(100).optional()
			}).strict()).refine((bots) => new Set(bots.map((bot) => bot.id)).size === bots.length, "Duplicate bot ids").optional()
		}).strict(),
		fields: [
			{
				key: "allowed",
				type: "rows",
				label: {
					zh: "能发起工作的 Mattermost 用户",
					en: "Mattermost users who may originate work",
					ru: "Пользователи Mattermost, которые могут запускать работу"
				},
				columns: [{
					key: "id",
					type: "text",
					label: {
						zh: "用户 ID",
						en: "User ID",
						ru: "ID пользователя"
					},
					pattern: "[a-z0-9]{26}"
				}, {
					key: "name",
					type: "text",
					label: {
						zh: "名字",
						en: "Name",
						ru: "Имя"
					},
					optional: true
				}]
			},
			{
				key: "syncChannel",
				type: "text",
				pattern: "([a-z0-9]{26})?",
				label: {
					zh: "同步来源频道",
					en: "Sync channel",
					ru: "Канал синхронизации"
				},
				choose: {
					zh: "不同步",
					en: "Do not sync",
					ru: "Не синхронизировать"
				},
				hint: {
					zh: "同步时，名单变成这个频道里的人：新成员加入，离开的人移除，名字取用户名。启动时和点同步时进行。",
					en: "Syncing makes the list the people in this channel: new members join, people who left are removed, and names follow usernames. It runs at startup and on Sync.",
					ru: "При синхронизации список становится участниками этого канала: новые добавляются, ушедшие удаляются, имена берутся из логинов."
				}
			},
			{
				key: "bots",
				type: "rows",
				label: {
					zh: "消息可以成为候选的机器人",
					en: "Bots whose messages may become candidates",
					ru: "Боты, чьи сообщения могут стать кандидатами"
				},
				hint: {
					zh: "名单里的机器人在接收的频道里发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。",
					en: "Messages of a bot on this list, in channels the Source receives, become inferred candidates for an assessment; they never make an explicit request or stop a ticket.",
					ru: "Сообщения бота из этого списка в принимаемых каналах становятся выведенными кандидатами для оценки; они не могут запустить явный запрос или остановить тикет."
				},
				columns: [{
					key: "id",
					type: "text",
					label: {
						zh: "用户 ID",
						en: "User ID",
						ru: "ID пользователя"
					},
					pattern: "[a-z0-9]{26}"
				}, {
					key: "name",
					type: "text",
					label: {
						zh: "名字",
						en: "Name",
						ru: "Имя"
					},
					optional: true
				}]
			}
		],
		explicit: {
			zh: "名单内的人 @ 机器人或私信机器人，总是明确的请求，不需要配置。",
			en: "Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.",
			ru: "Человек из списка, который упоминает бота или пишет ему лично, всегда делает явный запрос; настройка не нужна."
		},
		rows(stored) {
			const config = MattermostConfigSchema.parse(stored);
			const mentions = {
				zh: "仅 @",
				en: "@ only",
				ru: "Только @"
			};
			return [
				...config.channels.map((channel) => ({
					id: channel.channelId,
					label: channel.name || channel.channelId,
					note: channel.listen === "all" ? {
						zh: "全部消息",
						en: "All",
						ru: "Все сообщения"
					} : mentions,
					cells: {
						listedUnaddressed: channel.listen === "all",
						unlistedAddressed: true,
						unlistedUnaddressed: channel.listen === "all"
					}
				})),
				{
					id: "other",
					label: {
						zh: "其他频道",
						en: "Other channels",
						ru: "Другие каналы"
					},
					note: config.otherChannels === "mentions" ? mentions : {
						zh: "不接收",
						en: "Not received",
						ru: "Не принимать"
					},
					cells: {
						listedUnaddressed: false,
						unlistedAddressed: config.otherChannels === "mentions",
						unlistedUnaddressed: false
					}
				},
				{
					id: "direct",
					label: {
						zh: "私信",
						en: "Direct messages",
						ru: "Личные сообщения"
					},
					note: config.directMessages ? {
						zh: "接收",
						en: "Received",
						ru: "Принимать"
					} : {
						zh: "不接收",
						en: "Not received",
						ru: "Не принимать"
					},
					cells: {
						listedUnaddressed: false,
						unlistedAddressed: config.directMessages,
						unlistedUnaddressed: false
					}
				}
			];
		},
		sync: {
			label: {
				zh: "立即同步",
				en: "Sync now",
				ru: "Синхронизировать"
			},
			ready: (part) => !!part.syncChannel,
			async run(host, part, signal) {
				const bot = sourceContext(host, mattermostKind).commands.withSignal(signal).mattermost();
				const active = z.array(z.looseObject({
					user_id: z.string(),
					delete_at: z.number().default(0)
				})).parse(await mattermostFetch(bot, `/channels/${part.syncChannel}/members?per_page=200`, {}, signal)).filter((member) => !member.delete_at).map((member) => member.user_id);
				const users = z.array(z.looseObject({
					id: z.string(),
					username: z.string()
				})).parse(await mattermostFetch(bot, "/users/ids", {
					method: "POST",
					body: JSON.stringify(active)
				}, signal));
				const names = new Map(users.map((user) => [user.id, user.username]));
				const known = new Set(part.allowed.map((entry) => entry.id));
				return {
					...part,
					allowed: [...part.allowed.filter((entry) => names.has(entry.id)).map((entry) => ({
						...entry,
						name: names.get(entry.id)
					})), ...users.filter((user) => !known.has(user.id)).map((user) => ({
						id: user.id,
						name: user.username
					}))]
				};
			}
		}
	},
	environment: {
		variables: [{
			key: "DSH_SUPERAGENT_MATTERMOST_BOT",
			description: {
				zh: "Mattermost 机器人用户名",
				en: "The Mattermost bot username",
				ru: "Имя пользователя бота Mattermost"
			}
		}, {
			key: "DSH_SUPERAGENT_MATTERMOST_CHANNEL",
			description: {
				zh: "接下工单的 Mattermost 频道 ID；工单不是从 Mattermost 来的时为空",
				en: "Channel ID of the Mattermost channel that started the ticket; empty when the ticket did not start on Mattermost",
				ru: "ID канала Mattermost, в котором начался тикет; пусто, если тикет начался не в Mattermost"
			}
		}],
		values: ({ deployment, trigger }) => ({
			DSH_SUPERAGENT_MATTERMOST_BOT: deployment.mattermost?.username ?? "",
			DSH_SUPERAGENT_MATTERMOST_CHANNEL: trigger?.source === "mattermost" ? String(trigger.meta.channelId ?? "") : ""
		})
	},
	facts: (deployment) => deployment?.mattermost ? { bot: {
		zh: `当前机器人 @${deployment.mattermost.username}`,
		en: `Current bot @${deployment.mattermost.username}`,
		ru: `Текущий бот @${deployment.mattermost.username}`
	} } : {}
};
/** Returns the Mattermost Source's settings, falling back to schema defaults while the plugin is disabled. */
const mattermostSettings = (sources) => sources.instance("mattermost")?.config ?? MattermostConfigSchema.parse({});
const name = "dsh-superagent-mattermost";
const inject = ["orchestrator"];
function apply(ctx) {
	ctx.effect(() => ctx.orchestrator.sources.register(mattermostKind), "mattermost: source kind");
	ctx.effect(() => {
		const controller = new AbortController();
		const running = runMattermost(sourceContext(ctx.orchestrator, mattermostKind), controller.signal);
		return async () => {
			controller.abort();
			await running;
		};
	});
}
//#endregion
export { SOURCE, apply, inject, mattermostChannel, mattermostFetch, mattermostKind, mattermostLink, mattermostPostId, mattermostRef, mattermostSettings, mattermostThreadPage, mattermostTrigger, mattermostTriggerId, name, refreshChannelNames, resolveMattermostBot };
