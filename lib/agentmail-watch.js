import { Y as threadKey, _ as cursorAt, b as KV, n as sourceContext, r as AGENTMAIL_BASE, t as health, u as resolveAgentmail, v as pause, z as key } from "./host-DleaoFfw.js";
import { z } from "zod";
//#region src/sources/agentmail-trigger.ts
/** Normalizes AgentMail messages into domain Triggers. */
const SOURCE = "agentmail";
/** Reply address of an email: the inbox that received it, its thread, and the message a reply answers. */
const agentmailChannel = (inboxId, threadId, messageId) => ({
	source: SOURCE,
	thread: `agentmail:${threadId}`,
	address: {
		inboxId,
		threadId,
		messageId
	}
});
/** A message as the AgentMail API carries it; `timestamp` is ISO, and `in_reply_to` names the parent message. */
const MessageSchema = z.looseObject({
	message_id: z.string(),
	thread_id: z.string(),
	from: z.string(),
	to: z.array(z.string()).default([]),
	timestamp: z.string(),
	text: z.string().nullish(),
	extracted_text: z.string().nullish(),
	subject: z.string().nullish(),
	in_reply_to: z.string().nullish(),
	labels: z.array(z.string()).default([]),
	authentication_results: z.string().nullish()
});
/** Strips the display name from `Display Name <user@domain>` down to the bare address. */
const addressOf = (value) => (/^.*<([^<>]+)>\s*$/.exec(value)?.[1] ?? value).trim();
/** The message body the model should read: AgentMail's extracted text when it has one, else the plain text body. */
const messageText = (message) => message.extracted_text ?? message.text ?? "";
/** Deterministic trigger ID for an AgentMail message; every read path for the same message produces the same ID. */
const agentmailTriggerId = (messageId) => key("agentmail", messageId);
/** Converts a message into a Trigger, returning undefined for the inbox's own outgoing messages. */
function agentmailTrigger(message, inboxId, senderIsBot = false) {
	const from = addressOf(message.from);
	if (from === addressOf(inboxId)) return void 0;
	return {
		id: agentmailTriggerId(message.message_id),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: message.thread_id
		}],
		actor: {
			source: SOURCE,
			id: from
		},
		human: !senderIsBot,
		addressed: "direct",
		at: message.timestamp,
		text: messageText(message),
		channel: agentmailChannel(addressOf(inboxId), message.thread_id, message.message_id),
		meta: {
			threadId: message.thread_id,
			messageId: message.message_id,
			from,
			subject: message.subject ?? "",
			...message.in_reply_to ? { inReplyTo: message.in_reply_to } : {}
		}
	};
}
/** The Trigger's message ID, from the Trigger's meta. */
const agentmailMessageId = (trigger) => trigger.source === "agentmail" && typeof trigger.meta.messageId === "string" ? trigger.meta.messageId : void 0;
/** The Trigger an email reply answers, named after the message its `In-Reply-To` header carries. */
const agentmailParent = (trigger) => trigger.source === "agentmail" && typeof trigger.meta.inReplyTo === "string" ? agentmailTriggerId(trigger.meta.inReplyTo) : void 0;
function agentmailRef(trigger) {
	const address = trigger.channel?.address;
	if (trigger.source !== "agentmail" || !address?.inboxId || !address.threadId || !address.messageId) return void 0;
	return {
		triggerId: trigger.id,
		inboxId: address.inboxId,
		threadId: address.threadId,
		messageId: address.messageId,
		at: trigger.at
	};
}
//#endregion
//#region src/sources/agentmail-channel.ts
/** Thrown when an AgentMail request fails in a way that may succeed on a later retry. */
var AgentmailError = class extends Error {
	status;
	constructor(message, status) {
		super(message);
		this.status = status;
	}
};
/** Calls the AgentMail API with the Source's key; the key stays in the request and never reaches a log or the panel. */
async function agentmailFetch(account, path, init = {}, signal) {
	const response = await fetch(`${AGENTMAIL_BASE}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${account.apiKey}`,
			"Content-Type": "application/json",
			...init.headers
		},
		signal: AbortSignal.any([AbortSignal.timeout(3e4), ...signal ? [signal] : []])
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new AgentmailError(`AgentMail ${init.method ?? "GET"} ${path} failed (${response.status}): ${body.slice(0, 300)}`, response.status);
	}
	return response.status === 204 ? void 0 : response.json();
}
/**
* Replies in the thread of the target message. `message.id` is the `Idempotency-Key`: AgentMail keeps keys for a day,
* so an Outbox retry with the same key returns the original message and sends no second email.
*/
async function sendAgentmail(host, message) {
	const account = host.commands.agentmail();
	const { threadId, messageId } = message.channel.address;
	if (!threadId || !messageId) throw new Error("Missing AgentMail reply target");
	try {
		await agentmailFetch(account, `/inboxes/${account.inboxId}/messages/${encodeURIComponent(messageId)}/reply`, {
			method: "POST",
			body: JSON.stringify({ text: message.text }),
			headers: { "Idempotency-Key": message.id }
		});
	} catch (error) {
		if (error instanceof AgentmailError && (error.status === 404 || error.status === 403 || error.status === 410)) return "gone";
		throw error;
	}
	return "sent";
}
/** AgentMail exposes no web permalink for a thread, so the link carries only its label; the trigger's own link is preferred. */
const agentmailLink = (address, links) => ({
	url: "",
	label: {
		zh: "邮件",
		en: "Email",
		ru: "Письмо"
	},
	triggerId: address.messageId ? agentmailTriggerId(address.messageId) : void 0
});
//#endregion
//#region src/sources/agentmail-read.ts
/** Trigger-scoped AgentMail context reader: a thread page, the root, or the message a reply answers. */
/** One thread page from the API: the newest messages, ascending within the page; `next_page_token` continues older. */
const ThreadPageSchema = z.object({
	thread_id: z.string(),
	messages: z.array(MessageSchema),
	next_page_token: z.string().optional()
});
/** Pages followed while searching the whole thread for its root or the replied-to message. */
const SEARCH_PAGES = 10;
/** Formats an AgentMail message as context for the model; the author is the bare email address. */
function agentmailView(message) {
	return {
		id: message.message_id,
		from: addressOf(message.from),
		at: message.timestamp,
		text: messageText(message),
		...message.in_reply_to ? { reply_to: message.in_reply_to } : {}
	};
}
/** Reads one page of the thread the Trigger belongs to, newest first. `cursor` is the previous page's `next_page_token`. */
async function agentmailThreadPage(account, threadId, cursor, pageSize, signal) {
	const query = new URLSearchParams({ limit: String(pageSize) });
	if (cursor) query.set("page_token", cursor);
	const page = ThreadPageSchema.parse(await agentmailFetch(account, `/threads/${encodeURIComponent(threadId)}?${query}`, {}, signal));
	return {
		messages: page.messages.map(agentmailView),
		...page.next_page_token ? { next: page.next_page_token } : {}
	};
}
/** Follows pages until a predicate matches a message, or the pages end; AgentMail pages a thread newest first. */
async function searchThread(account, ref, pageSize, match) {
	let cursor;
	for (let page = 0; page < SEARCH_PAGES; page += 1) {
		const read = await agentmailThreadPage(account, ref.threadId, cursor, pageSize);
		const found = read.messages.find(match);
		if (found) return found;
		if (!read.next) return void 0;
		cursor = read.next;
	}
}
/** The thread context reader used by assessments and by `orchestrator_read` on a Trigger. */
const agentmailThreadContext = {
	messageId: (trigger) => String(trigger.meta.messageId ?? ""),
	read: async (commands, trigger, part, cursor, config) => {
		const account = commands.agentmail();
		const ref = agentmailRef(trigger);
		if (!ref) throw new Error("An AgentMail source trigger is required");
		if (part === "parent") {
			const parent = trigger.meta.inReplyTo;
			if (typeof parent !== "string") return {
				messages: [],
				body: { status: "no_parent" },
				status: "no_parent"
			};
			const found = await searchThread(account, ref, config.readPageSize, (message) => message.id === parent);
			return found ? {
				messages: [found],
				body: { status: "available" },
				status: "available"
			} : {
				messages: [],
				body: { status: "no_parent" },
				status: "no_parent"
			};
		}
		if (part === "root") {
			let cursor;
			let oldest;
			for (let page = 0; page < SEARCH_PAGES; page += 1) {
				const read = await agentmailThreadPage(account, ref.threadId, cursor, config.readPageSize, void 0);
				if (!read.messages.length) break;
				oldest = read.messages[0];
				if (!read.next) break;
				cursor = read.next;
			}
			return oldest ? {
				messages: [oldest],
				body: { status: "available" },
				status: "available"
			} : {
				messages: [],
				body: { status: "no_parent" },
				status: "no_parent"
			};
		}
		const page = await agentmailThreadPage(account, ref.threadId, cursor, config.readPageSize);
		return {
			messages: page.messages,
			next: page.next,
			body: { status: "available" },
			status: "available"
		};
	}
};
//#endregion
//#region src/sources/agentmail-loops.ts
/** AgentMail background loop: inbox polling that turns new messages of updated threads into Triggers. */
/** One updated thread as the inbox's thread list carries it. */
const ThreadItemSchema = z.object({
	thread_id: z.string(),
	timestamp: z.string(),
	last_message_id: z.string(),
	message_count: z.number(),
	subject: z.string().nullish(),
	senders: z.array(z.string()).default([])
});
const ThreadsSchema = z.object({ threads: z.array(ThreadItemSchema) });
const runAgentmail = (ctx, signal) => pollLoop(ctx, signal);
const account = (ctx) => {
	const resolved = ctx.deployment.agentmail;
	if (!resolved) throw new Error("The AgentMail Source has no working account");
	return resolved;
};
/**
* Polls the inbox at the configured interval. Setup restarts dsh-superagent once it resolves the account, so until then the
* loop reports what it waits for; disabling the Source pauses it, and enabling it again resumes within one interval.
*/
async function pollLoop(ctx, signal) {
	await ctx.ready;
	let interval = 60;
	let failures = 0;
	while (!signal.aborted) {
		const config = ctx.config(SOURCE);
		if (!config) ctx.report(SOURCE, health("paused", "sourceOff"));
		else if (!ctx.configured() || !ctx.deployment.agentmail) {
			const waiting = health("paused", ctx.configured() ? "agentmailUnset" : "setupPending");
			ctx.report(SOURCE, ctx.problem ? {
				state: "paused",
				detail: ctx.problem.detail
			} : waiting);
			failures = 0;
		} else try {
			interval = await pollRound(ctx, signal, config);
			failures = 0;
		} catch (error) {
			failures += 1;
			const failed = pollFailure(failures, config.failuresBeforeError, error);
			if (!signal.aborted && failed) ctx.report(SOURCE, failed);
		}
		await pause(Math.max(interval, config?.pollSeconds ?? 60) * 1e3, signal);
	}
}
/** True when the Source still receives a message from this sender: everything while the whitelist is empty, only listed addresses after. */
function listened(config, message) {
	return !config.senders.length || config.senders.some((sender) => sender.address.toLowerCase() === addressOf(message.from).toLowerCase());
}
/**
* True when the mail's SPF/DKIM/DMARC results, when the API carries them, show a pass: a listed address is not proof of
* the sender, so failed mail is skipped instead of becoming Triggers. AgentMail also withholds such mail from every list
* endpoint, so this check is a belt-and-braces guard for whatever still surfaces here.
*/
function authenticated(message) {
	const results = message.authentication_results;
	return results === void 0 || results === null || /(?:spf|dkim|dmarc)[^;\n]*\bpass\b/i.test(results);
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
function pollFailure(failures, threshold, error) {
	return failures >= threshold ? health("error", "pollFailures", {
		count: String(failures),
		error: String(error)
	}) : void 0;
}
/** Lists the threads updated since the cursor and reads the new messages of each; a thread is read only when its last message changed. */
async function pollRound(ctx, signal, config) {
	const started = (/* @__PURE__ */ new Date()).toISOString();
	const since = ctx.state.get(KV.agentmail.since) ?? cursorAt(started);
	const query = new URLSearchParams({
		after: since,
		ascending: "true",
		limit: "100"
	});
	const list = ThreadsSchema.parse(await agentmailFetch(account(ctx), `/inboxes/${account(ctx).inboxId}/threads?${query}`, {}, signal));
	for (const item of list.threads) {
		if (signal.aborted) return config.pollSeconds;
		const checkpoint = KV.agentmail.thread(item.thread_id);
		const known = ctx.state.get(checkpoint);
		if (known?.lastMessageId === item.last_message_id) continue;
		await readThread(ctx, account(ctx), item, known, config, signal, since);
		if (signal.aborted) return config.pollSeconds;
	}
	ctx.atomic(() => {
		ctx.state.set(KV.agentmail.since, cursorAt(started));
	});
	const skipped = ctx.state.get(KV.agentmail.unauthenticated);
	const detail = `${list.threads.length} updated threads; next poll ≥ ${config.pollSeconds}s` + (skipped ? `; ${skipped.count} unauthenticated messages skipped since ${skipped.at}` : "");
	ctx.report(SOURCE, {
		state: "ready",
		detail,
		at: started
	});
	return config.pollSeconds;
}
/** Reads the messages of one updated thread that are newer than what was already seen, oldest first. */
async function readThread(ctx, inbox, item, known, config, signal, since) {
	const query = new URLSearchParams({ limit: "100" });
	const fresh = z.object({
		messages: z.array(MessageSchema),
		next_page_token: z.string().optional()
	}).parse(await agentmailFetch(inbox, `/threads/${encodeURIComponent(item.thread_id)}?${query}`, {}, signal)).messages.filter((message) => Date.parse(message.timestamp) > (known ? Date.parse(known.lastAt) : Date.parse(since) - 5e3)).filter((message) => listened(config, message));
	for (const message of fresh.filter(authenticated)) {
		if (signal.aborted) return;
		await receive(ctx, agentmailTrigger(message, inbox.inboxId), item);
	}
	const rejected = fresh.length - fresh.filter(authenticated).length;
	if (rejected) {
		const skipped = ctx.state.get(KV.agentmail.unauthenticated);
		ctx.state.set(KV.agentmail.unauthenticated, {
			count: (skipped?.count ?? 0) + rejected,
			at: skipped?.at ?? (/* @__PURE__ */ new Date()).toISOString()
		});
	}
	ctx.state.set(KV.agentmail.thread(item.thread_id), {
		lastMessageId: item.last_message_id,
		lastAt: item.timestamp
	});
}
/** Receives a Trigger and labels its Thread with the email subject. */
async function receive(ctx, trigger, item) {
	if (!trigger) return;
	await ctx.receive(trigger);
	const subject = String(item.subject ?? "");
	for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), {
		label: subject || `Email thread ${item.thread_id}`,
		facts: { from: { value: trigger.actor.id } }
	});
}
//#endregion
//#region src/sources/agentmail.ts
/** Configuration of the AgentMail Source: the account whose inbox it watches, and how it polls. */
const EMAIL = "[^\\s@]+@[^\\s@]+\\.[^\\s@]+";
const agentmailKind = {
	kind: SOURCE,
	order: 30,
	title: {
		zh: "AgentMail",
		en: "AgentMail",
		ru: "AgentMail"
	},
	description: {
		zh: "智能体在 AgentMail 的收件箱：接收发到它的邮件，并轮询已订阅线程的新回复。",
		en: "The agent's AgentMail inbox: receives email addressed to it, and polls subscribed Threads for new replies.",
		ru: "Почтовый ящик агента в AgentMail: принимает письма, адресованные ему, и опрашивает подписанные треды на новые ответы."
	},
	schema: z.object({
		apiKey: z.string().trim().default(""),
		inboxId: z.string().trim().default(""),
		pollSeconds: z.number().int().min(60).max(3600).default(60),
		failuresBeforeError: z.number().int().min(1).max(20).default(3),
		readPageSize: z.number().int().min(1).max(50).default(20),
		senders: z.array(z.object({ address: z.string().regex(new RegExp(`^${EMAIL}$`), "email address") }).strict()).refine((entries) => new Set(entries.map((entry) => entry.address.toLowerCase())).size === entries.length, "Duplicate addresses").default([])
	}).strict(),
	fields: [
		{
			key: "apiKey",
			type: "text",
			label: {
				zh: "API 密钥",
				en: "API key",
				ru: "Ключ API"
			},
			hint: {
				zh: "来自 AgentMail 控制台的密钥。只保存在本机的 DSH 配置里，不在面板上显示。",
				en: "A key from the AgentMail console. Kept in the local DSH configuration; the panel never shows it.",
				ru: "Ключ из консоли AgentMail. Хранится в локальной конфигурации DSH, в панели не показывается."
			}
		},
		{
			key: "inboxId",
			type: "text",
			pattern: EMAIL,
			label: {
				zh: "收件箱",
				en: "Inbox",
				ru: "Ящик"
			},
			hint: {
				zh: "写作邮箱地址，例如 agent@example.com。保存时用密钥检查账号和收件箱，然后重启 dsh-superagent。",
				en: "Written as the email address, for example agent@example.com. Saving checks the account and the inbox with the key, then restarts dsh-superagent.",
				ru: "Пишется как адрес электронной почты, например agent@example.com. При сохранении ключом проверяются аккаунт и ящик, затем dsh-superagent перезапускается."
			}
		},
		{
			key: "inbox",
			label: {
				zh: "收件箱",
				en: "Inbox",
				ru: "Ящик"
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
				ru: "От кого принимать письма"
			},
			hint: {
				zh: "名单为空时接收所有来信；非空时只接收这些地址的邮件。它们是否成为候选仍由 Policy 决定。",
				en: "While the list is empty every message is received; once it names addresses, only their mail is received. Whether a message becomes a candidate is still up to the Policy.",
				ru: "Пока список пуст, принимаются все письма; когда в нём есть адреса — только письма от них. Станет ли письмо кандидатом, по-прежнему решает Политика."
			},
			columns: [{
				key: "address",
				type: "text",
				label: {
					zh: "地址",
					en: "Address",
					ru: "Адрес"
				},
				pattern: EMAIL
			}]
		},
		{
			key: "pollSeconds",
			type: "number",
			advanced: true,
			min: 60,
			max: 3600,
			label: {
				zh: "轮询间隔 / 秒",
				en: "Polling interval / seconds",
				ru: "Интервал опроса / сек"
			}
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
	health: ["agentmail"],
	scope({ meta }, config) {
		const from = String(meta.from ?? "");
		if (config.senders.length && !config.senders.some((sender) => sender.address.toLowerCase() === from.toLowerCase())) return {
			listened: false,
			reason: "sender_not_listened"
		};
		return {
			listened: true,
			observed: false,
			row: "inbox"
		};
	},
	channel: {
		send: sendAgentmail,
		link: agentmailLink
	},
	threadContext: agentmailThreadContext,
	find: (query) => ({
		threads: /^agentmail:([^\s]+)$/.exec(query.trim()) ? [query.trim()] : [],
		terms: []
	}),
	repliesTo: agentmailParent,
	policy: {
		schema: z.object({ allowed: z.array(z.object({
			id: z.string().regex(new RegExp(`^${EMAIL}$`)),
			name: z.string().trim().max(100).optional()
		}).strict()).refine((entries) => new Set(entries.map((entry) => entry.id.toLowerCase())).size === entries.length, "Duplicate addresses").default([]) }).strict(),
		fields: [{
			key: "allowed",
			type: "rows",
			label: {
				zh: "能发起工作的发件地址",
				en: "Senders who may originate work",
				ru: "Отправители, которые могут запускать работу"
			},
			columns: [{
				key: "id",
				type: "text",
				label: {
					zh: "地址",
					en: "Address",
					ru: "Адрес"
				},
				pattern: EMAIL
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
			zh: "名单内的地址给收件箱写信，总是明确的请求，不需要配置。",
			en: "A message to the inbox from an address on the list always makes an explicit request; that needs no setting.",
			ru: "Письмо в ящик агента от адреса из списка — всегда явный запрос; настройка не нужна."
		},
		rows() {
			return [{
				id: "inbox",
				label: {
					zh: "收件箱",
					en: "Inbox",
					ru: "Ящик"
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
			key: "DSH_SUPERAGENT_AGENTMAIL_INBOX",
			description: {
				zh: "监听的收件箱地址。智能体从这里回复邮件",
				en: "The inbox address this Source watches. The agent replies to email from here",
				ru: "Адрес отслеживаемого ящика. Агент отвечает на письма отсюда"
			}
		}, {
			key: "DSH_SUPERAGENT_AGENTMAIL_FROM",
			description: {
				zh: "接下工单的邮件发件人地址；工单不是从 AgentMail 来的时为空",
				en: "Sender address of the email that started the ticket; empty when the ticket did not start on AgentMail",
				ru: "Адрес отправителя письма, с которого начался тикет; пусто, если тикет начался не в AgentMail"
			}
		}],
		values: ({ deployment, trigger }) => ({
			DSH_SUPERAGENT_AGENTMAIL_INBOX: deployment.agentmail?.inboxId ?? "",
			DSH_SUPERAGENT_AGENTMAIL_FROM: trigger?.source === "agentmail" ? trigger.actor.id : ""
		})
	},
	facts: (deployment) => deployment?.agentmail ? { inbox: {
		zh: `当前收件箱 ${deployment.agentmail.inboxId}`,
		en: `Current inbox ${deployment.agentmail.inboxId}`,
		ru: `Текущий ящик ${deployment.agentmail.inboxId}`
	} } : {}
};
const name = "dsh-superagent-agentmail";
const inject = ["orchestrator"];
function apply(ctx) {
	ctx.effect(() => ctx.orchestrator.sources.register(agentmailKind), "agentmail: source kind");
	ctx.effect(() => {
		const controller = new AbortController();
		const running = runAgentmail(sourceContext(ctx.orchestrator, agentmailKind), controller.signal);
		return async () => {
			controller.abort();
			await running;
		};
	});
}
//#endregion
export { SOURCE, addressOf, agentmailChannel, agentmailFetch, agentmailKind, agentmailLink, agentmailMessageId, agentmailParent, agentmailRef, agentmailThreadContext, agentmailTrigger, agentmailTriggerId, apply, inject, messageText, name, resolveAgentmail, runAgentmail, sendAgentmail };
