/** GitLab Source kind definition, TODO and observed-stream polling, merge request CI, thread polling, and Cordis plugin entry. */
import { key } from '../core/index.ts'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GitlabAccountsSchema, type Deployment } from '../deployment.ts'
import { CliError, type Commands, type Tally } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { Thread } from '../core/index.ts'
import { KV } from '../kv.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { agentMr, mrsOf, observeApprovals, observeMr, readMr, ticketBranch, type MergeRequest } from './gitlab-mr.ts'
import { ciCounts, ciFact, ciFailures, ciRecovered, readApprovals, mrPipeline, ciSummary, gitlabThreadContext, pipelineFor, pipelineSnapshot } from './gitlab-read.ts'
import { branchPipelineTrigger, DiscussionSchema, type GitlabIssue, type GitlabMergeRequest, type GitlabTodo, mentions, gitlabThread, gitlabThreadRef, issueTrigger,
  IssueSchema, mrTrigger, MergeRequestSchema, noteTrigger, NoteSchema, pipelineTrigger, SOURCE, TodoSchema } from './gitlab-trigger.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind, VariableSpec } from './kind.ts'
import type { Retry } from './retry.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'

/** Minimal GitLab configuration: the project, its agent CLI and host, and the scopes this Source observes. */
export const GitlabConfigSchema = GitlabAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observeMergeRequests: z.boolean().default(false),
  observeNotes: z.boolean().default(false),
  observeCi: z.boolean().default(false),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', mergeRequests: 'observeMergeRequests', notes: 'observeNotes', ci: 'observeCi' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'mr') return 'mergeRequests'
  return meta.kind === 'note' || meta.kind === 'conversation' || meta.kind === 'inline' ? 'notes' : undefined
}
const text = (en: string, zh: string): Localized => ({ en, zh })
const variables: readonly VariableSpec[] = [
  { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: text('The GitLab project this Source watches, as path_with_namespace.',
    '这个来源监听的 GitLab 项目，写作 path_with_namespace。') },
  { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: text('The agent\'s GitLab account; glab acts as it.',
    '智能体的 GitLab 账号；glab 以它行事。') },
  { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: text('Commit email of the agent account.',
    '智能体账号的提交邮箱。') },
  { key: 'DSH_SUPERAGENT_GITLAB_IID', description: text('IID of the Issue or merge request that started the ticket; empty otherwise.',
    '接下工单的 Issue 或 merge request 的 IID；不是从 GitLab 来的时为空。') },
  { key: 'DSH_SUPERAGENT_GITLAB_MR_SOURCE_BRANCH', description: text('Source branch of the merge request that started the ticket; empty otherwise.',
    '接下工单的 merge request 的源分支；不是 MR 时为空。') },
]
const value = (deployment: Deployment, key: 'project' | 'commitEmail' | 'account'): string => key === 'project'
  ? deployment.project?.path ?? deployment.repository
  : key === 'commitEmail' ? deployment.codeHost?.commitEmail ?? deployment.github.noreply : deployment.codeHost?.login ?? deployment.github.login

