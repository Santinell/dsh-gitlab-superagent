import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import s from "@deepseek-ai/schemastery";
// src/core/model.ts
/** Stable key of a thread across the whole domain. */
const threadKey = (ref) => `${ref.source}:${ref.id}`;
/**
* Normalizes valid timestamps to `Date#toISOString` form so stored timestamps compare lexicographically in memory and SQL;
* values that do not parse as a timestamp are returned unchanged.
*/
function isoTime(value) {
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString() : value;
}
/**
* The tickets whose worker decides a person's follow-up: those it reached on their own Threads that can still decide it
* and did not hand it back. A ticket can while it is live, also once a person dropped its Subscription to the Thread, and
* while it is ended, not by a person, with the Trigger waiting to resume it. None once a person sent it to Eval, or while
* an Eval holds it, which an earlier version may have queued. While a ticket owns it, the message goes to no Eval, and the
* main Session may only stop the work on it.
*/
function followupOwners(trigger, records) {
	if (!trigger.human) return [];
	const disposition = records.triggers.disposition(trigger.id);
	if (!disposition || disposition.requeued) return [];
	const returned = new Set(disposition.handbacks?.map((item) => item.ticketId));
	const reached = disposition.fanout.filter((id) => !returned.has(id) && !disposition.context?.includes(id));
	if (!reached.length || records.threads.get(threadKey(trigger.threads[0]))?.evaluating?.triggerIds.includes(trigger.id)) return [];
	return reached.filter((id) => {
		const ticket = records.tickets.get(id);
		return !!ticket && (liveTicket(ticket) || ticket.ended?.by !== "human" && ticket.inputs.some((input) => input.kind === "trigger" && input.triggerId === trigger.id && ticket.undelivered.includes(input.id)));
	});
}
/**
* Whether a Decision settled what a person's message asks for: a stop on it, taken or refused, decides only that ticket's
* work, routing it to a ticket leaves it to that ticket's worker, and an unavailable one decided nothing.
*/
const settled = (decision) => !["stop", "unavailable"].includes(decision.kind) && !decision.reason.some((reason) => [
	"stopNotExplicit",
	"stopUnknown",
	"routed"
].includes(reason.code));
/** Whether a ticket is open: it has not ended. */
const liveTicket = (ticket) => !ticket.ended;
/** How a ticket ended. */
const ticketOutcome = (ticket) => ticket.ended?.outcome;
const runningAssignment = (ticket) => ticket.assignments.find((assignment) => assignment.state === "running");
/**
* Whether a Trigger reached a ticket: it started the ticket, came to it as an Input, or is on a Thread the ticket subscribes
* to; with `context` false, not a Thread the ticket follows only for context, where its worker may read but not write.
*/
function reached(ticket, trigger, thread, context = true) {
	if (ticket.origin.triggerId === trigger.id) return true;
	const input = ticket.inputs.some((item) => item.kind === "trigger" && item.triggerId === trigger.id);
	return trigger.threads.some((ref) => {
		const current = thread(threadKey(ref));
		return current?.subscriptions.includes(ticket.id) === true && (context || !current.context?.includes(ticket.id));
	}) || input && (context || !trigger.threads.every((ref) => thread(threadKey(ref))?.context?.includes(ticket.id)));
}
const latestAssignment = (ticket) => ticket.assignments.at(-1);
/** The latest report any of a ticket's Assignments made, which is what the ticket last said. */
const latestReport = (ticket) => ticket.assignments.findLast((assignment) => assignment.report)?.report;
/**
* Until when a ticket's worker had a turn to read what reached it: its latest report, but a progress report when `progress`
* is false, or the end of its latest turn, whichever is later.
*/
function readUntil(ticket, progress = true) {
	return [(ticket.assignments.findLast((assignment) => assignment.report && (progress || assignment.report.state !== "progress"))?.report)?.at ?? "", ...ticket.assignments.map((assignment) => assignment.idleAt ?? "")].reduce((a, b) => a > b ? a : b);
}
/**
* Whether a ticket waits for a person: its latest Assignment reported blocked or failed, and no person's message reached it
* since. A later report that is neither, a person's message, or a retry, which starts a new Assignment, lifts it.
*/
function waitsForPerson(ticket) {
	const report = latestAssignment(ticket)?.report;
	if (report?.state !== "blocked" && report?.state !== "failed") return false;
	return !ticket.inputs.some((input) => input.kind === "trigger" && input.human && !input.context && input.at > report.at);
}
// src/core/ids.ts
/** Stable content-derived identifiers; equal inputs always produce the same id. */
function key(...values) {
	return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32);
}
// src/limits.ts
/** Validation bounds shared between host schemas and management panel forms. */
const LIMITS = {
	ruleName: 100,
	ruleInstruction: 2e3,
	evalTimeoutSeconds: {
		min: 30,
		max: 600
	},
	maxWorkers: {
		min: 1,
		max: 16
	},
	prepareCommand: 4e3,
	promptMaxChars: {
		min: 1e3,
		max: 1e6
	},
	admissionContextMaxPages: {
		min: 1,
		max: 100
	},
	admissionContextTimeoutMs: {
		min: 1,
		max: 9e4
	}
};
// src/infra/text.ts
/** Word counting and string formatting utilities for IM message limits and templates. */
const words = new Intl.Segmenter("zh", { granularity: "word" });
/** Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation. */
function wordCount(text) {
	let count = 0;
	for (const segment of words.segment(text)) if (segment.isWordLike) count++;
	return count;
}
/** Validates that an outgoing IM Markdown message does not exceed `IM_WORDS` (link labels and URLs both count toward the limit). */
function checkedImText(text) {
	const count = wordCount(text);
	if (count > 100) throw new Error(`IM message has ${count} words; maximum is 100. Rewrite as a short high-level update. Do not split it into multiple messages.`);
	return text;
}
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
/** Case-insensitive comparison for GitHub logins and repository names. */
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// src/setup.ts
/** Structured startup and configuration errors with the settings location where the operator can fix them. */
const SETUP_PROBLEMS = {
	foreignFile: ["deployment", "{file} was not written by dsh-superagent; move it, or choose another state directory."],
	gitTooOld: ["deployment", "git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later."],
	environmentFailed: ["deployment", "Preparing the agent environment failed."],
	repositoryUnset: ["github", "The GitHub Source names no repository."],
	agentCliUnset: ["github", "The agent GitHub CLI is not set."],
	agentCliMissing: ["github", "The agent GitHub CLI was not found."],
	agentCliSignedOut: ["github", "The agent GitHub CLI cannot read its account."],
	agentCliNoAccount: ["github", "The agent GitHub CLI did not report a GitHub account."],
	repositoryUnreadable: ["github", "@{account} cannot read {repository}."],
	repositoryUnreported: ["github", "The agent GitHub CLI did not return {repository}."],
	repositoryReadOnly: ["github", "@{account} cannot push to {repository}."],
	projectUnset: ["gitlab", "The GitLab Source names no project."],
	gitlabCliUnset: ["gitlab", "The agent glab CLI is not set."],
	gitlabCliMissing: ["gitlab", "The agent glab CLI was not found."],
	gitlabCliSignedOut: ["gitlab", "The agent glab CLI cannot read its account."],
	gitlabCliNoAccount: ["gitlab", "The agent glab CLI did not report a GitLab account."],
	projectUnreadable: ["gitlab", "@{account} cannot read {project}."],
	projectUnreported: ["gitlab", "The agent glab CLI did not return {project}."],
	projectReadOnly: ["gitlab", "@{account} cannot push to {project}."],
	projectHostMismatch: ["gitlab", "The GitLab CLI is signed in to {actual}, but the Source names {host}."],
	gitlabGitTooOld: ["deployment", "git does not read the credential configuration for {host}; dsh-superagent needs git 2.32 or later."],
	stateDirUnsupported: ["deployment", "This state directory belongs to a GitHub installation; start with a new state directory for GitLab."]
};
/**
* Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
* `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
*/
var SetupError = class extends Error {
	code;
	values;
	place;
	constructor(code, values = {}) {
		const [place, text] = SETUP_PROBLEMS[code];
		const sentence = fill(text, values);
		super(values.output ? `${sentence}\n${values.output}` : sentence);
		this.code = code;
		this.values = values;
		this.place = place;
	}
	get problem() {
		return {
			place: this.place,
			code: this.code,
			values: this.values,
			detail: this.message
		};
	}
};
// src/infra/commands.ts
/** Subprocess wrapper for running gh, glab, and git commands under the deployment's configured accounts. */
const exec = promisify(execFile);
const TIMEOUT_MS = 9e4;
/**
* Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
* Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
*/
var CliError = class extends Error {
	code;
	exitCode;
	constructor(message, code, exitCode) {
		super(message);
		this.code = code;
		this.exitCode = exitCode;
	}
};
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
function commandError(error, program = "command") {
	if (error instanceof Error && error.name === "AbortError") return error;
	const exitCode = error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : void 0;
	if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string") {
		const stderr = error.stderr.trim();
		let parsed;
		try {
			parsed = JSON.parse(stderr.slice(stderr.indexOf("{")));
		} catch {}
		const code = parsed?.error?.code;
		if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ""}`, code, exitCode);
		if (stderr) return new CliError(stderr.slice(0, 2e3), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || void 0, exitCode);
	}
	return new CliError(`${basename(program)} ${ended(error)}`, void 0, exitCode);
}
function ended(error) {
	const { killed, signal, code } = error ?? {};
	if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "printed more output than it may";
	if (killed && signal === "SIGTERM") return `timed out after ${TIMEOUT_MS / 1e3} s`;
	if (signal) return `was stopped by ${signal}`;
	if (typeof code === "number") return `exited with code ${code}`;
	return typeof code === "string" ? `could not run: ${code}` : "failed";
}
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
function validItems(item, list, tally) {
	const items = list.flatMap((value) => {
		const parsed = item.safeParse(value);
		return parsed.success ? [parsed.data] : [];
	});
	if (tally) tally.skipped += list.length - items.length;
	return items;
}
/**
* Executes gh, glab, and git subprocesses with deployment account credentials, timeouts, and abort signals.
* Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
*/
var Commands = class Commands {
	resolved;
	environment;
	signal;
	/**
	* @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
	* @param environment - variables overriding `process.env` for every command (such as isolated git settings).
	*/
	constructor(resolved, environment, signal) {
		this.resolved = resolved;
		this.environment = environment;
		this.signal = signal;
	}
	get deployment() {
		return this.resolved();
	}
	get repository() {
		return this.deployment.repository;
	}
	withSignal(signal) {
		return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal])) : this;
	}
	async run(program, args, cwd) {
		try {
			const { stdout } = await exec(program, args, {
				cwd,
				signal: this.signal,
				timeout: TIMEOUT_MS,
				maxBuffer: 16777216,
				env: {
					...process.env,
					...this.environment,
					GH_PROMPT_DISABLED: "1"
				}
			});
			return stdout;
		} catch (error) {
			throw commandError(error, program);
		}
	}
	/** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
	async gh(args) {
		return JSON.parse(await this.run(this.deployment.github.cli, args));
	}
	/** Runs the agent's GitLab CLI (the glab-agent wrapper) and parses its JSON output. */
	async glab(args) {
		const host = this.deployment.codeHost;
		if (!host) throw new Error("This deployment has no GitLab account");
		return JSON.parse(await this.run(host.cli, args));
	}
	async api(schema, ...rest) {
		if (typeof schema === "string") return this.run(this.deployment.github.cli, [
			"api",
			this.path(schema),
			...rest
		]);
		const [path = "", ...flags] = rest;
		return schema.parse(await this.gh([
			"api",
			this.path(path),
			...flags
		]));
	}
	/** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
	async pages(item, path, tally) {
		return validItems(item, z.array(z.array(z.unknown())).parse(await this.gh([
			"api",
			this.path(path),
			"--paginate",
			"--slurp"
		])).flat(), tally);
	}
	path(path) {
		if (/^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)) throw new Error("GitHub calls are restricted to the configured repository");
		return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`;
	}
	/** Numeric GitLab project id, or undefined for a legacy GitHub deployment. */
	get projectId() {
		return this.deployment.project?.id;
	}
	/** `path_with_namespace` of the configured GitLab project. */
	get projectPath() {
		return this.deployment.project?.path;
	}
	async gitlabApi(schema, ...rest) {
		if (typeof schema === "string") return this.run(this.deployment.codeHost.cli, [
			"api",
			this.gitlabPath(schema),
			...rest
		]);
		const [path = "", ...flags] = rest;
		return schema.parse(await this.glab([
			"api",
			this.gitlabPath(path),
			...flags
		]));
	}
	/** Fetches every page of a GitLab API list as newline-delimited JSON; malformed lines are skipped and counted. */
	async gitlabPages(item, path, tally) {
		const text = await this.run(this.deployment.codeHost.cli, [
			"api",
			this.gitlabPath(path),
			"--paginate",
			"--output",
			"ndjson"
		]);
		return this.ndjson(item, text, tally);
	}
	gitlabPath(path) {
		const id = this.projectId;
		if (id === void 0) throw new Error("This deployment has no GitLab project");
		if (/^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)) throw new Error("GitLab calls are restricted to the configured project");
		return path ? `projects/${id}/${path}` : `projects/${id}`;
	}
	async gitlabUserApi(schema, ...rest) {
		if (typeof schema === "string") return this.run(this.deployment.codeHost.cli, [
			"api",
			this.userPath(schema),
			...rest
		]);
		const [path = "", ...flags] = rest;
		return schema.parse(await this.glab([
			"api",
			this.userPath(path),
			...flags
		]));
	}
	/** Fetches every page of a user-level GitLab API list as newline-delimited JSON; malformed lines are skipped and counted. */
	async gitlabUserPages(item, path, tally) {
		const text = await this.run(this.deployment.codeHost.cli, [
			"api",
			this.userPath(path),
			"--paginate",
			"--output",
			"ndjson"
		]);
		return this.ndjson(item, text, tally);
	}
	userPath(path) {
		if (/^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path) || !/^(?:todos|user)(?:[/?]|$)/.test(path)) throw new Error("User-level GitLab calls are restricted to todos and the current user");
		return path;
	}
	/** Parses newline-delimited JSON items, skipping malformed lines and items that fail `item` validation. */
	ndjson(item, text, tally) {
		return validItems(item, text.split("\n").filter(Boolean).flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				if (tally) tally.skipped += 1;
				return [];
			}
		}), tally);
	}
	/** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
	async git(args, cwd) {
		return this.run("git", args, cwd);
	}
};
// src/infra/environment.ts
/**
* Process environment and CLI shims that bind git, gh, and glab to the deployment's accounts and block disallowed commands.
* Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
* Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
*/
const MARKER = "# Written by dsh-superagent on every start; edits are lost.";
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = [
	"dsh-tag",
	"dsh-go",
	"dsh-freelancer"
].map((name) => `# Written by ${name} on every start; edits are lost.`);
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
const WORKER_COMMANDS = [
	"gh",
	"glab",
	"git"
];
const workerBin = (stateDir) => join(stateDir, "worker-bin");
const workerGitConfig = (stateDir) => join(stateDir, "worker-gitconfig");
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const gitQuote = (value) => `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
const credentialHelper = (cli) => `!${shellQuote(cli)} auth git-credential`;
function sameDirectory(a, b) {
	const real = (path) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	return real(a) === real(b);
}
function withoutDirectory(path, dir) {
	return path.split(delimiter).filter((entry) => !sameDirectory(entry, dir)).join(delimiter);
}
/**
* The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
* `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
* kept: it names no repository, and it stops git's search for one where the operator chose.
*/
const GIT_LOCATION = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_PREFIX",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE"
];
/**
* Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
* environment may name, and operator git identity/config overrides.
*/
function agentVariables(stateDir) {
	return {
		GH_TOKEN: void 0,
		GITHUB_TOKEN: void 0,
		GLAB_TOKEN: void 0,
		GITLAB_TOKEN: void 0,
		CI_JOB_TOKEN: void 0,
		...Object.fromEntries(GIT_LOCATION.map((name) => [name, void 0])),
		GIT_CONFIG_GLOBAL: workerGitConfig(stateDir),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: void 0,
		GIT_CONFIG_PARAMETERS: void 0,
		GIT_ASKPASS: "",
		SSH_ASKPASS: void 0,
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: void 0,
		GIT_COMMITTER_NAME: void 0,
		GIT_AUTHOR_EMAIL: void 0,
		GIT_COMMITTER_EMAIL: void 0
	};
}
/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file) {
	if (!(await lstat(file)).isFile()) return false;
	const head = (await readFile(file, "utf8")).split("\n", 2);
	return [MARKER, ...LEGACY_MARKERS].some((marker) => head.includes(marker));
}
async function own(file, text, mode = 420) {
	let foreign = false;
	try {
		foreign = !await written(file);
	} catch {}
	if (foreign) throw new SetupError("foreignFile", { file });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, text, { mode });
	await rename(temporary, file);
}
/**
* Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
* Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `glab` by name reach the real binary.
*/
async function writeEnvironment(deployment, blockedCommands) {
	const { stateDir, repository, github, codeHost } = deployment;
	const dir = workerBin(stateDir);
	await mkdir(dir, { recursive: true });
	const before = await readdir(dir);
	for (const name of before) {
		const file = join(dir, name);
		if (!await written(file)) throw new SetupError("foreignFile", { file });
	}
	const kept = /* @__PURE__ */ new Set();
	const shim = async (name, body) => {
		const temporary = join(dir, `.${name}.${process.pid}.tmp`);
		await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 493 });
		await rename(temporary, join(dir, name));
		kept.add(name);
	};
	const withoutShims = [
		`self=${shellQuote(dir)}`,
		"rest=",
		"IFS=:",
		"set -f",
		"for entry in $PATH; do [ \"$entry\" = \"$self\" ] || rest=\"${rest:+$rest:}$entry\"; done",
		"set +f",
		"unset IFS",
		"PATH=$rest",
		"export PATH"
	].join("\n");
	const run = (program) => `${withoutShims}\nexec ${shellQuote(program)} "$@"`;
	const fail = (message) => `echo ${shellQuote(message)} >&2\nexit 1`;
	if (codeHost) {
		await shim("gh", fail("gh is unavailable: this installation uses glab."));
		await shim("glab", run(codeHost.cli));
	} else await shim("gh", run(github.cli));
	const agent = codeHost?.login ?? github.login;
	const tool = codeHost ? "glab" : "gh";
	for (const name of new Set(blockedCommands.filter((name) => !WORKER_COMMANDS.includes(name)))) await shim(name, fail(`${name} is blocked in this installation; use ${tool}, which acts as ${agent}.`));
	for (const name of before) if (!kept.has(name)) await unlink(join(dir, name));
	const host = codeHost?.host ?? "github.com";
	const cli = codeHost?.cli ?? github.cli;
	await own(workerGitConfig(stateDir), [
		MARKER,
		"[user]",
		"	useConfigOnly = true",
		"[credential]",
		"	helper =",
		`[credential "https://${host}"]`,
		`\thelper = ${gitQuote(credentialHelper(cli))}`,
		`[url "https://${host}/"]`,
		`\tinsteadOf = git@${host}:`,
		`\tinsteadOf = ssh://git@${host}/`,
		"[filter \"lfs\"]",
		"	clean = git-lfs clean -- %f",
		"	smudge = git-lfs smudge -- %f",
		"	process = git-lfs filter-process",
		"	required = true"
	].join("\n") + "\n");
}
/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
function applyEnvironment(variables, stateDir, path) {
	const values = {
		...variables,
		PATH: [workerBin(stateDir), path].join(delimiter)
	};
	const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	const apply = (env) => {
		for (const [name, value] of Object.entries(env)) if (value === void 0) delete process.env[name];
		else process.env[name] = value;
	};
	apply(values);
	return () => {
		apply(previous);
	};
}
/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
async function runAsWorker(subprocess, argv, cwd, signal, env) {
	const handle = subprocess.spawn({
		argv,
		cwd,
		graceMs: 2e3,
		signal,
		...env ? { env } : {},
		stdio: {
			stdin: "ignore",
			stdout: { maxBytes: 1 << 20 },
			stderr: { maxBytes: 65536 }
		}
	});
	const { exitCode } = await handle.done;
	const read = (reader) => reader?.readFrom(0).text ?? "";
	if (exitCode === 0) return read(handle.collected.stdout);
	const ended = exitCode === null ? "was stopped before it finished" : `exited with ${exitCode}`;
	throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(" ")} ${ended}`, void 0, exitCode ?? void 0);
}
/** Verifies that worker git invocations resolve the deployment's credential helper for GitHub or GitLab. */
async function verifyEnvironment(deployment, subprocess, signal) {
	const { github, stateDir, codeHost } = deployment;
	const host = codeHost?.host ?? "github.com";
	const cli = codeHost?.cli ?? github.cli;
	if ((await runAsWorker(subprocess, [
		"git",
		"config",
		"-z",
		"--show-origin",
		"--get-all",
		`credential.https://${host}.helper`
	], stateDir, AbortSignal.any([signal, AbortSignal.timeout(6e4)])).catch(() => "")).split("\0").join("\0") !== [
		`file:${workerGitConfig(stateDir)}`,
		credentialHelper(cli),
		""
	].join("\0")) throw codeHost ? new SetupError("gitlabGitTooOld", { host }) : new SetupError("gitTooOld");
}
/**
* Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
* keys, which the agent's git would read from the repository's own config and act on.
*/
async function verifyDirectory(directory, subprocess, signal) {
	const scoped = (await runAsWorker(subprocess, [
		"git",
		"config",
		"-z",
		"--show-scope",
		"--get-regexp",
		"^(credential\\..*|http\\..*extraheader)$"
	], directory, AbortSignal.any([signal, AbortSignal.timeout(6e4)])).catch((error) => {
		if (error instanceof CliError && error.exitCode === 1) return "";
		throw error;
	})).split("\0");
	const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === "local" || scope === "worktree") ? [scoped[index + 1].split("\n")[0]] : []);
	if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(", ")}, which the agent's git would also read; remove them.`);
}
// src/sources/gitlab-trigger.ts
/** Normalizes GitLab Issues, merge requests, notes, discussions, and pipelines into domain Triggers. */
const SOURCE = "gitlab";
/** HTML marker embedded in a note so a repeated delivery of the same message ID creates no second note. */
const commentMarker = (id) => `<!-- dsh-superagent:${id} -->`;
/** Thread key of a GitLab Issue or merge request; the two IID sequences are independent, so the kind is part of the key. */
const gitlabThread = (iid, mr = false) => `${SOURCE}:${gitlabThreadId(iid, mr)}`;
/** `ThreadRef.id` of an Issue or merge request: the kind and IID, which `Thread.key` prefixes with the Source. */
const gitlabThreadId = (iid, mr = false) => `${mr ? "mr" : "issue"}:${iid}`;
/** Parses a full Thread key (`gitlab:issue:<iid>`) or a ThreadRef id (`issue:<iid>`) into its kind and IID. */
function gitlabThreadRef(thread) {
	const match = /^(?:gitlab:)?(issue|mr):([1-9]\d*)$/.exec(thread);
	return match ? {
		iid: Number(match[2]),
		mr: match[1] === "mr"
	} : void 0;
}
/** GitLab reply address: an Issue or merge request conversation, or one of its discussions. */
const gitlabChannel = (iid, discussionId, mr = false, url) => ({
	source: SOURCE,
	thread: gitlabThread(iid, mr),
	address: {
		iid: String(iid),
		mr: mr ? "true" : "false",
		...discussionId ? { discussion: discussionId } : {},
		...url ? { url } : {}
	}
});
/** Web page of an Issue or merge request; `mr` selects `merge_requests` over `issues`. */
const gitlabPage = (host, projectPath, iid, mr = false) => `https://${host}/${projectPath}/-/${mr ? "merge_requests" : "issues"}/${iid}`;
/**
* Parses a web URL of an Issue, work item, or merge request in `projectPath` on `host`.
* A `#note_<id>` fragment is returned as `note`; the discussion id is not part of a note URL.
*/
function gitlabAddress(url, host, projectPath) {
	const base = `^https?://${escapeRegExp(host)}/${escapeRegExp(projectPath)}/-/(issues|work_items|merge_requests)/([1-9]\\d*)`;
	const match = new RegExp(`${base}(?:[/?#].*)?$`, "i").exec(url);
	if (!match) return void 0;
	const note = /#note_(\d+)/i.exec(url)?.[1];
	return {
		iid: Number(match[2]),
		mr: match[1].toLowerCase() === "merge_requests",
		...note ? { note: Number(note) } : {}
	};
}
/**
* A GitLab user as an API entity returns it; a deleted account comes back as `null` or as the instance's Ghost User,
* whose `blocked` state never authorizes work.
*/
const UserSchema = z.looseObject({
	id: z.number().optional(),
	username: z.string(),
	name: z.string().nullish(),
	state: z.string().default("active"),
	bot: z.boolean().optional()
}).nullable().transform((user) => user ?? {
	username: "ghost",
	name: "Ghost User",
	state: "blocked",
	bot: false
});
/** True when GitLab reports an ordinary, active person: not a bot flag, GitLab's Ghost User, or a project/group access-token user. */
const isHumanUser = (user) => user.state === "active" && user.bot !== true && user.username !== "ghost" && !/^(?:project|group)_\d+_bot_/i.test(user.username);
/** An inline discussion note's file and line; GitLab does not include the diff hunk in the note. */
const PositionSchema = z.looseObject({
	base_sha: z.string().nullish(),
	start_sha: z.string().nullish(),
	head_sha: z.string().nullish(),
	old_path: z.string().nullish(),
	new_path: z.string().nullish(),
	position_type: z.string().nullish(),
	old_line: z.number().nullish(),
	new_line: z.number().nullish()
});
/** A GitLab note: a conversation comment, or an inline note carrying a diff `position`. */
const NoteSchema = z.looseObject({
	id: z.number(),
	type: z.string().nullish(),
	body: z.string().nullish(),
	author: UserSchema,
	created_at: z.string(),
	updated_at: z.string().nullish(),
	system: z.boolean().default(false),
	noteable_type: z.string().nullish(),
	noteable_iid: z.number().nullish(),
	resolvable: z.boolean().nullish(),
	resolved: z.boolean().nullish(),
	discussion_id: z.string().nullish(),
	position: PositionSchema.nullish()
});
/** A GitLab discussion: a group of notes, resolvable as a whole, that a diff thread or an ordinary thread lives in. */
const DiscussionSchema = z.looseObject({
	id: z.string(),
	individual_note: z.boolean().optional(),
	resolvable: z.boolean().nullish(),
	resolved: z.boolean().nullish(),
	notes: z.array(NoteSchema)
});
/** An Issue, which shares the note body fields but carries `iid` and `description` instead of `body`. */
const IssueSchema = NoteSchema.extend({
	iid: z.number(),
	title: z.string(),
	description: z.string().nullish(),
	state: z.string(),
	web_url: z.string(),
	project_id: z.number().optional(),
	updated_at: z.string().nullish()
});
const PipelineSchema = z.looseObject({
	id: z.number(),
	iid: z.number().optional(),
	status: z.string(),
	ref: z.string().optional(),
	sha: z.string().optional(),
	web_url: z.string().nullish()
});
/** A merge request; `state` is `opened`, `closed`, `locked`, or `merged`. */
const MergeRequestSchema = z.looseObject({
	id: z.number().optional(),
	iid: z.number(),
	title: z.string(),
	description: z.string().nullish(),
	state: z.string(),
	author: UserSchema,
	created_at: z.string(),
	updated_at: z.string().nullish(),
	web_url: z.string(),
	source_branch: z.string(),
	target_branch: z.string().optional(),
	sha: z.string().nullish(),
	merged_at: z.string().nullish(),
	closed_at: z.string().nullish(),
	merge_when_pipeline_succeeds: z.boolean().nullish(),
	auto_merge_enabled: z.boolean().nullish(),
	detailed_merge_status: z.string().nullish(),
	source_project_id: z.number().nullish(),
	target_project_id: z.number().nullish(),
	draft: z.boolean().optional(),
	discussion_locked: z.boolean().nullish(),
	project_id: z.number().optional(),
	head_pipeline: PipelineSchema.nullish()
});
/** Free approval facts; Premium requirements are deliberately not part of this contract. */
const ApprovalsSchema = z.looseObject({
	approved: z.boolean().nullish(),
	approved_by: z.array(z.object({ user: UserSchema })).default([])
});
const autoMergeEnabled = (mr) => mr.auto_merge_enabled ?? mr.merge_when_pipeline_succeeds ?? false;
const JobSchema = z.looseObject({
	id: z.number(),
	name: z.string(),
	status: z.string(),
	stage: z.string().nullish(),
	ref: z.string().optional(),
	allow_failure: z.boolean().optional(),
	web_url: z.string().nullish()
});
/** A TODO of the agent account; `target.iid` exists for Issues and merge requests but not for every `target_type`. */
const TodoSchema = z.looseObject({
	id: z.number(),
	action_name: z.string(),
	target_type: z.string(),
	state: z.string().optional(),
	author: UserSchema,
	project: z.looseObject({
		id: z.number(),
		path_with_namespace: z.string()
	}).optional(),
	target: z.looseObject({ iid: z.number().nullish() }).nullish(),
	target_url: z.string().nullish(),
	body: z.string().nullish(),
	created_at: z.string(),
	updated_at: z.string().nullish()
});
/** Whether `text` mentions `username` as a standalone `@username`, case-insensitively; GitLab usernames may contain dots. */
const mentions = (text, username) => new RegExp(`(?:^|[^a-zA-Z0-9_@.])@${escapeRegExp(username)}(?![a-zA-Z0-9_.-])`, "i").test(text);
const author = (user, agent) => ({
	actor: {
		source: SOURCE,
		id: user.username
	},
	human: isHumanUser(user) && !sameName(user.username, agent)
});
/** Formats an inline note's file:line; a conversation note has no place. */
function notePlace(note) {
	const line = note.position?.new_line ?? note.position?.old_line;
	const path = note.position?.new_path ?? note.position?.old_path;
	return path ? `${path}${line != null ? `:${line}` : ""}` : "";
}
const webUrl = (note, ref) => {
	const page = ref.url ?? (ref.host && ref.projectPath ? gitlabPage(ref.host, ref.projectPath, ref.iid, ref.mr) : "");
	return page ? `${page}#note_${note.id}` : void 0;
};
/**
* Builds the trigger for a conversation or inline note.
* A system note returns undefined: GitLab writes mentions into assignment and label notes, which grant nothing.
*/
function noteTrigger(note, ref, agent) {
	if (note.system) return void 0;
	const discussionId = note.discussion_id ?? ref.discussionId;
	const kind = ref.mr ? note.position ? "inline" : "conversation" : "note";
	const url = webUrl(note, ref);
	const line = note.position?.new_line ?? note.position?.old_line;
	const path = note.position?.new_path ?? note.position?.old_path;
	const at = note.updated_at ?? note.created_at;
	return {
		id: key("gitlab-note", String(note.id), at),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: gitlabThreadId(ref.iid, ref.mr)
		}],
		...author(note.author, agent),
		at,
		text: [notePlace(note), note.body ?? ""].filter(Boolean).join("\n\n"),
		...mentions(note.body ?? "", agent) ? { addressed: "mention" } : {},
		channel: gitlabChannel(ref.iid, discussionId, ref.mr, url),
		...url ? { url } : {},
		meta: {
			iid: ref.iid,
			mr: ref.mr,
			kind,
			commentId: note.id,
			...ref.projectId !== void 0 ? { projectId: ref.projectId } : {},
			...discussionId ? { discussionId } : {},
			...path ? {
				path,
				...line != null ? { line } : {}
			} : {},
			...note.resolvable != null ? {
				resolvable: note.resolvable,
				resolved: note.resolved === true
			} : {}
		}
	};
}
/** Builds the trigger for a newly opened Issue's title and description. */
function issueTrigger(issue, agent) {
	const description = issue.description ?? "";
	return {
		id: key("gitlab-issue", String(issue.iid)),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: gitlabThreadId(issue.iid, false)
		}],
		...author(issue.author, agent),
		at: issue.created_at,
		text: `${issue.title}\n\n${description}`,
		...mentions(description, agent) ? { addressed: "mention" } : {},
		channel: gitlabChannel(issue.iid, void 0, false, issue.web_url),
		url: issue.web_url,
		meta: {
			iid: issue.iid,
			mr: false,
			kind: "issue",
			...issue.project_id !== void 0 ? { projectId: issue.project_id } : {}
		}
	};
}
/** Builds the trigger for a newly opened merge request's title and description. */
function mrTrigger(mr, agent) {
	const description = mr.description ?? "";
	return {
		id: key("gitlab-mr", String(mr.iid)),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: gitlabThreadId(mr.iid, true)
		}],
		...author(mr.author, agent),
		at: mr.created_at,
		text: `${mr.title}\n\n${description}`,
		...mentions(description, agent) ? { addressed: "mention" } : {},
		channel: gitlabChannel(mr.iid, void 0, true, mr.web_url),
		url: mr.web_url,
		meta: {
			iid: mr.iid,
			mr: true,
			kind: "mr",
			mrAuthor: mr.author.username,
			mrSourceBranch: mr.source_branch,
			...mr.project_id !== void 0 ? { projectId: mr.project_id } : {}
		}
	};
}
/** Builds a trigger for a change in the default branch's pipeline failures; default-branch CI has no person to reply to. */
function branchPipelineTrigger(branch, sha, revision, summary, url) {
	return {
		id: key("gitlab-ci", `branch:${branch}`, String(revision)),
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
/** Builds a trigger for a change in an open merge request's pipeline failures. */
function pipelineTrigger(mr, revision, summary) {
	return {
		id: key("gitlab-ci", String(mr.iid), String(revision)),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: gitlabThreadId(mr.iid, true)
		}],
		actor: {
			source: SOURCE,
			id: ""
		},
		human: false,
		at: (/* @__PURE__ */ new Date()).toISOString(),
		text: summary,
		channel: gitlabChannel(mr.iid, void 0, true, mr.web_url),
		url: mr.web_url,
		meta: {
			iid: mr.iid,
			mr: true,
			mrAuthor: mr.author.username,
			ci: true,
			revision,
			...mr.sha ? { sha: mr.sha } : {}
		}
	};
}
// src/sources/gitlab-read.ts
/** Read-only GitLab repository, Issue/MR conversation, discussion, and pipeline inspection for assessments and workers. */
/** Job statuses that count as failures; a failed pipeline with no failed job is reported by its status. */
const FAILING = /* @__PURE__ */ new Set(["failed", "canceled"]);
/** Finished job statuses; a required manual job still waits for a person. */
const FINISHED = /* @__PURE__ */ new Set([
	"success",
	"skipped",
	"manual",
	"failed",
	"canceled"
]);
const failedJob = (job) => !job.allow_failure && FAILING.has(job.status);
const runningJob = (job) => !FINISHED.has(job.status) || job.status === "manual" && job.allow_failure === false;
const jobName = (job) => job.stage ? `${job.stage}/${job.name}` : job.name;
function ciCounts(snapshot) {
	const failedJobs = snapshot.jobs.filter(failedJob).length;
	const runningJobs = snapshot.jobs.filter(runningJob).length;
	const pipelineFailed = FAILING.has(snapshot.pipeline.status);
	const pipelineRunning = ![
		"success",
		"failed",
		"canceled"
	].includes(snapshot.pipeline.status);
	return {
		failed: failedJobs + (pipelineFailed && !failedJobs ? 1 : 0),
		running: runningJobs + (pipelineRunning && !runningJobs ? 1 : 0)
	};
}
function ciFailures(snapshot) {
	const failed = snapshot.jobs.filter(failedJob).map(jobName);
	if (!failed.length && FAILING.has(snapshot.pipeline.status)) failed.push(`pipeline:${snapshot.pipeline.status}`);
	return [...new Set(failed)].sort();
}
function ciSummary(snapshot, where, read) {
	const counts = ciCounts(snapshot);
	const failed = snapshot.jobs.filter(failedJob).map(jobName);
	const running = snapshot.jobs.filter(runningJob).map((job) => job.name);
	const names = (list) => list.slice(0, 5).join(", ") + (list.length > 5 ? `, and ${list.length - 5} more` : "");
	const at = `on ${where} at ${(snapshot.pipeline.sha ?? "").slice(0, 7) || `pipeline ${snapshot.pipeline.id}`}`;
	const still = running.length ? `; ${running.length} still running` : "";
	const total = snapshot.jobs.length || 1;
	return `${counts.failed ? `CI failed ${counts.failed}/${total} ${at}: ${names(failed.length ? failed : [`pipeline:${snapshot.pipeline.status}`])}${still}` : counts.running ? `CI running ${counts.running}/${total} ${at}: ${names(running.length ? running : [`pipeline:${snapshot.pipeline.status}`])}` : `CI passed ${total}/${total} ${at}`}\nRead ${read} for every job.`;
}
function ciFact(counts) {
	if (counts.failed) return {
		label: {
			zh: "CI 失败",
			en: "CI failed"
		},
		value: String(counts.failed),
		problem: true
	};
	if (counts.running) return {
		label: {
			zh: "CI 进行中",
			en: "CI running"
		},
		value: String(counts.running)
	};
	return {
		label: "CI",
		value: {
			zh: "通过",
			en: "passed"
		}
	};
}
const ciRecovered = (snapshot) => snapshot.pipeline.status === "success" && !ciCounts(snapshot).running;
/** Reads current jobs of a pipeline (GitLab excludes retried attempts by default); allowed failures remain in raw data. */
async function readPipelineJobs(commands, pipelineId, tally) {
	return commands.gitlabPages(JobSchema, `pipelines/${pipelineId}/jobs?per_page=100`, tally);
}
/** Builds a CI snapshot from a pipeline and its jobs. */
async function pipelineSnapshot(commands, pipeline, tally) {
	const skipped = { skipped: 0 };
	const jobs = await readPipelineJobs(commands, pipeline.id, skipped);
	if (tally) tally.skipped += skipped.skipped;
	if (skipped.skipped) throw new Error("Incomplete pipeline jobs; CI checkpoint retained");
	return {
		pipeline: {
			id: pipeline.id,
			status: pipeline.status,
			...pipeline.ref ? { ref: pipeline.ref } : {},
			...pipeline.sha ? { sha: pipeline.sha } : {}
		},
		jobs: jobs.sort((a, b) => a.name.localeCompare(b.name))
	};
}
/** Reads the newest pipeline for a commit or ref, or undefined when none ran. */
async function pipelineFor(commands, selector, tally) {
	const query = selector.sha ? `sha=${encodeURIComponent(selector.sha)}` : `ref=${encodeURIComponent(selector.ref ?? "")}`;
	return (await commands.gitlabPages(PipelineSchema, `pipelines?${query}&per_page=20&order_by=id&sort=desc`, tally)).sort((a, b) => b.id - a.id)[0];
}
/** Selects the current MR pipeline; an old head pipeline cannot validate a newer commit. */
async function mrPipeline(commands, mr, tally) {
	const head = mr.head_pipeline;
	return (head && (!mr.sha || !head.sha || head.sha === mr.sha) ? head : void 0) ?? pipelineFor(commands, {
		sha: mr.sha ?? void 0,
		ref: mr.source_branch
	}, tally);
}
/** Optional approval capability: forbidden/unavailable is unknown, never 'not approved'. Other failures stay retryable. */
async function readApprovals(commands, iid) {
	try {
		const value = await commands.gitlabApi(ApprovalsSchema, `merge_requests/${iid}/approvals`);
		return {
			available: true,
			approved: value.approved ?? null,
			approved_by: [...new Set(value.approved_by.map((item) => item.user.username))].sort()
		};
	} catch (error) {
		if (error instanceof CliError && (error.code === 403 || error.code === 404)) return {
			available: false,
			status: error.code
		};
		throw error;
	}
}
/** Reads a non-hidden file or directory listing from the project's default branch; paths that leave the project are rejected. */
async function readRepositoryPath(commands, path, kind) {
	if (/^\/|^[a-z]+:/i.test(path)) throw new Error("Only paths inside the project are available");
	const parts = path.split("/").filter((part) => part && part !== ".");
	if (parts.some((part) => part === ".." || part.startsWith(".") || part === "node_modules")) throw new Error("Only non-hidden repository source paths are available");
	if (kind === "file" && !parts.length) throw new Error("Name a file to read");
	const ref = commands.deployment.project?.defaultBranch ?? "main";
	if (kind === "file") {
		const encoded = encodeURIComponent(parts.join("/"));
		return commands.gitlabApi(`repository/files/${encoded}/raw?ref=${encodeURIComponent(ref)}`);
	}
	const query = parts.length ? `?path=${encodeURIComponent(parts.join("/"))}&ref=${encodeURIComponent(ref)}&per_page=100` : `?ref=${encodeURIComponent(ref)}&per_page=100`;
	return (await commands.gitlabPages(z.looseObject({
		name: z.string(),
		type: z.string().nullish(),
		path: z.string()
	}), `repository/tree${query}`)).map((entry) => entry.name).filter((name) => !name.startsWith(".") && name !== "node_modules").sort().join("\n");
}
/** Formats a GitLab note as a model-facing message, marking bots and access-token users because their words never authorize work. */
function gitlabMessage(note, text, id) {
	const line = note.position?.new_line ?? note.position?.old_line;
	const path = note.position?.new_path ?? note.position?.old_path;
	return {
		id,
		from: note.author.username,
		at: note.updated_at ?? note.created_at,
		text: text || note.body || "",
		...!isHumanUser(note.author) ? { bot: true } : {},
		...id.startsWith("http") ? { url: id } : {},
		...path ? {
			path,
			...line != null ? { line } : {}
		} : {}
	};
}
/** Web page of an Issue or merge request, the base of a note's message ID. */
const entityPage = (commands, iid, mr) => commands.deployment.project?.webUrl ? `${commands.deployment.project.webUrl}/-/${mr ? "merge_requests" : "issues"}/${iid}` : "";
const noteUrl = (base, note) => `${base}#note_${note.id}`;
const noteMessage = (note, base, place = false) => gitlabMessage(note, [place ? notePlace(note) : "", note.body ?? ""].filter(Boolean).join("\n\n"), noteUrl(base, note));
/** A discussion's notes as messages, the first with its diff place; later notes answer the first. */
function discussionMessages(discussion, base, place = true) {
	const notes = discussion.notes.filter((note) => !note.system).sort((a, b) => a.created_at.localeCompare(b.created_at));
	const [first] = notes;
	return notes.map((note) => {
		const message = noteMessage(note, base, place && note === first);
		return note === first ? message : {
			...message,
			...first ? { reply_to: noteUrl(base, first) } : {}
		};
	});
}
const descriptionMessage = (item) => ({
	id: item.web_url,
	from: item.author.username,
	at: item.created_at,
	text: `${item.title}\n\n${item.description ?? ""}`.trimEnd(),
	...!isHumanUser(item.author) ? { bot: true } : {},
	url: item.web_url
});
async function conversationPage(commands, iid, mr, page) {
	const messages = [];
	if (page === 1) {
		const item = mr ? await commands.gitlabApi(MergeRequestSchema, `merge_requests/${iid}`) : await commands.gitlabApi(IssueSchema, `issues/${iid}`);
		messages.push(descriptionMessage(item));
	}
	const base = mr ? `merge_requests/${iid}` : `issues/${iid}`;
	const listed = await commands.gitlabApi(z.array(z.unknown()), `${base}/notes?per_page=100&page=${page}&sort=asc&order_by=created_at`);
	const tally = { skipped: 0 };
	const notes = validItems(NoteSchema, listed, tally).filter((note) => !note.system);
	const page0 = entityPage(commands, iid, mr);
	messages.push(...notes.map((note) => noteMessage(note, page0, true)));
	return {
		messages,
		next_resource: listed.length === 100 ? String(page + 1) : null,
		...tally.skipped ? { skipped: tally.skipped } : {}
	};
}
/**
* Reads an Issue, merge request, conversation page, discussion, or pipeline jobs as model-facing
* `{ id, from, at, text, reply_to?, path?, line?, url }` messages rather than raw GitLab records.
*/
async function readGitlab(commands, resource) {
	const jobs = /^gitlab\/pipelines\/([1-9]\d*)\/jobs$/.exec(resource);
	if (jobs) return { jobs: await readPipelineJobs(commands, Number(jobs[1])) };
	const match = /^gitlab\/(issues|merge_requests)\/([1-9]\d*)(?:\/(notes|discussions|pipelines|approvals)(?:\/([1-9]\d*))?)?$/.exec(resource);
	if (!match) throw new Error("Use gitlab/issues/<iid>, gitlab/merge_requests/<iid>, append /notes/<page>, /discussions/<page>, /approvals or /pipelines, or gitlab/pipelines/<id>/jobs");
	const [, kind, iidText, section, page = "1"] = match;
	const iid = Number(iidText);
	const mr = kind === "merge_requests";
	const base = `${kind}/${iid}`;
	if (section === "approvals") {
		if (!mr || match[4]) throw new Error("Approvals require a merge request without a page");
		return readApprovals(commands, iid);
	}
	if (!section) {
		if (mr) {
			const item = await commands.gitlabApi(MergeRequestSchema, base);
			return {
				iid: item.iid,
				title: item.title,
				state: item.state,
				...item.merged_at ? { merged: true } : {},
				...item.draft ? { draft: true } : {},
				auto_merge_enabled: autoMergeEnabled(item),
				detailed_merge_status: item.detailed_merge_status ?? null,
				approvals_resource: `gitlab/merge_requests/${iid}/approvals`,
				source_branch: item.source_branch,
				target_branch: item.target_branch,
				...item.head_pipeline ? {
					pipeline: item.head_pipeline.id,
					pipeline_status: item.head_pipeline.status
				} : {},
				...descriptionMessage(item)
			};
		}
		const item = await commands.gitlabApi(IssueSchema, base);
		return {
			iid: item.iid,
			title: item.title,
			state: item.state,
			...descriptionMessage(item)
		};
	}
	if (section === "pipelines") {
		if (mr) {
			const pipeline = await mrPipeline(commands, await commands.gitlabApi(MergeRequestSchema, base));
			if (!pipeline) return {
				pipeline: null,
				jobs: []
			};
			return pipelineSnapshot(commands, pipeline);
		}
		const issue = await commands.gitlabApi(IssueSchema, base);
		throw new Error(`Issue #${issue.iid} has no pipelines; read the merge request that closes it instead`);
	}
	if (section === "discussions") {
		if (!mr) throw new Error("Discussions require a merge request");
		const listed = await commands.gitlabApi(z.array(z.unknown()), `${base}/discussions?per_page=100&page=${page}`);
		const tally = { skipped: 0 };
		const discussions = validItems(DiscussionSchema, listed, tally);
		const page0 = entityPage(commands, iid, true);
		return {
			messages: discussions.flatMap((discussion) => discussionMessages(discussion, page0).map((message) => ({
				...message,
				discussionId: discussion.id
			}))),
			...tally.skipped ? { skipped: tally.skipped } : {},
			...listed.length === 100 ? { next_resource: `gitlab/merge_requests/${iid}/discussions/${Number(page) + 1}` } : {}
		};
	}
	const listed = await commands.gitlabApi(z.array(z.unknown()), `${base}/notes?per_page=100&page=${page}&sort=asc&order_by=created_at`);
	const tally = { skipped: 0 };
	const notes = validItems(NoteSchema, listed, tally).filter((note) => !note.system);
	const page0 = entityPage(commands, iid, mr);
	return {
		messages: notes.map((note) => noteMessage(note, page0, true)),
		...tally.skipped ? { skipped: tally.skipped } : {},
		...listed.length === 100 ? { next_resource: `gitlab/${kind}/${iid}/notes/${Number(page) + 1}` } : {}
	};
}
/**
* Context reader for a GitLab Trigger: reads the whole discussion for a discussion note, the Issue or merge request
* conversation by page otherwise, and the Trigger itself for default-branch CI. Images are not supported.
*/
const gitlabThreadContext = {
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
		const iid = Number(trigger.meta.iid);
		const mr = trigger.meta.mr === true;
		const discussionId = typeof trigger.meta.discussionId === "string" ? trigger.meta.discussionId : void 0;
		if (mr && discussionId) {
			const discussion = (await commands.gitlabPages(DiscussionSchema, `merge_requests/${iid}/discussions?per_page=100`)).find((item) => item.id === discussionId);
			const base = entityPage(commands, iid, true);
			const messages = discussion ? discussionMessages(discussion, base, true) : [];
			if (messages.length) {
				const read = part === "thread" ? messages : messages.slice(0, 1);
				return {
					messages: read,
					body: {
						status: "discussion",
						discussionId,
						messages: read
					},
					status: "discussion"
				};
			}
		}
		const body = await conversationPage(commands, iid, mr, Number(cursor ?? "1"));
		return {
			messages: body.messages,
			next: body.next_resource ?? void 0,
			body
		};
	}
};
// src/sources/gitlab-mr.ts
/** Merge request binding, lifecycle observation, and terminal notice helpers for the GitLab Source. */
const readMr = async (ctx, iid, signal) => ctx.commands.withSignal(signal).gitlabApi(MergeRequestSchema, `merge_requests/${iid}`);
const mrsOf = (ticket, open = false) => (ticket.follows ?? []).filter((item) => !open || !item.closed).flatMap((item) => {
	const ref = gitlabThreadRef(item.thread);
	return ref?.mr ? [ref.iid] : [];
});
const mrOf = (ticket) => mrsOf(ticket, true).at(-1) ?? mrsOf(ticket).at(-1);
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
const ticketBranch = (ticket, ref) => !!ticket.execution?.name && ref.split("/").at(-1) === ticket.execution.name;
/**
* True when the MR was opened by the agent account from the configured project rather than from a fork.
* Both project ids must identify the configured project; a missing source id can mean a deleted fork.
*/
const agentMr = (mr, deployment) => {
	if (!deployment.codeHost || !sameName(mr.author.username, deployment.codeHost.login)) return false;
	const project = deployment.project?.id;
	if (project === void 0) return true;
	return mr.source_project_id === project && mr.target_project_id === project;
};
const AUTO_MERGE_ON = {
	label: {
		zh: "自动合并",
		en: "Auto-merge"
	},
	value: {
		zh: "已开启",
		en: "on"
	}
};
const mergeStatus = (status) => status ? {
	label: {
		zh: "合并状态",
		en: "Merge status"
	},
	value: status
} : null;
/**
* Validates and binds an open MR to a ticket when the MR is either the ticket's origin MR or an agent-authored MR on the
* ticket's branch, enforcing that one MR binds to at most one open ticket.
* Returns an error message when binding is rejected, or undefined when the MR is bound or not open.
*/
function claimMr(ctx, ticketId, mr) {
	const ticket = ctx.tickets.get(ticketId);
	if (!ticket || !liveTicket(ticket)) return "Ticket ended because its MR was closed";
	const source = ctx.triggers.get(ticket.origin.triggerId);
	const started = source?.source === "gitlab" && source.meta.mr === true && Number(source.meta.iid) === mr.iid;
	if (ctx.deployment.project && mr.target_project_id != null && mr.target_project_id !== ctx.deployment.project.id) return "MR targets another project";
	const opened = agentMr(mr, ctx.deployment) && ticketBranch(ticket, mr.source_branch);
	if (!started && !opened) return `MR does not belong to this ticket: use the source MR or an MR by ${ctx.deployment.codeHost?.login ?? "the agent account"} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit mr_iid when no MR exists`;
	const owner = ctx.tickets.open().find((item) => mrsOf(item, true).includes(mr.iid));
	if (owner && owner.id !== ticketId) return "MR already belongs to another active ticket";
	const follow = ticket.follows?.find((item) => item.thread === gitlabThread(mr.iid, true));
	if (mr.state === "opened" && (!follow || follow.closed || opened && !follow.own)) bind(ctx, ticketId, mr, opened);
}
/**
* Reconciles a polled MR's open/merged/closed/locked state, auto-merge request, and merge status with any bound or
* branch-matching ticket. An open agent MR auto-binds to the single open ticket on its branch unless that ticket already
* follows another open MR; `merge_when_pipeline_succeeds` stays a fact and never merges anything.
* @returns whether the MR has ended.
*/
async function observeMr(ctx, mr) {
	if (ctx.deployment.project && mr.target_project_id != null && mr.target_project_id !== ctx.deployment.project.id) return false;
	const ended = mr.state === "merged" || mr.state === "closed" || mr.state === "locked";
	if (ended) closeMr(ctx, mr);
	else {
		const candidates = agentMr(mr, ctx.deployment) ? ctx.tickets.open().filter((ticket) => ticketBranch(ticket, mr.source_branch)) : [];
		const ticket = candidates.length === 1 ? candidates[0] : void 0;
		const reopened = ticket?.follows?.some((item) => item.thread === gitlabThread(mr.iid, true) && item.closed);
		if (ticket && (reopened || mrsOf(ticket, true).every((iid) => iid === mr.iid))) claimMr(ctx, ticket.id, mr);
	}
	ctx.threads.describe(gitlabThread(mr.iid, true), { facts: {
		autoMerge: !ended && autoMergeEnabled(mr) ? AUTO_MERGE_ON : null,
		mergeStatus: ended ? null : mergeStatus(mr.detailed_merge_status)
	} });
	return ended;
}
function bind(ctx, ticketId, mr, own) {
	ctx.atomic(() => {
		ctx.tickets.bindThread(ticketId, {
			source: SOURCE,
			id: gitlabThreadId(mr.iid, true)
		}, own);
		ctx.threads.patch(gitlabThread(mr.iid, true), {
			iid: mr.iid,
			mr: true,
			url: mr.web_url,
			title: mr.title,
			mrAuthor: mr.author.username
		});
	});
}
/** Reports a merged or closed MR once to the open tickets that follow it, whose end the core decides. */
function closeMr(ctx, mr) {
	if (!ctx.tickets.open().some((ticket) => mrsOf(ticket, true).includes(mr.iid))) return;
	const at = mr.merged_at ?? mr.closed_at ?? (/* @__PURE__ */ new Date()).toISOString();
	ctx.tickets.threadClosed({
		source: SOURCE,
		id: gitlabThreadId(mr.iid, true)
	}, mr.merged_at || mr.state === "merged" ? "merged" : "closed", at);
}
/**
* Builds idempotent outbound notices for an MR's merge or close, for every channel except GitLab, whose timeline already
* shows it. `projectWebUrl` is the project page, such as `https://gitlab.example.com/group/project`.
*/
function mrEndNotices(ticket, request, projectWebUrl) {
	const outcome = ticket.ended?.outcome;
	const follows = (ticket.follows ?? []).filter((item) => item.closed && gitlabThreadRef(item.thread)?.mr === true);
	const latest = (items) => items.sort((a, b) => b.closed.at.localeCompare(a.closed.at))[0];
	const follow = latest(follows.filter((item) => item.own)) ?? latest(follows);
	if (outcome !== "merged" && outcome !== "closed" || !follow) return [];
	const iid = gitlabThreadRef(follow.thread).iid;
	const url = `${projectWebUrl}/-/merge_requests/${iid}`;
	const text = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request) ? outcome === "merged" ? `[MR !${iid}](${url}) 已合并。` : `[MR !${iid}](${url}) 已关闭，未合并。` : outcome === "merged" ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`;
	return ticket.channels.filter((channel) => channel.source !== SOURCE).map((channel) => ({
		id: key("mr-terminal", String(iid), channel.source, JSON.stringify(channel.address), outcome),
		channel,
		text,
		kind: "notice",
		ticketId: ticket.id
	}));
}
/** Publishes/clears optional approval facts without introducing authorization or lifecycle actions. */
function observeApprovals(ctx, iid, value) {
	ctx.threads.describe(gitlabThread(iid, true), { facts: {
		approvals: !value?.available ? null : {
			label: {
				en: "Approvals",
				zh: "批准"
			},
			value: value.approved_by.length ? value.approved_by.map((user) => `@${user}`).join(", ") : {
				en: "none",
				zh: "无"
			}
		},
		approved: value?.available && value.approved !== null ? {
			label: {
				en: "Approved",
				zh: "已批准"
			},
			value: value.approved ? {
				en: "yes",
				zh: "是"
			} : {
				en: "no",
				zh: "否"
			}
		} : null,
		approvalsUnavailable: value && !value.available ? {
			label: {
				en: "Approvals",
				zh: "批准"
			},
			value: {
				en: "unavailable",
				zh: "不可用"
			}
		} : null
	} });
}
// src/kv.ts
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
const record = (key) => key;
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
function family(prefix, format = (...name) => name.join(":")) {
	return Object.assign((...name) => `${prefix}${format(...name)}`, { prefix });
}
const KV = {
	/** Store: current database schema version. */
	store: { schema: record("schema") },
	/** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
	settings: {
		revision: record("settings-revision"),
		block: family("settings-block-revision:"),
		version: family("settings-version:")
	},
	/** Prompts: current revision and saved prompt versions. */
	prompts: {
		revision: record("prompt-revision"),
		version: family("prompt-version:"),
		/** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
		builtIn: family("prompt-built-in:")
	},
	/** Runtime: the main Session's ID. */
	runtime: { masterId: record("master-id") },
	/** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
	sessions: { prompts: family("session-prompts:") },
	/** Schema 11 migration: legacy main-Session queues imported into the effect table. */
	queues: {
		relays: record("relay-queue"),
		unsubscribed: record("subscription-results"),
		prompts: record("prompt-notification"),
		settings: record("settings-notification")
	},
	/** Per-Source resolved display names mapping a named ID (such as a chat ID) to its display name. */
	sources: { labels: family("source-labels:") },
	/**
	* GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
	* per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
	* counts reported CI changes so each produces a distinct Trigger ID).
	*/
	github: {
		since: record("github-since"),
		retries: record("github-retry"),
		cursor: family("github-cursor:"),
		stream: family("github-stream:"),
		branchCi: record("github-branch-ci"),
		ci: family("github-ci:")
	},
	/**
	* GitLab Source: pending-TODO cursor and failed target reads; per-Issue/MR read cursor shared by TODO and polled reads;
	* per-stream cursor and start time; default-branch pipeline state; and per-MR pipeline fingerprint and revision
	* (`revision` counts reported CI changes so each produces a distinct Trigger ID).
	*/
	gitlab: {
		todos: record("gitlab-todos"),
		retries: record("gitlab-retry"),
		cursor: family("gitlab-cursor:", (kind, iid) => `${kind}:${iid}`),
		stream: family("gitlab-stream:"),
		branchPipeline: record("gitlab-branch-pipeline"),
		pipeline: family("gitlab-pipeline:")
	},
	/**
	* Legacy chat Source (removed; kept for the schema-11 migration until P7): known chats, history cursor and active topics,
	* and per-polled-thread seen message IDs and initialization flag.
	*/
	feishu: {
		chats: record("feishu-chats"),
		history: family("feishu-history:"),
		topics: family("feishu-history-threads:"),
		seen: family("thread-seen:"),
		initialized: family("thread-initialized:")
	}
};
// src/sources/poll.ts
/** Shared polling helpers for subscribed threads, overlap-safe cursors, and timer-friendly delays. */
/** How long a subscribed Thread with no live Ticket continues to be polled after its last Trigger or Ticket end. */
const POLL_HORIZON_MS = 12096e5;
/** True when a subscribed thread has a live ticket or recent activity/completion within `POLL_HORIZON_MS`. */
function polled(ctx, thread, now = Date.now()) {
	const tickets = thread.subscriptions.map((id) => ctx.tickets.get(id));
	if (tickets.some((ticket) => !!ticket && liveTicket(ticket))) return true;
	const times = [thread.lastAt ?? thread.createdAt, ...tickets.map((ticket) => ticket?.ended?.at ?? "")].map(Date.parse).filter(Number.isFinite);
	return now - Math.max(...times) < POLL_HORIZON_MS;
}
/** Steps a poll start timestamp back by 5 seconds so late-arriving remote events are not missed; deterministic trigger IDs deduplicate overlaps. */
const cursorAt = (started) => (/* @__PURE__ */ new Date(Date.parse(started) - 5e3)).toISOString();
/** Polls each subscribed Thread of `source` within the horizon independently; records failures on the Thread as `pollError` (unless `stopped()`) and clears `pollError` on success. */
async function pollThreads(ctx, source, stopped, poll, skip = () => false) {
	for (const thread of ctx.threads.subscribed(source)) {
		if (stopped()) return;
		if (skip(thread) || !polled(ctx, thread)) continue;
		try {
			await poll(thread);
			ctx.threads.patch(thread.key, { pollError: void 0 });
		} catch (error) {
			if (stopped()) return;
			ctx.threads.patch(thread.key, { pollError: String(error) });
		}
	}
}
/** Waits `ms` or until `signal` aborts using global `setTimeout` so test fake timers can drive polling loops. */
function pause(ms, signal) {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const stop = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, ms);
		signal.addEventListener("abort", stop, { once: true });
	});
}
// src/sources/gitlab-access.ts
/** GitLab access levels: 20 Reporter reads, 30 Developer writes, 40 Maintainer administers the project. */
const READ = 20;
const WRITE = 30;
const MAINTAIN = 40;
/** Resolves the highest of project and inherited group access; a missing `permissions` object means no access was reported. */
function resolveAccess(permissions) {
	const project = permissions?.project_access?.access_level ?? 0;
	const group = permissions?.group_access?.access_level ?? 0;
	const level = Math.max(project, group);
	return {
		level,
		source: level === 0 ? "none" : project >= group ? "project" : "group",
		read: level >= READ,
		write: level >= WRITE,
		maintain: level >= MAINTAIN
	};
}
// src/deployment.ts
/** Plugin configuration and startup verification for repository access and agent CLI identities. */
const reason = (error) => error instanceof Error ? error.message : String(error);
const absolute = (description) => s.string().pattern(/^\//).description(`${description} Absolute path.`);
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
const Config = s.object({
	stateDir: absolute("Directory for the database, locks, worker shims, the agent's git configuration and, by default, the ticket directories.").required(),
	promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(1e5).description("Largest saved prompt configuration, in characters.").volatile(),
	admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10).description("Pages of thread context one assessment may read.").volatile(),
	admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1).default(15e3).description("Time limit of one context read during an assessment, in milliseconds.").volatile()
});
const MOVED = {
	repository: "on the GitHub Source",
	branchPrefix: "in the prepare command of the Execution settings",
	github: "on the GitHub Source",
	author: "prompt text",
	repositoryPath: "in the prepare command of the Execution settings",
	worktreeRoot: "the ticket directory of the Execution settings",
	blockedCommands: "in the Execution settings"
};
/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
function machineOf(config) {
	const unknown = Object.keys(config).filter((key) => !(key in (Config.dict ?? {})));
	if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map((key) => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(", ")}; docs/006-deployment.md lists the keys`);
	const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config;
	return {
		stateDir,
		promptMaxChars,
		admissionContextMaxPages,
		admissionContextTimeoutMs
	};
}
const GithubAccountsSchema = z.object({
	repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, "owner/name").default(""),
	cli: z.string().trim().default("")
});
const GitlabAccountsSchema = z.object({
	project: z.string().trim().regex(/^([A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+)?$/, "group/project").default(""),
	cli: z.string().trim().default(""),
	host: z.string().trim().regex(/^[A-Za-z0-9.-]+(:[0-9]+)?$/, "hostname or hostname:port").default("gitlab.com")
});
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
const SETUP_FIELDS = {
	github: Object.keys(GithubAccountsSchema.shape),
	gitlab: Object.keys(GitlabAccountsSchema.shape)
};
/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
function executable(name, path, exclude) {
	if (name.includes("/") && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`);
	const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter((dir) => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map((dir) => join(dir, name));
	for (const candidate of candidates) try {
		if (statSync(candidate).isFile()) {
			accessSync(candidate, constants.X_OK);
			return candidate;
		}
	} catch {}
	throw new Error(`${name} is not an executable file${isAbsolute(name) ? "" : " on PATH"}`);
}
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
function workerProbe(subprocess, stateDir, cwd, signal) {
	const path = withoutDirectory(process.env.PATH ?? "", workerBin(stateDir));
	return (argv) => runAsWorker(subprocess, [
		"env",
		`PATH=${path}`,
		...argv
	], cwd, AbortSignal.any([signal, AbortSignal.timeout(6e4)]));
}
z.object({
	login: z.string().regex(/^[A-Za-z0-9-]+$/),
	id: z.number().int().positive()
});
z.object({
	name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	push: z.boolean().nullable()
});
function parsed(schema, text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	const result = schema.safeParse(value);
	return result.success ? result.data : void 0;
}
const GitlabUser = z.object({
	username: z.string().regex(/^[A-Za-z0-9_.-]+$/),
	id: z.number().int().positive(),
	commit_email: z.string().email().nullish(),
	web_url: z.string().url()
});
const GitlabProject = z.object({
	id: z.number().int().positive(),
	path_with_namespace: z.string().min(1),
	web_url: z.string().url(),
	default_branch: z.string().nullish(),
	permissions: z.object({
		project_access: z.object({ access_level: z.number().int() }).nullish(),
		group_access: z.object({ access_level: z.number().int() }).nullish()
	}).nullish()
});
const hostOf = (url) => {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return;
	}
};
/** Verify the agent's glab identity and push access to the configured GitLab project; the glab-agent wrapper pins host and token. */
async function resolveGitlabDeployment(machine, gitlab, probe, path = process.env.PATH ?? "") {
	const { stateDir } = machine;
	const accounts = GitlabAccountsSchema.parse(gitlab ?? {});
	const projectPath = accounts.project;
	if (!projectPath) throw new SetupError("projectUnset");
	if (!accounts.cli) throw new SetupError("gitlabCliUnset");
	let cli;
	try {
		cli = executable(accounts.cli, path, workerBin(stateDir));
	} catch (error) {
		throw new SetupError("gitlabCliMissing", { output: reason(error) });
	}
	const agent = parsed(GitlabUser, await probe([
		cli,
		"api",
		"user"
	]).catch((error) => {
		throw new SetupError("gitlabCliSignedOut", { output: reason(error) });
	}));
	if (!agent) throw new SetupError("gitlabCliNoAccount");
	const host = accounts.host.toLowerCase();
	const actual = hostOf(agent.web_url);
	if (actual !== host) throw new SetupError("projectHostMismatch", {
		host,
		actual: actual ?? agent.web_url
	});
	const project = parsed(GitlabProject, await probe([
		cli,
		"api",
		`projects/${encodeURIComponent(projectPath)}`
	]).catch((error) => {
		throw new SetupError("projectUnreadable", {
			account: agent.username,
			project: projectPath,
			output: reason(error)
		});
	}));
	if (!project) throw new SetupError("projectUnreported", { project: projectPath });
	if (hostOf(project.web_url) !== host) throw new SetupError("projectHostMismatch", {
		host,
		actual: hostOf(project.web_url) ?? project.web_url
	});
	if (!resolveAccess(project.permissions).write) throw new SetupError("projectReadOnly", {
		account: agent.username,
		project: project.path_with_namespace
	});
	const commitEmail = agent.commit_email || `${agent.id}-${agent.username}@users.noreply.${host.split(":")[0]}`;
	return {
		...machine,
		repository: project.path_with_namespace,
		github: {
			cli,
			login: agent.username,
			noreply: commitEmail
		},
		project: {
			id: project.id,
			path: project.path_with_namespace,
			webUrl: project.web_url,
			defaultBranch: project.default_branch || "main"
		},
		codeHost: {
			kind: "gitlab",
			host: accounts.host,
			apiBase: `https://${accounts.host}/api/v4`,
			webBase: `https://${accounts.host}`,
			cli,
			login: agent.username,
			userId: agent.id,
			commitEmail
		}
	};
}
// src/sources/host.ts
/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
const HEALTH_TEXT = {
	setupPending: "Waiting for the deployment check",
	sourceOff: "Off",
	pollFailures: "{count} consecutive failed polls; last: {error}"
};
function health(state, code, values = {}) {
	return {
		state,
		detail: fill(HEALTH_TEXT[code], values),
		code,
		...Object.keys(values).length ? { values } : {}
	};
}
const sourceContext = (host, kind) => host.context(kind);
export { agentVariables as $, pipelineFor as A, TodoSchema as B, ciCounts as C, settled as Ct, ciSummary as D, ciRecovered as E, waitsForPerson as Et, DiscussionSchema as F, gitlabThread as G, commentMarker as H, IssueSchema as I, mentions as J, gitlabThreadRef as K, MergeRequestSchema as L, readApprovals as M, readGitlab as N, gitlabThreadContext as O, readRepositoryPath as P, WORKER_COMMANDS as Q, NoteSchema as R, ticketBranch as S, runningAssignment as St, ciFailures as T, ticketOutcome as Tt, gitlabAddress as U, branchPipelineTrigger as V, gitlabPage as W, noteTrigger as X, mrTrigger as Y, pipelineTrigger as Z, mrOf as _, latestAssignment as _t, SETUP_FIELDS as a, workerBin as at, observeMr as b, reached as bt, workerProbe as c, Commands as ct, pause as d, sameName as dt, applyEnvironment as et, pollThreads as f, wordCount as ft, mrEndNotices as g, isoTime as gt, claimMr as h, followupOwners as ht, GitlabAccountsSchema as i, withoutDirectory as it, pipelineSnapshot as j, mrPipeline as k, POLL_HORIZON_MS as l, SetupError as lt, agentMr as m, key as mt, sourceContext as n, verifyDirectory as nt, machineOf as o, writeEnvironment as ot, KV as p, LIMITS as pt, issueTrigger as q, Config as r, verifyEnvironment as rt, resolveGitlabDeployment as s, CliError as st, health as t, runAsWorker as tt, cursorAt as u, checkedImText as ut, mrsOf as v, latestReport as vt, ciFact as w, threadKey as wt, readMr as x, readUntil as xt, observeApprovals as y, liveTicket as yt, SOURCE as z };
