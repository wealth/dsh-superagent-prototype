import { P as checkedImText, Y as threadKey, b as KV, n as sourceContext, p as resolveTelegram, t as health, v as pause, z as key } from "./host-DD7_lg52.js";
import { z } from "zod";
//#region src/sources/telegram-trigger.ts
/** Normalizes Telegram bot updates into domain Triggers. */
const SOURCE = "telegram";
/** Reply address of a Telegram message: the chat it was posted in, and the message a reply answers. */
const telegramChannel = (chatId, messageId) => ({
	source: SOURCE,
	thread: `telegram:${chatId}`,
	address: {
		chatId,
		messageId
	}
});
/** A Telegram update as the Bot API carries it; only text messages of a user become Triggers. */
const UpdateSchema = z.looseObject({
	update_id: z.number(),
	message: z.looseObject({
		message_id: z.number(),
		date: z.number(),
		chat: z.looseObject({ id: z.number() }),
		from: z.looseObject({
			id: z.number(),
			username: z.string().nullish(),
			first_name: z.string().nullish(),
			is_bot: z.boolean().nullish()
		}).nullish(),
		text: z.string().nullish()
	}).nullish()
});
/** Deterministic trigger ID for a Telegram message; every read path for the same message produces the same ID. */
const telegramTriggerId = (messageId) => key("telegram", String(messageId));
/** Converts a text message into a Trigger, returning undefined for the bot's own outgoing messages and non-text updates. */
function telegramTrigger(update, botId) {
	const message = update.message;
	const from = message?.from;
	if (!message || !from || !message.text?.trim() || from.is_bot || from.id === botId) return void 0;
	return {
		id: telegramTriggerId(message.message_id),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: String(message.chat.id)
		}],
		actor: {
			source: SOURCE,
			id: String(from.id)
		},
		human: true,
		addressed: "direct",
		at: (/* @__PURE__ */ new Date(message.date * 1e3)).toISOString(),
		text: message.text,
		channel: telegramChannel(String(message.chat.id), String(message.message_id)),
		meta: {
			chatId: String(message.chat.id),
			messageId: String(message.message_id)
		}
	};
}
/** The Trigger's message ID, from the Trigger's meta. */
const telegramMessageId = (trigger) => trigger.source === "telegram" && typeof trigger.meta.messageId === "string" ? trigger.meta.messageId : void 0;
function telegramRef(trigger) {
	const address = trigger.channel?.address;
	if (trigger.source !== "telegram" || !address?.chatId || !address.messageId) return void 0;
	return {
		triggerId: trigger.id,
		chatId: address.chatId,
		messageId: address.messageId,
		at: trigger.at
	};
}
//#endregion
//#region src/sources/telegram-channel.ts
/** Thrown when a Bot API request fails in a way that may succeed on a later retry. */
var TelegramError = class extends Error {
	status;
	constructor(message, status) {
		super(message);
		this.status = status;
	}
};
/** Calls the Bot API with the Source's token; the token stays in the request and never reaches a log or the panel. */
async function telegramFetch(bot, method, init = {}, signal) {
	const response = await fetch(`https://api.telegram.org/bot${bot.token}/${method}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			...init.headers
		},
		signal: AbortSignal.any([AbortSignal.timeout(35e3), ...signal ? [signal] : []])
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new TelegramError(`Telegram ${method} failed (${response.status}): ${body.slice(0, 300)}`, response.status);
	}
	const value = await response.json();
	if (value.ok === false) throw new TelegramError(`Telegram ${method} was refused`, response.status);
	return value;
}
/** Sends a reply into the chat of the target message. Telegram dedupes nothing, so retries reuse the same text only after Outbox backs off. */
async function sendTelegram(host, message) {
	const bot = host.commands.telegram();
	const { chatId } = message.channel.address;
	if (!chatId) throw new Error("Missing Telegram reply target");
	const text = checkedImText(message.text);
	try {
		await telegramFetch(bot, "sendMessage", {
			method: "POST",
			body: JSON.stringify({
				chat_id: chatId,
				text,
				link_preview_options: { is_disabled: true }
			})
		});
	} catch (error) {
		if (error instanceof TelegramError && (error.status === 403 || error.status === 404 || error.status === 400)) return "gone";
		throw error;
	}
	return "sent";
}
/** Telegram exposes no permalink for a bot chat, so the link carries only its label; the trigger's own link is preferred. */
const telegramLink = (address, links) => ({
	url: "",
	label: {
		zh: "Telegram 消息",
		en: "Telegram message",
		ru: "Сообщение в Telegram"
	},
	triggerId: address.messageId ? telegramTriggerId(Number(address.messageId)) : void 0
});
//#endregion
//#region src/sources/telegram-read.ts
/**
* The Bot API exposes no chat history to bots, so a read returns the Trigger's own message and reports no pagination;
* the ticket's delivery carries the rest of the conversation.
*/
const telegramThreadContext = {
	messageId: (trigger) => String(trigger.meta.messageId ?? ""),
	read: async (commands, trigger, part) => {
		commands.telegram();
		const ref = telegramRef(trigger);
		if (!ref) throw new Error("A Telegram source trigger is required");
		if (part === "parent") return {
			messages: [],
			body: { status: "no_parent" },
			status: "no_parent"
		};
		return {
			messages: [{
				id: ref.messageId,
				from: trigger.actor.id,
				at: trigger.at,
				text: trigger.text
			}],
			body: { status: "available" },
			status: "available"
		};
	}
};
//#endregion
//#region src/sources/telegram-loops.ts
/** Telegram background loop: long-polling the bot's updates and turning operator messages into Triggers. */
const runTelegram = (ctx, signal) => pollLoop(ctx, signal);
const bot = (ctx) => {
	const resolved = ctx.deployment.telegram;
	if (!resolved) throw new Error("The Telegram Source has no working bot");
	return resolved;
};
/** True when the Source still receives a message from this sender: everything while the whitelist is empty, only listed users after. */
function listened(config, update) {
	const id = String(update.message?.from?.id ?? "");
	const username = update.message?.from?.username ? `@${update.message.from.username}` : "";
	return !config.senders.length || config.senders.some((sender) => sender.id === id || sender.id.toLowerCase() === username.toLowerCase());
}
/**
* Long-polls the bot's updates. Setup restarts dsh-superagent once it verifies the bot, so until then the loop reports
* what it waits for; disabling the Source pauses it, and enabling it again resumes within one long poll.
*/
async function pollLoop(ctx, signal) {
	await ctx.ready;
	let failures = 0;
	while (!signal.aborted) {
		const config = ctx.config(SOURCE);
		if (!config) ctx.report(SOURCE, health("paused", "sourceOff"));
		else if (!ctx.configured() || !ctx.deployment.telegram) {
			const waiting = health("paused", ctx.configured() ? "telegramUnset" : "setupPending");
			ctx.report(SOURCE, ctx.problem ? {
				state: "paused",
				detail: ctx.problem.detail
			} : waiting);
			failures = 0;
		} else try {
			await pollRound(ctx, signal, config);
			failures = 0;
		} catch (error) {
			failures += 1;
			const failed = pollFailure(failures, config.failuresBeforeError, error);
			if (!signal.aborted && failed) ctx.report(SOURCE, failed);
		}
		await pause(config?.failuresBeforeError !== void 0 && failures ? 5e3 : 1e3, signal);
	}
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
function pollFailure(failures, threshold, error) {
	return failures >= threshold ? health("error", "pollFailures", {
		count: String(failures),
		error: String(error)
	}) : void 0;
}
/** The Bot API answer: an ordered list of updates. */
const UpdatesSchema = z.object({ result: z.array(UpdateSchema) });
/** One long poll: updates since the stored offset become Triggers, and the offset advances even when nothing matched. */
async function pollRound(ctx, signal, config) {
	const started = (/* @__PURE__ */ new Date()).toISOString();
	const offset = ctx.state.get(KV.telegram.offset) ?? 0;
	const query = new URLSearchParams({
		timeout: "25",
		allowed_updates: "[\"message\"]",
		...offset ? { offset: String(offset) } : {}
	});
	const answer = UpdatesSchema.parse(await telegramFetch(bot(ctx), `getUpdates?${query}`, {}, signal));
	for (const update of answer.result) {
		if (signal.aborted) return;
		ctx.atomic(() => {
			ctx.state.set(KV.telegram.offset, update.update_id + 1);
		});
		if (!update.message || !listened(config, update)) continue;
		await receive(ctx, telegramTrigger(update, bot(ctx).botId));
	}
	ctx.report(SOURCE, {
		state: "ready",
		detail: `${answer.result.length} updates; long poll ≥ 25s`,
		at: started
	});
}
/** Receives a Trigger and labels its Thread with the chat. */
async function receive(ctx, trigger) {
	if (!trigger) return;
	await ctx.receive(trigger);
	for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { from: { value: trigger.actor.id } } });
}
const telegramKind = {
	kind: SOURCE,
	order: 40,
	title: {
		zh: "Telegram",
		en: "Telegram",
		ru: "Telegram"
	},
	description: {
		zh: "机器人的 Telegram 聊天：接收运维人员发给它的消息，并长轮询机器人的更新。",
		en: "The bot's Telegram chat: receives the operators' messages to it, and long-polls the bot's updates.",
		ru: "Чат бота в Telegram: принимает сообщения операторов боту и длинным опросом читает его обновления."
	},
	schema: z.object({
		botToken: z.string().trim().default(""),
		failuresBeforeError: z.number().int().min(1).max(20).default(3),
		senders: z.array(z.object({
			id: z.string().regex(/^@?[A-Za-z0-9_]{1,64}$|^-?\d{1,20}$/),
			name: z.string().trim().max(100).optional()
		}).strict()).refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, "Duplicate senders").default([])
	}).strict(),
	fields: [
		{
			key: "botToken",
			type: "text",
			label: {
				zh: "机器人令牌",
				en: "Bot token",
				ru: "Токен бота"
			},
			hint: {
				zh: "来自 BotFather 的机器人令牌。只保存在本机的 DSH 配置里，不在面板上显示。保存时检查机器人，然后重启 dsh-superagent。",
				en: "The bot token from BotFather. Kept in the local DSH configuration; the panel never shows it. Saving checks the bot, then restarts dsh-superagent.",
				ru: "Токен бота от BotFather. Хранится в локальной конфигурации DSH, в панели не показывается. При сохранении бот проверяется, затем dsh-superagent перезапускается."
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
			key: "senders",
			type: "rows",
			label: {
				zh: "接收的发件人",
				en: "Senders to receive",
				ru: "От кого принимать сообщения"
			},
			hint: {
				zh: "名单为空时接收所有发给机器人的消息；非空时只接收列出的用户（数字 ID 或 @用户名）。它们是否成为候选仍由 Policy 决定。",
				en: "While the list is empty every message to the bot is received; once it names users, only theirs is. Whether a message becomes a candidate is still up to the Policy.",
				ru: "Пока список пуст, принимаются все сообщения боту; когда в нём есть пользователи — только их (числовой ID или @имя). Станет ли сообщение кандидатом, по-прежнему решает Политика."
			},
			columns: [{
				key: "id",
				type: "text",
				label: {
					zh: "ID 或 @用户名",
					en: "ID or @username",
					ru: "ID или @имя"
				},
				pattern: "@?[A-Za-z0-9_]{1,64}|-?\\d{1,20}"
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
			key: "failuresBeforeError",
			type: "number",
			advanced: true,
			min: 1,
			max: 20,
			label: {
				zh: "连续失败几次后报告异常",
				en: "Failed polls before reporting an error",
				ru: "Сколько сбоев опроса подряд до сообщения об ошибке"
			},
			hint: {
				zh: "单次网络中断会在下一次轮询时自动重试，不必报告。",
				en: "A single network interruption is retried on the next poll and need not be reported.",
				ru: "Однократный обрыв сети автоматически повторяется при следующем опросе и не сообщается."
			}
		}
	],
	health: ["telegram"],
	scope: () => ({
		listened: true,
		observed: false,
		row: "chats"
	}),
	channel: {
		send: sendTelegram,
		link: telegramLink
	},
	threadContext: telegramThreadContext,
	find: (query) => ({
		threads: /^telegram:(-?\d+)$/.exec(query.trim()) ? [query.trim()] : [],
		terms: []
	}),
	policy: {
		schema: z.object({ allowed: z.array(z.object({
			id: z.string().regex(/^@?[A-Za-z0-9_]{1,64}$|^-?\d{1,20}$/),
			name: z.string().trim().max(100).optional()
		}).strict()).refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, "Duplicate senders").default([]) }).strict(),
		fields: [{
			key: "allowed",
			type: "rows",
			label: {
				zh: "能发起工作的 Telegram 用户",
				en: "Telegram users who may originate work",
				ru: "Пользователи Telegram, которые могут запускать работу"
			},
			columns: [{
				key: "id",
				type: "text",
				label: {
					zh: "ID 或 @用户名",
					en: "ID or @username",
					ru: "ID или @имя"
				},
				pattern: "@?[A-Za-z0-9_]{1,64}|-?\\d{1,20}"
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
		}],
		explicit: {
			zh: "名单内的用户给机器人发消息，总是明确的请求，不需要配置。",
			en: "A message to the bot from a user on the list always makes an explicit request; that needs no setting.",
			ru: "Сообщение боту от пользователя из списка — всегда явный запрос; настройка не нужна."
		},
		rows() {
			return [{
				id: "chats",
				label: {
					zh: "机器人聊天",
					en: "Bot chats",
					ru: "Чаты бота"
				},
				note: {
					zh: "接收",
					en: "Received",
					ru: "Принимать"
				},
				cells: {
					listedUnaddressed: false,
					unlistedAddressed: true,
					unlistedUnaddressed: false
				}
			}];
		}
	},
	environment: {
		variables: [{
			key: "DSH_SUPERAGENT_TELEGRAM_CHAT",
			description: {
				zh: "接下工单的 Telegram 聊天 id；工单不是从 Telegram 来的时为空",
				en: "Chat id of the Telegram conversation that started the ticket; empty when the ticket did not start on Telegram",
				ru: "ID чата Telegram, в котором начался тикет; пусто, если тикет начался не в Telegram"
			}
		}],
		values: ({ trigger }) => ({ DSH_SUPERAGENT_TELEGRAM_CHAT: trigger?.source === "telegram" ? String(trigger.meta.chatId ?? "") : "" })
	},
	facts: (deployment) => deployment?.telegram ? { bot: {
		zh: `当前机器人 @${deployment.telegram.username}`,
		en: `Current bot @${deployment.telegram.username}`,
		ru: `Текущий бот @${deployment.telegram.username}`
	} } : {}
};
const name = "dsh-superagent-telegram";
const inject = ["orchestrator"];
function apply(ctx) {
	ctx.effect(() => ctx.orchestrator.sources.register(telegramKind), "telegram: source kind");
	ctx.effect(() => {
		const controller = new AbortController();
		const running = runTelegram(sourceContext(ctx.orchestrator, telegramKind), controller.signal);
		return async () => {
			controller.abort();
			await running;
		};
	});
}
//#endregion
export { SOURCE, apply, inject, name, resolveTelegram, runTelegram, sendTelegram, telegramChannel, telegramFetch, telegramKind, telegramLink, telegramMessageId, telegramRef, telegramThreadContext, telegramTrigger, telegramTriggerId };