export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: text('GitLab', 'GitLab'),
  description: text('The agent\'s GitLab account; receives TODOs, observed Issues and merge requests, discussion, CI changes, and merges.',
    '智能体的 GitLab 账号；接收 TODO、观察到的 Issue 与 merge request、讨论、CI 变化和合并。'),
  schema: GitlabConfigSchema,
  fields: [
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(?:/[A-Za-z0-9_.\\-]+)+',
      label: text('Project', '项目'), hint: text('Written group/project (path_with_namespace).', '写作 group/project（path_with_namespace）。') },
    { key: 'cli', type: 'text', label: text('Agent glab CLI', '智能体的 glab CLI'),
      hint: text('A command name or absolute path of the glab-agent wrapper.', 'glab-agent 包装脚本的命令名或绝对路径。') },
    { key: 'host', type: 'text', pattern: '[A-Za-z0-9.\\-]+(?::[0-9]+)?', label: text('GitLab host', 'GitLab 主机'),
      hint: text('For example gitlab.example.com.', '例如 gitlab.example.com。') },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: text('Polling interval / seconds', '轮询间隔 / 秒') },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: text('Failed polls before reporting an error', '连续失败几次后报告异常') },
    { key: 'observeIssues', type: 'switch', label: text('Receive new Issues in the project', '接收项目里的新 Issue') },
    { key: 'observeMergeRequests', type: 'switch', label: text('Receive new merge requests', '接收新的 merge request') },
    { key: 'observeNotes', type: 'switch', label: text('Receive comments in the project', '接收项目里的评论') },
    { key: 'observeCi', type: 'switch', label: text('Receive the default branch\'s CI', '接收默认分支的 CI') },
  ],
  // What the Source observes across the project; elsewhere, only what addresses the agent arrives as a TODO.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  // `#12` names the Issue, `!12` the MR; a bare IID names both. Canonical keys and page URLs name one thread.
  find: query => {
    const text = query.trim()
    const thread = gitlabThreadRef(text)
    if (thread) return { threads: [gitlabThread(thread.iid, thread.mr)], terms: [] }
    const url = /\/-\/(issues|work_items|merge_requests)\/(\d+)/.exec(text)
    const mark = /^([#!]?)(\d+)$/.exec(text)
    const iid = Number(url?.[2] ?? mark?.[2])
    if (!iid) return { threads: [], terms: [] }
    const kind = url?.[1]?.toLowerCase() ?? (mark?.[1] === '!' ? 'merge_requests' : mark?.[1] === '#' ? 'issues' : '')
    return { threads: kind === 'merge_requests' ? [gitlabThread(iid, true)] : kind === 'issues' || kind === 'work_items'
      ? [gitlabThread(iid, false)] : [gitlabThread(iid, false), gitlabThread(iid, true)], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的 GitLab 机器人或 project access token 用户的评论在来源收到时成为推断的候选，交给评估。它们不能发起明确的请求，也不能停止工单。', en: 'A comment of a bot account on this list, such as a project access-token user, becomes an inferred candidate for an assessment when the Source receives it. Such a comment never makes an explicit request or stops a ticket.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a comment.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: Localized) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('mergeRequests', { zh: '新 merge request', en: 'New merge requests' }),
        row('notes', { zh: '评论', en: 'Comments' }),
        // CI has no sender, so only the cell of a sender off the list who does not address the agent applies.
        { id: 'ci', label: { zh: '默认分支的 CI', en: 'Default branch CI' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    },
  },
  environment: {
    variables,
    values: ({ deployment, trigger }) => {
      const thread = trigger?.threads[0]
      const iid = thread?.source === SOURCE ? Number(trigger?.meta.iid) || 0 : 0
      const branch = trigger?.meta.mrSourceBranch
      return { DSH_SUPERAGENT_GITLAB_PROJECT: value(deployment, 'project'), DSH_SUPERAGENT_GITLAB_ACCOUNT: value(deployment, 'account'),
        DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: value(deployment, 'commitEmail'), DSH_SUPERAGENT_GITLAB_IID: iid ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_MR_SOURCE_BRANCH: typeof branch === 'string' ? branch : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.codeHost ? {
    cli: { zh: `当前账号 @${deployment.codeHost.login}`, en: `Current account @${deployment.codeHost.login}` },
  } : {},
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
/** Register the Source kind and run its polling loop until the plugin unloads. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
/** A `429` backoff asked for by `Retry-After`, in seconds; P0 found GitLab may omit the header, hence the five-minute default. */
export function retryAfter(error: unknown): number | undefined {
  if (!(error instanceof CliError) || error.code !== 429) return undefined
  const header = /^retry-after:\s*(.+)$/im.exec(error.message)?.[1]?.trim()
  if (header && /^\d+$/.test(header)) return Number(header)
  const date = header ? Date.parse(header) : NaN
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : 300
}
function rememberBackoff(round: Round, error: unknown): void {
  const delay = retryAfter(error)
  if (delay !== undefined) round.backoff = Math.max(round.backoff ?? 0, delay)
}
/** The polling loop: resolves setup once, then polls every `pollSeconds` and reports failures as source health. */
export async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the project; until then nothing is polled.
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  if (!ctx.deployment.project) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config?.project) interval = await pollRound(ctx, signal)
      else ctx.report(SOURCE, health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report(SOURCE, failed)
      interval = retryAfter(error) ?? interval
    }
    await pause(Math.max(interval, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round {
  started: string
  signal?: AbortSignal | undefined
  mrs: Map<number, Promise<MergeRequest>>
  /** Thread keys already read in this round, so TODO, stream and Thread reads share one read. */
  read: Set<string>
  failures: string[]
  dropped: number[]
  abandoned: number[]
  tally: Tally
  backoff?: number
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, mrs: new Map(), read: new Set(),
  failures: [], dropped: [], abandoned: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
const RETRY_WINDOW_MS = 24 * 3600_000
/** True when GitLab no longer has the target (404/410); such a read is dropped rather than retried forever. */
const deleted = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
const threadOf = gitlabThread
const branchThread = (branch: string): string => `${SOURCE}:ci:${branch}`
/** Records a failed target read on its Thread and in the round, for the failure threshold. */
function failed(ctx: SourceContext, round: Round, iid: number, mr: boolean, error: unknown): void {
  round.failures.push(`${mr ? '!' : '#'}${iid}: ${String(error)}`)
  rememberBackoff(round, error)
  ctx.threads.patch(threadOf(iid, mr), { pollError: String(error) })
}
/** Names a Thread and publishes its number or MR mark; a Thread that does not exist yet is left for its first Trigger to create. */
function nameThread(ctx: SourceContext, iid: number, title: string, mr: boolean): void {
  const mark = `${mr ? '!' : '#'}${iid}`
  ctx.threads.patch(threadOf(iid, mr), { iid, mr, title })
  ctx.threads.describe(threadOf(iid, mr), { label: `${mark} ${title}`, facts: { [mr ? 'mr' : 'number']: { value: mark } } })
}
/** Marks a TODO done; failing to do so is harmless because its target's cursor already moved. */
async function markDone(commands: Commands, id: number): Promise<void> {
  // The endpoint answers 204 with no body, so read it as raw output instead of parsing JSON.
  await commands.gitlabUserApi(`todos/${id}/mark_as_done`, '--method', 'POST')
}
/**
 * One polling round: TODOs, then observed streams, then the open tickets' merge requests and pipelines, then subscribed
 * Threads. Each step and each Issue/MR/Thread fails independently so all steps run before the round fails.
 * @returns the polling interval in seconds.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  if (stopped(ctx, round)) return 60
  const todos = await pollTodos(ctx, round).then(value => ({ value }), (error: unknown) => ({ error }))
  await pollObserved(ctx, round)
  await pollTicketMrs(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  if (stopped(ctx, round)) return 60
  if ('error' in todos) { rememberBackoff(round, todos.error); round.failures.push(`TODOs: ${String(todos.error)}`) }
  const count = 'value' in todos ? todos.value.count : 0
  if (round.failures.length) {
    const message = `${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`
    if (round.backoff !== undefined) throw new CliError(`${message}\nRetry-After: ${round.backoff}`, 429)
    throw new Error(message)
  }
  const named = (iids: number[]) => [...new Set(iids)].sort((a, b) => a - b).map(iid => `#${iid}`).join(', ')
  const dropped = (round.dropped.length ? `; deleted on GitLab: ${named(round.dropped)}` : '')
    + (round.abandoned.length ? `; dropped after their reads kept failing: ${named(round.abandoned)}` : '')
    + (round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : '')
  ctx.report(SOURCE, { state: 'ready', detail: `${count} TODOs; next poll ≥ 60s${dropped}`, at: round.started })
  return 60
}
/**
 * Reads pending TODOs of the agent for the project and each target's new notes, advancing the TODO cursor and failed-read
 * retries atomically; self-assignment creates no TODO, so observed streams cover events TODOs miss.
 */
async function pollTodos(ctx: SourceContext, round: Round): Promise<{ count: number }> {
  const commands = ctx.commands.withSignal(round.signal)
  const project = ctx.deployment.project?.id
  if (project === undefined) throw new Error('The GitLab deployment has no project')
  const stored = ctx.state.get(KV.gitlab.todos)
  if (stored === undefined) ctx.state.set(KV.gitlab.todos, round.started)
  const todos = await commands.gitlabUserPages(TodoSchema, `todos?project_id=${project}&state=pending&per_page=100`, round.tally)
  if (stopped(ctx, round)) return { count: todos.length }
  const retries: Record<string, Retry & { todos?: GitlabTodo[] }> = { ...ctx.state.get(KV.gitlab.retries) }
  const targets = new Map<string, { item: Retry & { todos?: GitlabTodo[] }; todos: GitlabTodo[] }>()
  for (const [id, item] of Object.entries(retries)) targets.set(id, { item, todos: item.todos ?? [] })
  for (const todo of [...todos].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const mr = todo.target_type === 'MergeRequest'
    const iid = todo.target?.iid
    if ((todo.target_type !== 'Issue' && !mr) || !iid) { void markDone(commands, todo.id).catch(() => {}); continue }
    const id = `${mr ? 'mr' : 'issue'}:${iid}`
    const existing = targets.get(id)
    if (existing) { if (!existing.todos.some(item => item.id === todo.id)) existing.todos.push(todo); continue }
    const cursor = ctx.state.get(KV.gitlab.cursor(mr ? 'mr' : 'issue', iid))
    // A TODO for a mention in an Issue body is created a moment after the body itself, so look one minute back.
    const base = new Date(Date.parse(todo.created_at) - 60_000).toISOString()
    const since = cursor && Date.parse(cursor) > Date.parse(base) ? cursor : base
    targets.set(id, { item: { since, pr: mr }, todos: [todo] })
  }
  for (const [id, target] of targets) {
    if (stopped(ctx, round)) return { count: todos.length }
    const iid = Number(id.split(':')[1])
    const key = threadOf(iid, target.item.pr === true)
    round.read.add(key)
    try {
      await readTarget(ctx, round, iid, target.item.pr === true, target.item.since, target.todos)
      for (const todo of target.todos) await markDone(commands, todo.id).catch(() => {})
      delete retries[id]
    } catch (error) {
      if (stopped(ctx, round)) return { count: todos.length }
      rememberBackoff(round, error)
      const retry = { ...target.item, todos: target.todos, failedAt: target.item.failedAt ?? round.started, attempts: (target.item.attempts ?? 0) + 1 }
      const abandoned = Date.parse(round.started) - Date.parse(retry.failedAt) >= RETRY_WINDOW_MS
      if (deleted(error)) {
        round.dropped.push(iid)
        delete retries[id]
        for (const todo of target.todos) await markDone(commands, todo.id).catch(() => {})
      } else if (abandoned) {
        round.abandoned.push(iid)
        delete retries[id]
        round.failures.push(`${id}: ${String(error)}`)
        ctx.threads.patch(key, { pollError: String(error) })
      } else {
        retries[id] = retry
        round.failures.push(`${id}: ${String(error)}`)
        ctx.threads.patch(key, { pollError: String(error) })
      }
    }
  }
  ctx.atomic(() => { ctx.state.set(KV.gitlab.todos, cursorAt(round.started)); ctx.state.set(KV.gitlab.retries, retries) })
  return { count: todos.length }
}
/** Reads an Issue or MR body and its notes since `since`, then advances its cursor; a stop mid-read throws so the cursor stays. */
async function readTarget(ctx: SourceContext, round: Round, iid: number, mr: boolean, since: string, todos: GitlabTodo[] = []): Promise<void> {
  if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
  const commands = ctx.commands.withSignal(round.signal)
  if (mr) {
    const entity = await mrRead(ctx, round, iid)
    await receiveBody(ctx, round, entity, true, since, todos)
    await intakeNotes(ctx, round, { iid, mr, url: entity.web_url, projectId: ctx.deployment.project?.id }, since)
    nameThread(ctx, iid, entity.title, true)
  } else {
    const entity = await commands.gitlabApi(IssueSchema, `issues/${iid}`)
    await receiveBody(ctx, round, entity, false, since, todos)
    await intakeNotes(ctx, round, { iid, mr, url: entity.web_url, projectId: ctx.deployment.project?.id }, since)
    nameThread(ctx, iid, entity.title, false)
  }
  if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
  ctx.state.set(KV.gitlab.cursor(mr ? 'mr' : 'issue', iid), cursorAt(round.started))
  ctx.threads.patch(threadOf(iid, mr), { pollError: undefined })
}

/** Body-mention TODOs identify the editor and event, independently of the entity's original author/creation time. */
async function receiveBody(ctx: SourceContext, round: Round, entity: GitlabIssue | GitlabMergeRequest, mr: boolean,
  since: string, todos: GitlabTodo[]): Promise<void> {
  if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
  const login = ctx.deployment.codeHost?.login ?? ''
  const bodyTodos = todos.filter(todo => ['mentioned', 'directly_addressed'].includes(todo.action_name)
    && todo.target_url && !/#note_\d+/i.test(todo.target_url) && mentions(todo.body ?? '', login))
  if (!bodyTodos.length) {
    if (Date.parse(entity.created_at) >= Date.parse(since) && !sameName(entity.author.username, login)) {
      await ctx.receive(mr ? mrTrigger(entity as GitlabMergeRequest, login) : issueTrigger(entity as GitlabIssue, login))
    }
    return
  }
  for (const todo of bodyTodos) {
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    // Use the TODO body snapshot: a later edit must not be attributed to the earlier mentioning user.
    const edited = { ...entity, author: todo.author, description: todo.body }
    const trigger = mr ? mrTrigger(edited as GitlabMergeRequest, login) : issueTrigger(edited as GitlabIssue, login)
    const previous = ctx.triggers.get(trigger.id)
    if (previous?.meta.todoId === todo.id) continue
    const initial = (!previous || previous.text === trigger.text) && sameName(entity.author.username, todo.author.username)
      && Math.abs(Date.parse(todo.created_at) - Date.parse(entity.created_at)) <= 60_000
    if (!initial) trigger.id = key('gitlab-body-mention', String(todo.id))
    trigger.at = todo.created_at
    trigger.meta = { ...trigger.meta, ...mr ? { mrAuthor: entity.author.username } : {}, todoId: todo.id }
    if (!ctx.triggers.get(trigger.id) && !sameName(todo.author.username, login)) await ctx.receive(trigger)
  }
}

/** Reads and observes an MR at most once per polling round. */
function mrRead(ctx: SourceContext, round: Round, iid: number): Promise<MergeRequest> {
  let read = round.mrs.get(iid)
  if (!read) {
    read = readMr(ctx, iid, round.signal).then(async mr => {
      if (stopped(ctx, round)) return mr
      await observeMr(ctx, mr)
      if (!stopped(ctx, round) && mr.state === 'opened') {
        try {
          const approvals = await readApprovals(ctx.commands.withSignal(round.signal), iid)
          if (!stopped(ctx, round)) observeApprovals(ctx, iid, approvals)
        } catch (error) {
          if (!stopped(ctx, round)) {
            observeApprovals(ctx, iid, { available: false, status: 0 })
            rememberBackoff(round, error)
            round.failures.push(`!${iid} approvals: ${String(error)}`)
          }
        }
      }
      return mr
    })
    round.mrs.set(iid, read)
  }
  return read
}
/** Takes new notes of an Issue, or of every discussion of an MR, since `since`, with the discussion id a reply needs. */
async function intakeNotes(ctx: SourceContext, round: Round, ref: { iid: number; mr: boolean; url?: string; projectId?: number }, since: string): Promise<void> {
  if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
  const commands = ctx.commands.withSignal(round.signal)
  const login = ctx.deployment.codeHost?.login ?? ''
  const fresh = (note: { created_at: string; updated_at?: string | null }) =>
    Date.parse(note.updated_at ?? note.created_at) >= Date.parse(since)
  const receive = async (note: Parameters<typeof noteTrigger>[0], discussionId?: string): Promise<void> => {
    if (!fresh(note) || note.system || sameName(note.author.username, login)) return
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    const trigger = noteTrigger(note, { ...ref, discussionId: note.discussion_id ?? discussionId }, login)
    if (trigger?.text) await ctx.receive(trigger)
  }
  if (ref.mr) {
    const discussions = await commands.gitlabPages(DiscussionSchema, `merge_requests/${ref.iid}/discussions?per_page=100`, round.tally)
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    for (const discussion of discussions) for (const note of discussion.notes) await receive(note, discussion.id)
    return
  }
  const notes = await commands.gitlabPages(NoteSchema, `issues/${ref.iid}/notes?per_page=100&sort=asc&order_by=created_at`, round.tally)
  if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
  for (const note of notes) await receive(note)
}
/** Repository-wide streams: Issues and MRs updated since the stream cursor, which also carry their new notes. */
const STREAMS = [
  { id: 'issues', observed: (config: GitlabConfig) => config.observeIssues || config.observeNotes, path: 'issues?state=all' },
  { id: 'mergeRequests', observed: (config: GitlabConfig) => config.observeMergeRequests || config.observeNotes, path: 'merge_requests?state=all' },
] as const
/** Polls the observed streams and the default branch's pipeline; each fails independently and keeps its cursor on failure. */
async function pollObserved(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return
  for (const stream of STREAMS) {
    if (stopped(ctx, round)) return
    if (!stream.observed(config)) { ctx.state.set(KV.gitlab.stream(stream.id), undefined); continue }
    try { await readStream(ctx, round, stream.id, stream.path, config) }
    catch (error) { if (!stopped(ctx, round)) { rememberBackoff(round, error); round.failures.push(`${stream.id}: ${String(error)}`) } }
  }
  if (!config.observeCi) {
    const seen = ctx.state.get(KV.gitlab.branchPipeline)
    ctx.state.set(KV.gitlab.branchPipeline, seen && { branch: seen.branch, revision: seen.revision })
    return
  }
  try { await pollBranchPipeline(ctx, round) }
  catch (error) { if (!stopped(ctx, round)) { rememberBackoff(round, error); round.failures.push(`default branch CI: ${String(error)}`) } }
}
/** Polls one repository-wide stream (oldest first) since its cursor and steps the cursor five seconds back from the round's start. */
async function readStream(ctx: SourceContext, round: Round, id: string, path: string, config: GitlabConfig): Promise<void> {
  const name = KV.gitlab.stream(id)
  const stored = ctx.state.get(name)
  const started = stored?.started ?? round.started
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const since = new Date(Math.max(Date.parse(stored?.since ?? started), horizon)).toISOString()
  const listed = `${path}&updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=asc&per_page=100`
  const mr = id === 'mergeRequests'
  const entities = mr ? await ctx.commands.withSignal(round.signal).gitlabPages(MergeRequestSchema, listed, round.tally)
    : await ctx.commands.withSignal(round.signal).gitlabPages(IssueSchema, listed, round.tally)
  const login = ctx.deployment.codeHost?.login ?? ''
  let incomplete = false
  for (const entity of entities) {
    try {
      // Stopping mid-stream aborts before advancing the cursor so unread items are retried.
      if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
      if (round.read.has(threadOf(entity.iid, mr))) continue
      if (mr) await mrRead(ctx, round, entity.iid)
      if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
      const bodyObserved = mr ? config.observeMergeRequests : config.observeIssues
      if (bodyObserved && Date.parse(entity.created_at) >= Date.parse(since) && !sameName(entity.author.username, login)) {
        await ctx.receive(mr ? mrTrigger(entity as GitlabMergeRequest, login) : issueTrigger(entity as GitlabIssue, login))
      }
      // Subscribed threads use their own checkpoint, which can predate this stream's cursor.
      // Leave them to pollThreads even when only Issue/MR bodies are observed.
      const subscribed = ctx.threads.get(threadOf(entity.iid, mr))?.subscriptions.length
      if (config.observeNotes && !subscribed) {
        await intakeNotes(ctx, round, { iid: entity.iid, mr, url: entity.web_url, projectId: ctx.deployment.project?.id }, since)
        ctx.state.set(KV.gitlab.cursor(mr ? 'mr' : 'issue', entity.iid), cursorAt(round.started))
        round.read.add(threadOf(entity.iid, mr))
      }
      nameThread(ctx, entity.iid, entity.title, mr)
    } catch (error) {
      if (stopped(ctx, round)) throw error
      incomplete = true
      failed(ctx, round, entity.iid, mr, error)
    }
  }
  if (incomplete || stopped(ctx, round)) throw new Error(`${id} stream did not finish; checkpoint retained`)
  ctx.state.set(name, { since: cursorAt(round.started), started })
}
/** Polls the default branch's newest pipeline, emitting a Trigger only when the set of failing jobs changes after the baseline. */
async function pollBranchPipeline(ctx: SourceContext, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const branch = ctx.deployment.project?.defaultBranch ?? 'main'
  const pipeline = await pipelineFor(commands, { ref: branch }, round.tally)
  const previous = ctx.state.get(KV.gitlab.branchPipeline)
  if (!pipeline || stopped(ctx, round)) return
  const snapshot = await pipelineSnapshot(commands, pipeline, round.tally)
  if (stopped(ctx, round)) return
  // The first observation after switching on or renaming the default branch establishes the baseline.
  const known = previous?.branch === branch ? previous.failures : undefined
  const failures = ciFailures(snapshot)
  const counts = ciCounts(snapshot)
  // Retain previous failures while jobs are still running so recovery is reported only once the pipeline is done.
  const now = failures.length || ciRecovered(snapshot) ? failures : known ?? []
  let revision = previous?.revision ?? 0
  if (known && JSON.stringify(now) !== JSON.stringify(known)) {
    revision += 1
    const project = ctx.deployment.project!
    const summary = ciSummary(snapshot, branch, `gitlab/pipelines/${pipeline.id}/jobs`)
    const url = pipeline.web_url || `${project.webUrl}/-/pipelines/${pipeline.id}`
    await ctx.receive(branchPipelineTrigger(branch, pipeline.sha ?? '', revision, summary, url))
  }
  ctx.threads.describe(branchThread(branch), { label: `CI on ${branch}`, facts: { ci: ciFact(counts) } })
  ctx.state.set(KV.gitlab.branchPipeline, { branch, failures: now, revision, ...pipeline.sha ? { sha: pipeline.sha } : {} })
}
/** Polls the merge requests of open tickets, observing their lifecycle and CI; each MR is read once per round. */
export async function pollTicketMrs(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  // Agent-created MRs need not produce TODOs and discovery must work with observation off.
  const unbound = ctx.tickets.open().filter(ticket => ticket.execution?.name && !mrsOf(ticket, true).length)
  if (unbound.length && !stopped(ctx, round)) {
    try {
      const login = ctx.deployment.codeHost!.login
      const listed = await ctx.commands.withSignal(signal).gitlabPages(MergeRequestSchema,
        `merge_requests?state=opened&author_username=${encodeURIComponent(login)}&per_page=100`, round.tally)
      for (const mr of listed) {
        if (stopped(ctx, round)) return
        if (agentMr(mr, ctx.deployment) && unbound.some(ticket => ticketBranch(ticket, mr.source_branch))) {
          try { await mrRead(ctx, round, mr.iid) }
          catch (error) { if (!stopped(ctx, round)) failed(ctx, round, mr.iid, true, error) }
        }
      }
    } catch (error) { if (!stopped(ctx, round)) { rememberBackoff(round, error); round.failures.push(`MR discovery: ${String(error)}`) } }
  }
  const iids = [...new Set(ctx.tickets.open().flatMap(ticket => mrsOf(ticket, true)))]
  for (const iid of iids) {
    if (stopped(ctx, round)) return
    try {
      const mr = await mrRead(ctx, round, iid)
      if (mr.state === 'opened') await pollMrPipeline(ctx, round, iid, mr)
    } catch (error) { if (!stopped(ctx, round)) failed(ctx, round, iid, true, error) }
  }
}
/** Polls one open MR's pipeline; only changes after the first baseline observation become Triggers. */
async function pollMrPipeline(ctx: SourceContext, round: Round, iid: number, mr: MergeRequest): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const pipeline = await mrPipeline(commands, mr, round.tally)
  if (!pipeline || stopped(ctx, round)) return
  const snapshot = await pipelineSnapshot(commands, pipeline, round.tally)
  if (stopped(ctx, round)) return
  const previous = ctx.state.get(KV.gitlab.pipeline(iid))
  // Older builds stored the entire snapshot. Treat that value as a fresh baseline.
  let stored: unknown
  try { stored = previous && JSON.parse(previous.fingerprint) } catch { /* A corrupt/legacy value establishes a new baseline. */ }
  const known = z.array(z.string()).safeParse(stored)
  const failures = ciFailures(snapshot)
  const counts = ciCounts(snapshot)
  const now = failures.length || ciRecovered(snapshot) ? failures : known.success ? known.data : []
  const fingerprint = JSON.stringify(now)
  const revision = previous ? previous.revision : 0
  if (previous?.fingerprint !== fingerprint) {
    if (previous && known.success) await ctx.receive(pipelineTrigger(mr, previous.revision + 1, ciSummary(snapshot, `MR !${iid}`, `gitlab/merge_requests/${iid}/pipelines`)))
    ctx.state.set(KV.gitlab.pipeline(iid), { fingerprint, revision: previous ? revision + 1 : 0 })
  }
  ctx.threads.describe(threadOf(iid, true), { facts: { ci: ciFact(ciCounts(snapshot)) } })
}
/** Polls subscribed Issue and MR Threads not already read in this round; a deleted target does not fail the round. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      rememberBackoff(round, error)
      if (deleted(error)) round.dropped.push(Number(thread.ref.id)); else round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(thread.key))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  // The default branch's CI Thread has no Issue or MR to read; its CI arrives as Triggers.
  if (thread.ref.id.startsWith('ci:')) return
  const parsed = gitlabThreadRef(thread.ref.id)
  if (!parsed) throw new Error('Subscribed thread is not a GitLab Issue or merge request')
  const iid = parsed.iid
  round.read.add(thread.key)
  const commands = ctx.commands.withSignal(round.signal)
  let mr = parsed.mr
  let title = typeof thread.meta.title === 'string' ? thread.meta.title : undefined
  let url = typeof thread.meta.url === 'string' ? thread.meta.url : undefined
  if (!title || !url) {
    if (mr) {
      const found = await commands.gitlabApi(MergeRequestSchema, `merge_requests/${iid}`)
      title = found.title; url = found.web_url
    } else {
      const found = await commands.gitlabApi(IssueSchema, `issues/${iid}`)
      title = found.title; url = found.web_url
    }
    ctx.threads.patch(thread.key, { iid, mr, ...(url ? { url } : {}) })
    if (title) nameThread(ctx, iid, title, mr)
    thread = ctx.threads.get(thread.key) ?? thread
  }
  const checkpoint = KV.gitlab.cursor(mr ? 'mr' : 'issue', iid)
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  await intakeNotes(ctx, round, { iid, mr, ...(url ? { url } : {}), projectId: ctx.deployment.project?.id }, since)
  ctx.state.set(checkpoint, cursorAt(round.started))
  if (title) nameThread(ctx, iid, title, mr)
}
