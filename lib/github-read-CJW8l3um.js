import { K as liveTicket, L as escapeRegExp, P as validItems, R as sameName, V as key } from "./host-B6QCBWMz.js";
import { z } from "zod";
//#region src/sources/github-trigger.ts
/** Normalizes GitHub issues, pull requests, comments, reviews, and CI transitions into domain Triggers. */
const SOURCE = "github";
/** GitHub reply address: issue/PR conversation, or a review thread when `url` points at a discussion comment. */
const githubChannel = (number, url) => ({
	source: SOURCE,
	thread: `github:${number}`,
	address: {
		number: String(number),
		...url ? { url } : {}
	}
});
/** Deterministic content-hash Trigger ID for a deploy check conclusion of one PR. */
const deployTriggerId = (number, check, conclusion) => key("deploy", String(number), check, conclusion);
/**
* A deploy check's conclusion for a merged ticket's PR: no channel (the assessor emails the reporter through the
* ticket's own conversation), no addressed flag, and a bot actor whose message never authorizes work by itself.
*/
function deployTrigger(number, ticketId, check) {
	const conclusion = check.conclusion ?? "pending";
	return {
		id: deployTriggerId(number, check.name, conclusion),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: String(number)
		}],
		actor: {
			source: SOURCE,
			id: "deploy"
		},
		human: false,
		at: (/* @__PURE__ */ new Date()).toISOString(),
		text: `Deploy check «${check.name}» concluded ${conclusion} for PR #${number}; the ticket's reporter awaits the email.`,
		meta: {
			kind: "deploy",
			number,
			ticketId,
			check: check.name,
			conclusion,
			...check.details_url ? { url: check.details_url } : {}
		}
	};
}
const githubPage = (repository, number, pr = false) => `https://github.com/${repository}/${pr ? "pull" : "issues"}/${number}`;
/** Parses a web or API URL for an Issue, PR, or review comment in `repository`; returns undefined for other URLs or repositories. */
function githubAddress(url, repository) {
	const match = /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)\/(issues|pulls?)\/(\d+)\/?(?:#discussion_r(\d+)|#[\w-]*)?$/i.exec(url);
	if (!match || !sameName(match[1], repository)) return void 0;
	return {
		number: Number(match[3]),
		pr: match[2].toLowerCase() !== "issues",
		...match[4] ? { discussion: Number(match[4]) } : {}
	};
}
/** GitHub returns a deleted account as `null` and displays it as `ghost`. */
const UserSchema = z.looseObject({
	login: z.string(),
	type: z.string().optional()
}).nullable().transform((user) => user ?? {
	login: "ghost",
	type: "User"
});
/**
* A GitHub comment or review; a review carries `state` and `commit_id`, and an inline review comment carries its file,
* line, diff hunk, and `in_reply_to_id` (the root comment ID of its review thread).
*/
const CommentSchema = z.looseObject({
	id: z.number(),
	body: z.string().nullish(),
	user: UserSchema,
	html_url: z.string().nullish(),
	created_at: z.string().nullish(),
	updated_at: z.string().nullish(),
	submitted_at: z.string().nullish(),
	state: z.string().nullish(),
	commit_id: z.string().nullish(),
	path: z.string().nullish(),
	line: z.number().nullish(),
	original_line: z.number().nullish(),
	diff_hunk: z.string().nullish(),
	in_reply_to_id: z.number().nullish()
});
/** An Issue as `issues/<number>` returns it; GitHub sets `pull_request` when the number is a pull request. */
const IssueSchema = CommentSchema.extend({
	number: z.number(),
	title: z.string(),
	state: z.string(),
	created_at: z.string(),
	html_url: z.string(),
	pull_request: z.looseObject({ url: z.string() }).nullish()
});
/**
* True when GitHub reports the account as a regular user rather than a bot or GitHub App.
* Review bots running under ordinary user accounts count as human here; the prompts identify which accounts are automated.
*/
const isHumanLogin = (user) => !/\[bot\]$/.test(user.login) && (!user.type || user.type === "User");
/** Formats an inline review comment's file:line and the trailing lines of its diff hunk, which GitHub ends at the commented line. */
function reviewPlace(comment) {
	const line = comment.line ?? comment.original_line;
	const hunk = (comment.diff_hunk ?? "").split("\n").slice(-3).join("\n");
	return [`${comment.path}${line != null ? `:${line}` : ""}`, hunk].filter(Boolean).join("\n");
}
function commentText(comment, kind) {
	return [
		kind === "review" && comment.state && comment.state !== "COMMENTED" ? `${comment.state} review of commit ${comment.commit_id ?? "unknown"}` : "",
		kind === "inline" && comment.path ? reviewPlace(comment) : "",
		comment.body ?? ""
	].filter(Boolean).join("\n\n");
}
const mentions = (text, login) => new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, "i").test(text);
const author = (user, agent) => ({
	actor: {
		source: SOURCE,
		id: user.login
	},
	human: isHumanLogin(user) && !sameName(user.login, agent)
});
/** Builds a trigger for a comment or review; text is empty for a bodyless comment or a `COMMENTED` review without a body. */
function commentTrigger(comment, ref, kind, agent) {
	const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? (/* @__PURE__ */ new Date()).toISOString();
	const version = comment.updated_at ?? comment.submitted_at ?? "";
	return {
		id: key("github-comment", comment.html_url ?? `github:${ref.number}`, String(comment.id), version),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: String(ref.number)
		}],
		...author(comment.user, agent),
		at,
		text: commentText(comment, kind),
		...mentions(comment.body ?? "", agent) ? { addressed: "mention" } : {},
		channel: githubChannel(ref.number, comment.html_url ?? void 0),
		...comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {},
		meta: {
			number: ref.number,
			isPr: ref.isPr,
			...ref.prAuthor ? { prAuthor: ref.prAuthor } : {},
			commentId: comment.id,
			kind,
			...comment.path ? {
				path: comment.path,
				line: comment.line ?? comment.original_line ?? null
			} : {},
			...comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {}
		}
	};
}
/**
* Builds the trigger for a newly opened Issue's title and body.
* The ID is the same as when Issue bodies were stored previously, so already-stored bodies are not ingested again.
*/
function issueTrigger(issue, agent) {
	const body = issue.body ?? "";
	return {
		id: key("github-issue", String(issue.number)),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: String(issue.number)
		}],
		...author(issue.user, agent),
		at: issue.created_at,
		text: `${issue.title}\n\n${body}`,
		...mentions(body, agent) ? { addressed: "mention" } : {},
		channel: githubChannel(issue.number, issue.html_url),
		url: issue.html_url,
		meta: {
			number: issue.number,
			isPr: false,
			kind: "issue"
		}
	};
}
/**
* Builds the trigger for a newly opened PR's title and description.
* PR and Issue numbers share one sequence in GitHub and never collide, so this reuses `issueTrigger`'s `github-issue` ID format.
*/
function pullTrigger(pull, agent) {
	return {
		...issueTrigger(pull, agent),
		meta: {
			number: pull.number,
			isPr: true,
			prAuthor: pull.user.login,
			kind: "pull"
		}
	};
}
/** Builds a trigger for a default-branch CI transition; default-branch CI has no person to reply to, so it has no `channel`. */
function branchCiTrigger(branch, sha, revision, summary, url) {
	return {
		id: key("github-ci", `branch:${branch}`, String(revision)),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: `ci:${branch}`
		}],
		actor: {
			source: SOURCE,
			id: ""
		},
		human: false,
		at: (/* @__PURE__ */ new Date()).toISOString(),
		text: summary,
		url,
		meta: {
			ci: true,
			branch,
			sha,
			revision
		}
	};
}
function ciTrigger(pr, revision, summary) {
	return {
		id: key("github-ci", String(pr.number), String(revision)),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: String(pr.number)
		}],
		actor: {
			source: SOURCE,
			id: ""
		},
		human: false,
		at: (/* @__PURE__ */ new Date()).toISOString(),
		text: summary,
		channel: githubChannel(pr.number),
		url: pr.html_url,
		meta: {
			number: pr.number,
			isPr: true,
			prAuthor: pr.user.login,
			ci: true,
			revision
		}
	};
}
//#endregion
//#region src/sources/github-pull.ts
/** Pull request binding, lifecycle observation, and terminal IM notification helpers. */
const PullSchema = z.looseObject({
	title: z.string().optional(),
	state: z.string(),
	html_url: z.string(),
	user: UserSchema,
	body: z.string().nullish(),
	created_at: z.string().optional(),
	merged: z.boolean().optional(),
	merged_at: z.string().nullish(),
	closed_at: z.string().nullish(),
	auto_merge: z.unknown().optional(),
	head: z.looseObject({
		sha: z.string(),
		ref: z.string(),
		repo: z.looseObject({ full_name: z.string() }).nullish()
	})
});
const readPull = async (ctx, number, signal) => ({
	...await ctx.commands.withSignal(signal).api(PullSchema, `pulls/${number}`),
	number
});
const pullNumber = (thread) => thread.startsWith(`github:`) ? Number(thread.slice(7)) : void 0;
const pullsOf = (ticket, open = false) => (ticket.follows ?? []).filter((item) => !open || !item.closed).flatMap((item) => pullNumber(item.thread) ?? []);
const pullOf = (ticket) => pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1);
/** True when the PR was opened by the agent account from a branch in the configured repository (not a fork). */
const agentPull = (pr, deployment) => sameName(pr.user.login, deployment.github.login) && sameName(pr.head?.repo?.full_name ?? "", deployment.repository);
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
const ticketBranch = (ticket, ref) => !!ticket.execution?.name && ref.split("/").at(-1) === ticket.execution.name;
const AUTO_MERGE_ON = {
	label: {
		zh: "自动合并",
		en: "Auto-merge",
		ru: "Автослияние"
	},
	value: {
		zh: "已开启",
		en: "on",
		ru: "включено"
	}
};
/**
* Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
* Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
*/
function claimPull(ctx, ticketId, pr) {
	const ticket = ctx.tickets.get(ticketId);
	if (!ticket || !liveTicket(ticket)) return "Ticket ended because its PR was closed";
	const source = ctx.triggers.get(ticket.origin.triggerId);
	const started = source?.source === "github" && source.meta.isPr === true && source.meta.number === pr.number;
	const opened = agentPull(pr, ctx.deployment) && ticketBranch(ticket, pr.head.ref);
	if (!started && !opened) {
		const { login } = ctx.deployment.github;
		return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`;
	}
	const owner = ctx.tickets.open().find((item) => pullsOf(item, true).includes(pr.number));
	if (owner && owner.id !== ticketId) return "PR already belongs to another active ticket";
	const follow = ticket.follows?.find((item) => item.thread === `${SOURCE}:${pr.number}`);
	if (pr.state === "open" && (!follow || follow.closed || opened && !follow.own)) bind(ctx, ticketId, pr, opened);
}
/**
* Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
* An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
* (which only the Executor's report changes).
* @returns whether the PR has ended.
*/
async function observePull(ctx, pr) {
	const ended = pr.state === "closed" || !!pr.merged;
	if (ended) closePull(ctx, pr);
	else {
		const candidates = agentPull(pr, ctx.deployment) ? ctx.tickets.open().filter((ticket) => ticketBranch(ticket, pr.head.ref)) : [];
		const ticket = candidates.length === 1 ? candidates[0] : void 0;
		const reopened = ticket?.follows?.some((item) => item.thread === `github:${pr.number}` && item.closed);
		if (ticket && (reopened || pullsOf(ticket, true).every((number) => number === pr.number))) claimPull(ctx, ticket.id, pr);
	}
	ctx.threads.describe(`github:${pr.number}`, { facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null } });
	return ended;
}
function bind(ctx, ticketId, pr, own) {
	ctx.atomic(() => {
		ctx.tickets.bindThread(ticketId, {
			source: SOURCE,
			id: String(pr.number)
		}, own);
		ctx.threads.patch(`github:${pr.number}`, {
			number: pr.number,
			isPr: true,
			url: pr.html_url,
			prAuthor: pr.user.login
		});
	});
}
/**
* Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
* Their subscription to the PR stays so a later human comment there resumes the ticket.
*/
function closePull(ctx, pr) {
	if (!ctx.tickets.open().some((ticket) => pullsOf(ticket, true).includes(pr.number))) return;
	const at = pr.merged_at ?? pr.closed_at ?? (/* @__PURE__ */ new Date()).toISOString();
	ctx.tickets.threadClosed({
		source: SOURCE,
		id: String(pr.number)
	}, pr.merged ? "merged" : "closed", at);
}
/**
* Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
* opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
* Han characters and no kana, Russian when it contains Cyrillic, otherwise English.
*/
function pullEndNotices(ticket, request, repository) {
	const outcome = ticket.ended?.outcome;
	const follows = (ticket.follows ?? []).filter((item) => item.closed && pullNumber(item.thread) !== void 0);
	const latest = (items) => items.sort((a, b) => b.closed.at.localeCompare(a.closed.at))[0];
	const follow = latest(follows.filter((item) => item.own)) ?? latest(follows);
	if (outcome !== "merged" && outcome !== "closed" || !follow) return [];
	const number = pullNumber(follow.thread);
	const url = githubPage(repository, number, true);
	const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request);
	const russian = /\p{Script=Cyrillic}/u.test(request);
	const text = chinese ? outcome === "merged" ? `[PR #${number}](${url}) 已合并。` : `[PR #${number}](${url}) 已关闭，未合并。` : russian ? outcome === "merged" ? `[PR #${number}](${url}) вмержен.` : `[PR #${number}](${url}) закрыт без мержа.` : outcome === "merged" ? `[PR #${number}](${url}) has merged.` : `[PR #${number}](${url}) was closed without merging.`;
	return ticket.channels.filter((channel) => channel.source !== SOURCE).map((channel) => ({
		id: key("pr-terminal", String(number), channel.source, JSON.stringify(channel.address), outcome),
		channel,
		text,
		kind: "notice",
		ticketId: ticket.id
	}));
}
//#endregion
//#region src/sources/github-read.ts
/** Read-only GitHub repository, conversation, and CI check inspection for assessments and workers. */
const CheckSchema = z.looseObject({
	name: z.string(),
	status: z.string(),
	conclusion: z.string().nullable()
});
const StatusSchema = z.looseObject({
	context: z.string(),
	state: z.string()
});
/** Check conclusions and status states that count as failures; `success`, `neutral`, `skipped`, and `stale` do not. */
const FAILING = /* @__PURE__ */ new Set([
	"failure",
	"timed_out",
	"cancelled",
	"action_required",
	"startup_failure",
	"error"
]);
function ciCounts(snapshot) {
	const statuses = snapshot.statuses ?? [];
	return {
		failed: snapshot.checks.filter((check) => FAILING.has(check.conclusion ?? "")).length + statuses.filter((status) => FAILING.has(status.state)).length,
		running: snapshot.checks.filter((check) => check.status !== "completed").length + statuses.filter((status) => status.state === "pending").length
	};
}
function ciSummary(snapshot, where, read) {
	const checks = snapshot.checks.map((check) => ({
		name: check.name,
		failed: FAILING.has(check.conclusion ?? ""),
		running: check.status !== "completed"
	}));
	const statuses = (snapshot.statuses ?? []).map((status) => ({
		name: status.context,
		failed: FAILING.has(status.state),
		running: status.state === "pending"
	}));
	const results = [...checks, ...statuses];
	const failed = results.filter((result) => result.failed).map((result) => result.name);
	const running = results.filter((result) => result.running).map((result) => result.name);
	const names = (list) => list.slice(0, 5).join(", ") + (list.length > 5 ? `, and ${list.length - 5} more` : "");
	const at = `on ${where} at ${snapshot.head.slice(0, 7)}`;
	const still = running.length ? `; ${running.length} still running` : "";
	return `${failed.length ? `CI failed ${failed.length}/${results.length} ${at}: ${names(failed)}${still}` : running.length ? `CI running ${running.length}/${results.length} ${at}: ${names(running)}` : `CI passed ${results.length}/${results.length} ${at}`}\nRead ${read} for every check.`;
}
function ciFailures(snapshot) {
	return [...snapshot.checks.filter((check) => FAILING.has(check.conclusion ?? "")).map((check) => check.name), ...(snapshot.statuses ?? []).filter((status) => FAILING.has(status.state)).map((status) => status.context)].sort();
}
function ciFact(counts) {
	if (counts.failed) return {
		label: {
			zh: "CI 失败",
			en: "CI failed",
			ru: "CI провален"
		},
		value: String(counts.failed),
		problem: true
	};
	if (counts.running) return {
		label: {
			zh: "CI 进行中",
			en: "CI running",
			ru: "CI выполняется"
		},
		value: String(counts.running)
	};
	return {
		label: "CI",
		value: {
			zh: "通过",
			en: "passed",
			ru: "пройден"
		}
	};
}
/** Reads a non-hidden file or directory listing from the repository's default branch via the GitHub API; hidden entries and `node_modules` are rejected. */
async function readRepositoryPath(commands, path, kind) {
	const parts = path.split("/").filter((part) => part && part !== ".");
	if (parts.some((part) => part === ".." || part.startsWith(".") || part === "node_modules")) throw new Error("Only non-hidden repository source paths are available");
	const resource = `contents/${parts.map(encodeURIComponent).join("/")}`;
	if (kind === "file") return commands.api(resource, "-H", "Accept: application/vnd.github.raw");
	const entries = await commands.api(z.union([z.array(z.looseObject({ name: z.string() })), z.looseObject({})]), resource);
	if (!Array.isArray(entries)) throw new Error(`${path} is not a directory`);
	return entries.map((entry) => entry.name).filter((name) => !name.startsWith(".") && name !== "node_modules").sort().join("\n");
}
/** Reads check runs and commit statuses for a commit without emitting a trigger. */
async function pullChecks(commands, head, tally) {
	const page = z.looseObject({ check_runs: z.array(z.unknown()) });
	const pages = await commands.api(z.array(page), `commits/${head}/check-runs?per_page=100`, "--paginate", "--slurp");
	const runs = validItems(CheckSchema, pages.flatMap((page) => page.check_runs), tally);
	const statuses = await commands.pages(StatusSchema, `commits/${head}/statuses?per_page=100`, tally);
	const latest = /* @__PURE__ */ new Map();
	for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status.state);
	return {
		head,
		checks: runs.map(({ name, status, conclusion }) => ({
			name,
			status,
			conclusion
		})).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		statuses: [...latest].map(([context, state]) => ({
			context,
			state
		})).sort((a, b) => a.context.localeCompare(b.context))
	};
}
/** Formats a GitHub comment, review, or issue as a model-facing ContextMessage, marking bots and GitHub Apps because bot messages never authorize work. */
function githubMessage(item, text, id) {
	const line = item.line ?? item.original_line;
	return {
		id,
		from: item.user.login,
		at: item.created_at ?? item.submitted_at ?? "",
		text,
		...!isHumanLogin(item.user) ? { bot: true } : {},
		...item.html_url ? { url: item.html_url } : {},
		...item.path ? {
			path: item.path,
			...line != null ? { line } : {}
		} : {}
	};
}
const reviewText = (review) => [review.state && review.state !== "COMMENTED" ? review.state : "", review.body ?? ""].filter(Boolean).join("\n\n");
const DescriptionSchema = IssueSchema.extend({
	labels: z.array(z.looseObject({ name: z.string() })).nullish(),
	draft: z.boolean().nullish(),
	merged: z.boolean().nullish(),
	head: z.looseObject({ ref: z.string() }).nullish(),
	base: z.looseObject({ ref: z.string() }).nullish()
});
async function reviewThread(commands, number, comment, tally) {
	const comments = await commands.pages(CommentSchema, `pulls/${number}/comments?per_page=100`, tally);
	const root = comments.find((item) => item.id === comment)?.in_reply_to_id ?? comment;
	return comments.filter((item) => item.id === root || item.in_reply_to_id === root).sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
}
function threadMessages(thread, id) {
	const [first] = thread;
	return thread.map((item) => item === first ? githubMessage(item, [reviewPlace(item), item.body ?? ""].filter(Boolean).join("\n\n"), id(item)) : {
		...githubMessage(item, item.body ?? "", id(item)),
		...first ? { reply_to: id(first) } : {}
	});
}
/**
* Reads an Issue or PR, a page of its comments or reviews, a review thread, or a CI snapshot as model-facing
* `{ id, from, at, text, reply_to?, path?, line?, url }` messages rather than raw GitHub API records.
*/
async function readGithub(commands, resource) {
	const commit = /^github\/commits\/([0-9a-f]{7,40})\/checks$/.exec(resource);
	if (commit) return pullChecks(commands, commit[1]);
	const match = /^github\/(issues|pulls)\/([1-9]\d*)(?:\/(comments|reviews|checks|thread)(?:\/([1-9]\d*))?)?$/.exec(resource);
	if (!match) throw new Error("Use github/issues/<number>, github/pulls/<number>, or append /comments/<page>, /reviews/<page>, /thread/<comment-id> or /checks; or github/commits/<sha>/checks");
	const [, kind, number, section, page = "1"] = match;
	if (kind === "issues" && (section === "reviews" || section === "checks" || section === "thread")) throw new Error("Reviews, review threads and checks require a pull request");
	const path = `${kind}/${number}`;
	if (section === "checks") {
		if (match[4]) throw new Error("Checks do not take a page number");
		return pullChecks(commands, (await commands.api(z.looseObject({ head: z.looseObject({ sha: z.string() }) }), path)).head.sha);
	}
	if (section === "thread") {
		if (!match[4]) throw new Error("Name the review thread by one of its comments: github/pulls/<number>/thread/<comment-id>");
		const thread = await reviewThread(commands, Number(number), Number(match[4]));
		if (!thread.length) throw new Error("No review comment of this PR has that id");
		return { messages: threadMessages(thread, (item) => String(item.id)) };
	}
	if (!section) {
		const item = await commands.api(DescriptionSchema, path);
		const branches = item.head && item.base ? {
			head: item.head.ref,
			base: item.base.ref
		} : {};
		const labels = item.labels?.length ? { labels: item.labels.map((label) => label.name) } : {};
		return {
			number: item.number,
			title: item.title,
			state: item.state,
			...item.merged ? { merged: true } : {},
			...item.draft ? { draft: true } : {},
			...branches,
			...labels,
			...githubMessage(item, item.body ?? "", String(item.number))
		};
	}
	const listed = await commands.api(z.array(z.unknown()), `${path}/${section}?per_page=20&page=${page}`);
	const tally = { skipped: 0 };
	return {
		messages: validItems(CommentSchema, listed, tally).map((item) => section === "reviews" ? githubMessage({
			...item,
			created_at: item.submitted_at ?? item.created_at
		}, reviewText(item), String(item.id)) : {
			...githubMessage(item, item.body ?? "", String(item.id)),
			...item.in_reply_to_id ? { reply_to: String(item.in_reply_to_id) } : {}
		}),
		...tally.skipped ? { skipped: tally.skipped } : {},
		...listed.length === 20 ? { next_resource: `github/${kind}/${number}/${section}/${Number(page) + 1}` } : {}
	};
}
/** Reads one page of an Issue or PR conversation (with the Issue/PR description first on page 1), using comment URLs as message IDs. */
async function conversationPage(commands, number, page) {
	const messages = [];
	if (page === 1) {
		const issue = await commands.api(IssueSchema, `issues/${number}`);
		messages.push(githubMessage(issue, `${issue.title}\n\n${issue.body ?? ""}`, issue.html_url));
	}
	const listed = await commands.api(z.array(z.unknown()), `issues/${number}/comments?per_page=100&page=${page}`);
	const tally = { skipped: 0 };
	const comments = validItems(CommentSchema, listed, tally);
	messages.push(...comments.map((comment) => githubMessage(comment, comment.body ?? "", comment.html_url ?? String(comment.id))));
	return {
		messages,
		next_resource: listed.length === 100 ? String(page + 1) : null,
		...tally.skipped ? { skipped: tally.skipped } : {}
	};
}
/**
* Context reader for a GitHub Trigger: reads the review thread for an inline review comment (whose first comment is its
* root and parent), or the Issue/PR conversation by page otherwise (whose first page is its root and parent).
*/
const githubThreadContext = {
	messageId: (trigger) => trigger.url ?? "",
	read: async (commands, trigger, part, cursor) => {
		if (typeof trigger.meta.branch === "string") {
			const message = {
				id: trigger.url ?? trigger.id,
				from: "CI",
				at: trigger.at,
				text: trigger.text,
				bot: true
			};
			return {
				messages: [message],
				body: {
					status: "branch_ci",
					messages: [message]
				},
				status: "branch_ci"
			};
		}
		const number = Number(trigger.meta.number);
		if (trigger.meta.kind === "inline" && typeof trigger.meta.commentId === "number") {
			const messages = threadMessages(await reviewThread(commands, number, trigger.meta.commentId), (item) => item.html_url ?? String(item.id));
			const read = part === "thread" ? messages : messages.slice(0, 1);
			return {
				messages: read,
				body: {
					status: "review_thread",
					messages: read
				},
				status: "review_thread"
			};
		}
		const body = await conversationPage(commands, number, Number(cursor ?? "1"));
		return {
			messages: body.messages,
			next: body.next_resource ?? void 0,
			body
		};
	}
};
//#endregion
export { githubPage as C, githubAddress as S, pullTrigger as T, SOURCE as _, githubThreadContext as a, commentTrigger as b, readRepositoryPath as c, pullEndNotices as d, pullOf as f, IssueSchema as g, CommentSchema as h, ciSummary as i, claimPull as l, readPull as m, ciFact as n, pullChecks as o, pullsOf as p, ciFailures as r, readGithub as s, ciCounts as t, observePull as u, branchCiTrigger as v, issueTrigger as w, deployTrigger as x, ciTrigger as y };
