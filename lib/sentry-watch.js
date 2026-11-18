import { S as KV, V as key, Z as threadKey, b as pause, n as sourceContext, p as resolveSentry, t as health, y as cursorAt } from "./host-B6QCBWMz.js";
import { z } from "zod";
//#region src/sources/sentry-trigger.ts
/** Normalizes Sentry/GlitchTip issues into domain Triggers. */
const SOURCE = "sentry";
/** An issue as the Sentry-compatible API carries it: `count` may be a string, `permalink` and `culprit` may be absent. */
const IssueSchema = z.looseObject({
	id: z.string(),
	shortId: z.string().nullish(),
	title: z.string(),
	culprit: z.string().nullish(),
	firstSeen: z.string(),
	lastSeen: z.string().nullish(),
	count: z.coerce.number().default(0),
	userCount: z.coerce.number().default(0),
	level: z.string().nullish(),
	status: z.string().nullish(),
	permalink: z.string().nullish(),
	project: z.object({
		id: z.coerce.string(),
		slug: z.string(),
		name: z.string().nullish()
	}).nullish()
});
/** A project slug as the panel's whitelist writes it. */
const SLUG = "[A-Za-z0-9_.-]+";
/** Deterministic trigger ID for an issue; every poll produces the same ID for the same issue. */
const sentryTriggerId = (issueId) => key("sentry", issueId);
/** The issue's web permalink: the API's when it carries one, else the URL an installation's issue page would have. */
const sentryLink = (account, issue) => issue.permalink ?? `${account.url.replace(/\/+$/, "")}/organizations/${account.orgSlug}/issues/${issue.id}/`;
/** Converts an issue into a Trigger. Sentry issues carry no sender and no reply channel, so the trigger is senderless. */
function sentryTrigger(issue, account) {
	const project = issue.project?.slug ?? "";
	const where = issue.culprit ? ` — ${issue.culprit}` : "";
	const url = sentryLink(account, issue);
	return {
		id: sentryTriggerId(issue.id),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: issue.id
		}],
		actor: {
			source: SOURCE,
			id: ""
		},
		human: false,
		at: issue.firstSeen,
		url,
		text: `Новая ошибка в проде: «${issue.title}» в проекте ${project}${where} — ${issue.count} событий, ${issue.userCount} пользователей, уровень ${issue.level ?? "error"}. ${url}`,
		meta: {
			kind: "issue",
			issueId: issue.id,
			shortId: issue.shortId ?? "",
			project,
			title: issue.title,
			culprit: issue.culprit ?? "",
			level: issue.level ?? "error",
			count: issue.count,
			userCount: issue.userCount,
			status: issue.status ?? "unresolved",
			url,
			firstSeen: issue.firstSeen,
			lastSeen: issue.lastSeen ?? issue.firstSeen
		}
	};
}
function sentryRef(trigger) {
	if (trigger.source !== "sentry") return void 0;
	const issueId = trigger.meta.issueId;
	return typeof issueId === "string" ? { issueId } : void 0;
}
//#endregion
//#region src/sources/sentry-api.ts
/** Sentry-compatible API access for the Sentry Source; the token stays in the request and never reaches a log or the panel. */
/** Thrown when a Sentry-compatible request fails in a way that may succeed on a later retry. */
var SentryError = class extends Error {
	status;
	constructor(message, status) {
		super(message);
		this.status = status;
	}
};
/** Calls the Sentry-compatible API with the Source's token. */
async function sentryFetch(account, path, init = {}, signal) {
	const base = account.url.replace(/\/+$/, "");
	const response = await fetch(`${base}/api/0${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${account.authToken}`,
			"Content-Type": "application/json",
			...init.headers
		},
		signal: AbortSignal.any([AbortSignal.timeout(3e4), ...signal ? [signal] : []])
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new SentryError(`Sentry API ${init.method ?? "GET"} ${path} failed (${response.status}): ${body.slice(0, 300)}`, response.status);
	}
	return response.status === 204 ? void 0 : response.json();
}
/** Lists an organization's issues, newest activity first; Sentry pages by cursor, one bounded page per poll suffices. */
async function listIssues(account, query, signal) {
	const search = new URLSearchParams({
		query: query.filter,
		statsPeriod: "24h",
		limit: String(query.limit)
	});
	return z.array(IssueSchema).parse(await sentryFetch(account, `/organizations/${encodeURIComponent(query.orgSlug)}/issues/?${search}`, {}, signal));
}
//#endregion
//#region src/sources/sentry-read.ts
/** Trigger-scoped Sentry context reader: the latest events of the trigger's issue. */
/** An issue event as the API carries it: `message` may be absent for non-message events. */
const EventSchema = z.looseObject({
	id: z.string(),
	message: z.string().nullish(),
	culprit: z.string().nullish(),
	dateCreated: z.string(),
	userCount: z.coerce.number().nullish(),
	level: z.string().nullish(),
	metadata: z.object({
		type: z.string().nullish(),
		value: z.string().nullish()
	}).nullish()
});
/** Formats an issue event as context for the model; the culprit names where it happened. */
function sentryView(event) {
	const type = event.metadata?.type, value = event.metadata?.value;
	return {
		id: event.id,
		from: event.culprit ?? type ?? "sentry",
		at: event.dateCreated,
		text: value ? `${type ?? "Ошибка"}: ${value}` : event.message ?? `${type ?? "Ошибка"} (детали на странице события)`
	};
}
/** The thread context reader used by assessments and by `orchestrator_read` on a Trigger. */
const sentryThreadContext = {
	messageId: (trigger) => sentryRef(trigger)?.issueId ?? "",
	read: async (commands, trigger, part, _cursor, config) => {
		const account = commands.sentry();
		const ref = sentryRef(trigger);
		if (!ref) throw new Error("A Sentry source trigger is required");
		if (part !== "thread") return {
			messages: [],
			body: { status: "no_parent" },
			status: "no_parent"
		};
		return {
			messages: z.array(EventSchema).parse(await sentryFetch(account, `/issues/${encodeURIComponent(ref.issueId)}/events/?limit=${encodeURIComponent(String(config.readPageSize))}`)).map(sentryView),
			body: { status: "available" },
			status: "available"
		};
	}
};
//#endregion
//#region src/sources/sentry-loops.ts
/** Sentry background loop: polling the Sentry-compatible API for new unresolved issues of the watched projects. */
const runSentry = (ctx, signal) => pollLoop(ctx, signal);
const account = (ctx) => {
	const resolved = ctx.deployment.sentry;
	if (!resolved) throw new Error("The Sentry Source has no working account");
	return resolved;
};
/** True when the Source still watches a project: everything while the list is empty, only listed projects after. */
function listened(config, project) {
	return !config.projects.length || config.projects.some((entry) => entry.slug.toLowerCase() === project.toLowerCase());
}
/**
* Polls the issues endpoint at the configured interval. Setup restarts dsh-superagent once it verifies the account, so
* until then the loop reports what it waits for; disabling the Source pauses it, and enabling it again resumes within one interval.
*/
async function pollLoop(ctx, signal) {
	await ctx.ready;
	let failures = 0;
	while (!signal.aborted) {
		const config = ctx.config(SOURCE);
		if (!config) ctx.report(SOURCE, health("paused", "sourceOff"));
		else if (!ctx.configured() || !ctx.deployment.sentry) {
			const waiting = health("paused", ctx.configured() ? "sentryUnset" : "setupPending");
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
		await pause(failures ? 5e3 : (config?.pollSeconds ?? 300) * 1e3, signal);
	}
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
function pollFailure(failures, threshold, error) {
	return failures >= threshold ? health("error", "pollFailures", {
		count: String(failures),
		error: String(error)
	}) : void 0;
}
/** Lists unresolved issues, receives those first seen since the cursor, and advances the cursor only after every receive. */
async function pollRound(ctx, signal, config) {
	const started = (/* @__PURE__ */ new Date()).toISOString();
	const since = ctx.state.get(KV.sentry.since) ?? cursorAt(started);
	const issues = await listIssues(account(ctx), {
		orgSlug: account(ctx).orgSlug,
		filter: config.query,
		limit: config.readPageSize
	}, signal);
	const fresh = issues.filter((issue) => Date.parse(issue.firstSeen) > Date.parse(since) - 5e3).filter((issue) => listened(config, issue.project?.slug ?? ""));
	for (const issue of fresh) {
		if (signal.aborted) return;
		await receive(ctx, sentryTrigger(issue, account(ctx)), issue);
	}
	ctx.atomic(() => {
		ctx.state.set(KV.sentry.since, cursorAt(started));
	});
	ctx.report(SOURCE, {
		state: "ready",
		detail: `${issues.length} unresolved issues, ${fresh.length} new; next poll ≥ ${config.pollSeconds}s`,
		at: started
	});
}
/** Receives a Trigger and labels its Thread with the issue title. */
async function receive(ctx, trigger, issue) {
	await ctx.receive(trigger);
	for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { label: `${issue.project?.slug ? `${issue.project.slug}: ` : ""}${issue.title}` });
}
const sentryKind = {
	kind: SOURCE,
	order: 50,
	title: {
		zh: "Sentry / GlitchTip",
		en: "Sentry / GlitchTip",
		ru: "Sentry / GlitchTip"
	},
	description: {
		zh: "错误跟踪系统（Sentry 兼容 API，如 GlitchTip）：轮询项目的新未解决 issue，把它交给评估。",
		en: "The error tracker (Sentry-compatible API, such as GlitchTip): polls the projects for new unresolved issues and hands them to an assessment.",
		ru: "Трекер ошибок (Sentry-совместимый API, например GlitchTip): опрашивает проекты на новые нерешённые issue и передаёт их оценке."
	},
	schema: z.object({
		url: z.string().trim().default(""),
		orgSlug: z.string().trim().max(80).default(""),
		authToken: z.string().trim().default(""),
		pollSeconds: z.number().int().min(60).max(3600).default(300),
		failuresBeforeError: z.number().int().min(1).max(20).default(3),
		readPageSize: z.number().int().min(1).max(100).default(50),
		query: z.string().trim().max(200).default("is:unresolved"),
		projects: z.array(z.object({ slug: z.string().regex(new RegExp(`^${SLUG}$`), "project slug") }).strict()).refine((entries) => new Set(entries.map((entry) => entry.slug.toLowerCase())).size === entries.length, "Duplicate projects").default([])
	}).strict(),
	fields: [
		{
			key: "url",
			type: "text",
			label: {
				zh: "API 地址",
				en: "API base URL",
				ru: "Адрес сервера"
			},
			hint: {
				zh: "例如 https://glitchtip.example.com。保存时会用令牌检查账号，然后重启 dsh-superagent。",
				en: "For example https://glitchtip.example.com. Saving checks the account with the token, then restarts dsh-superagent.",
				ru: "Например https://glitchtip.example.com. При сохранении аккаунт проверяется токеном, затем dsh-superagent перезапускается."
			}
		},
		{
			key: "orgSlug",
			type: "text",
			label: {
				zh: "组织 slug",
				en: "Organization slug",
				ru: "Slug организации"
			}
		},
		{
			key: "authToken",
			type: "text",
			label: {
				zh: "API 令牌",
				en: "API token",
				ru: "Токен API"
			},
			hint: {
				zh: "来自 Sentry/GlitchTip 的 API 令牌。只保存在本机的 DSH 配置里，不在面板上显示。",
				en: "The API token from Sentry or GlitchTip. Kept in the local DSH configuration; the panel never shows it.",
				ru: "Токен API из Sentry/GlitchTip. Хранится в локальной конфигурации DSH, в панели не показывается."
			}
		},
		{
			key: "org",
			label: {
				zh: "组织",
				en: "Organization",
				ru: "Организация"
			},
			type: "fact",
			settings: "deployment"
		},
		{
			key: "projects",
			type: "rows",
			label: {
				zh: "接收的项目",
				en: "Projects to watch",
				ru: "Проекты, по которым принимать ошибки"
			},
			hint: {
				zh: "名单为空时接收所有项目的新 issue；非空时只接收列出的项目。它们是否成为候选仍由 Policy 决定。",
				en: "While the list is empty every project's issues are received; once it names slugs, only theirs is. Whether an issue becomes a candidate is still up to the Policy.",
				ru: "Пока список пуст, принимаются новые issue всех проектов; когда в нём есть slug — только их. Станет ли issue кандидатом, по-прежнему решает Политика."
			},
			columns: [{
				key: "slug",
				type: "text",
				label: {
					zh: "项目 slug",
					en: "Project slug",
					ru: "Slug проекта"
				},
				pattern: SLUG
			}]
		},
		{
			key: "query",
			type: "text",
			advanced: true,
			label: {
				zh: "查询",
				en: "Query",
				ru: "Запрос"
			},
			hint: {
				zh: "Sentry 查询语法，默认 is:unresolved。",
				en: "A Sentry query; the default is is:unresolved.",
				ru: "Запрос в синтаксисе Sentry; по умолчанию is:unresolved."
			}
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
			max: 100,
			label: {
				zh: "每次轮询的 issue 数",
				en: "Issues per poll",
				ru: "Issue за опрос"
			}
		}
	],
	health: ["sentry"],
	scope({ meta }, config) {
		const project = String(meta.project ?? "");
		if (config.projects.length && !config.projects.some((entry) => entry.slug.toLowerCase() === project.toLowerCase())) return {
			listened: false,
			reason: "project_not_listened"
		};
		return {
			listened: true,
			observed: true,
			row: "issues"
		};
	},
	threadContext: sentryThreadContext,
	find: (query) => ({
		threads: /^sentry:([^\s]+)$/.exec(query.trim()) ? [query.trim()] : [],
		terms: []
	}),
	policy: {
		schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]+$/) }).strict()).default([]) }).strict(),
		fields: [{
			key: "allowed",
			type: "rows",
			label: {
				zh: "能发起工作的账号（此来源未用）",
				en: "Accounts that may originate work (unused by this Source)",
				ru: "Учётные записи, которые могут запускать работу (источником не используются)"
			},
			hint: {
				zh: "Issue 由来源自己发出，没有发件人，此名单不使用。",
				en: "Issues come from the Source itself and name no sender, so this list stays unused.",
				ru: "Issue приходят от самого источника без отправителя, поэтому список не используется."
			},
			columns: [{
				key: "id",
				type: "text",
				label: {
					zh: "账号",
					en: "Account",
					ru: "Учётная запись"
				},
				pattern: "[A-Za-z0-9\\-]+"
			}]
		}],
		explicit: {
			zh: "此来源不产生明确请求。",
			en: "This Source never makes an explicit request.",
			ru: "Этот источник не создаёт явных запросов."
		},
		rows() {
			return [{
				id: "issues",
				label: {
					zh: "新未解决 issue",
					en: "New unresolved issues",
					ru: "Новые нерешённые issue"
				},
				note: {
					zh: "接收",
					en: "Received",
					ru: "Принимать"
				},
				cells: {
					listedUnaddressed: false,
					unlistedAddressed: false,
					unlistedUnaddressed: true
				}
			}];
		}
	},
	environment: {
		variables: [
			{
				key: "DSH_SUPERAGENT_SENTRY_PROJECT",
				description: {
					zh: "产生工单的 issue 的项目 slug；工单不是从 Sentry 来的时为空",
					en: "Project slug of the issue that started the ticket; empty when the ticket did not start on Sentry",
					ru: "Slug проекта issue, с которого начался тикет; пусто, если тикет начался не в Sentry"
				}
			},
			{
				key: "DSH_SUPERAGENT_SENTRY_ISSUE",
				description: {
					zh: "产生工单的 issue 的短 ID（如 PROJ-42）；不是来自 Sentry 时为空",
					en: "Short id of the issue that started the ticket (such as PROJ-42); empty when the ticket did not start on Sentry",
					ru: "Короткий id issue, с которого начался тикет (например PROJ-42); пусто, если тикет начался не в Sentry"
				}
			},
			{
				key: "DSH_SUPERAGENT_SENTRY_URL",
				description: {
					zh: "产生工单的 issue 的网页链接；不是来自 Sentry 时为空",
					en: "Web link of the issue that started the ticket; empty when the ticket did not start on Sentry",
					ru: "Ссылка на страницу issue, с которого начался тикет; пусто, если тикет начался не в Sentry"
				}
			}
		],
		values: ({ trigger }) => ({
			DSH_SUPERAGENT_SENTRY_PROJECT: trigger?.source === "sentry" ? String(trigger.meta.project ?? "") : "",
			DSH_SUPERAGENT_SENTRY_ISSUE: trigger?.source === "sentry" ? String(trigger.meta.shortId ?? "") : "",
			DSH_SUPERAGENT_SENTRY_URL: trigger?.source === "sentry" && typeof trigger.url === "string" ? trigger.url : ""
		})
	},
	facts: (deployment) => deployment?.sentry ? { org: {
		zh: `当前组织 ${deployment.sentry.orgSlug}`,
		en: `Current organization ${deployment.sentry.orgSlug}`,
		ru: `Текущая организация ${deployment.sentry.orgSlug}`
	} } : {}
};
const name = "dsh-superagent-sentry";
const inject = ["orchestrator"];
function apply(ctx) {
	ctx.effect(() => ctx.orchestrator.sources.register(sentryKind), "sentry: source kind");
	ctx.effect(() => {
		const source = sourceContext(ctx.orchestrator, sentryKind);
		const controller = new AbortController();
		const running = runSentry(source, controller.signal).catch((error) => {
			source.report(SOURCE, {
				state: "error",
				detail: String(error),
				at: (/* @__PURE__ */ new Date()).toISOString()
			});
		});
		return async () => {
			controller.abort();
			await running;
		};
	});
}
//#endregion
export { SLUG, SOURCE, apply, inject, name, pollFailure, resolveSentry, runSentry, sentryFetch, sentryKind, sentryLink, sentryRef, sentryThreadContext, sentryTrigger, sentryTriggerId };
