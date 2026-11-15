/** Read-only GitLab repository, Issue/MR conversation, discussion, and pipeline inspection for assessments and workers. */
import { z } from 'zod'
import type { ThreadFact } from '../core/index.ts'
import { CliError, validItems, type Commands, type Tally } from '../infra/commands.ts'
import { ApprovalsSchema, autoMergeEnabled, DiscussionSchema, isHumanUser, JobSchema, MergeRequestSchema, notePlace, NoteSchema, PipelineSchema, IssueSchema,
  type GitlabDiscussion, type GitlabJob, type GitlabMergeRequest, type GitlabNote, type GitlabPipeline } from './gitlab-trigger.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'

/** A pipeline and its jobs, the GitLab model of CI facts; check-runs and commit statuses do not exist here. */
export interface CiSnapshot { pipeline: { id: number; status: string; ref?: string; sha?: string }; jobs: GitlabJob[] }
/** Job statuses that count as failures; a failed pipeline with no failed job is reported by its status. */
const FAILING = new Set(['failed', 'canceled'])
/** Finished job statuses; a required manual job still waits for a person. */
const FINISHED = new Set(['success', 'skipped', 'manual', 'failed', 'canceled'])
const failedJob = (job: GitlabJob) => !job.allow_failure && FAILING.has(job.status)
const runningJob = (job: GitlabJob) => !FINISHED.has(job.status) || (job.status === 'manual' && job.allow_failure === false)
const jobName = (job: GitlabJob) => job.stage ? `${job.stage}/${job.name}` : job.name
export function ciCounts(snapshot: CiSnapshot): { failed: number; running: number } {
  const failedJobs = snapshot.jobs.filter(failedJob).length
  const runningJobs = snapshot.jobs.filter(runningJob).length
  const pipelineFailed = FAILING.has(snapshot.pipeline.status)
  const pipelineRunning = !['success', 'failed', 'canceled'].includes(snapshot.pipeline.status)
  return { failed: failedJobs + (pipelineFailed && !failedJobs ? 1 : 0),
    running: runningJobs + (pipelineRunning && !runningJobs ? 1 : 0) }
}
export function ciFailures(snapshot: CiSnapshot): string[] {
  const failed = snapshot.jobs.filter(failedJob).map(jobName)
  if (!failed.length && FAILING.has(snapshot.pipeline.status)) failed.push(`pipeline:${snapshot.pipeline.status}`)
  return [...new Set(failed)].sort()
}
export function ciSummary(snapshot: CiSnapshot, where: string, read: string): string {
  const counts = ciCounts(snapshot)
  const failed = snapshot.jobs.filter(failedJob).map(jobName)
  const running = snapshot.jobs.filter(runningJob).map(job => job.name)
  const names = (list: string[]) => list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
  const at = `on ${where} at ${(snapshot.pipeline.sha ?? '').slice(0, 7) || `pipeline ${snapshot.pipeline.id}`}`
  const still = running.length ? `; ${running.length} still running` : ''
  const total = snapshot.jobs.length || 1
  const line = counts.failed ? `CI failed ${counts.failed}/${total} ${at}: ${names(failed.length ? failed : [`pipeline:${snapshot.pipeline.status}`])}${still}`
    : counts.running ? `CI running ${counts.running}/${total} ${at}: ${names(running.length ? running : [`pipeline:${snapshot.pipeline.status}`])}`
      : `CI passed ${total}/${total} ${at}`
  return `${line}\nRead ${read} for every job.`
}
export function ciFact(counts: { failed: number; running: number }): ThreadFact {
  if (counts.failed) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(counts.failed), problem: true }
  if (counts.running) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(counts.running) }
  return { label: 'CI', value: { zh: '通过', en: 'passed' } }
}

export const ciRecovered = (snapshot: CiSnapshot): boolean => snapshot.pipeline.status === 'success' && !ciCounts(snapshot).running

/** Reads current jobs of a pipeline (GitLab excludes retried attempts by default); allowed failures remain in raw data. */
export async function readPipelineJobs(commands: Commands, pipelineId: number, tally?: Tally): Promise<GitlabJob[]> {
  return commands.gitlabPages(JobSchema, `pipelines/${pipelineId}/jobs?per_page=100`, tally)
}
/** Builds a CI snapshot from a pipeline and its jobs. */
export async function pipelineSnapshot(commands: Commands, pipeline: GitlabPipeline, tally?: Tally): Promise<CiSnapshot> {
  const skipped = { skipped: 0 }
  const jobs = await readPipelineJobs(commands, pipeline.id, skipped)
  if (tally) tally.skipped += skipped.skipped
  if (skipped.skipped) throw new Error('Incomplete pipeline jobs; CI checkpoint retained')
  return { pipeline: { id: pipeline.id, status: pipeline.status, ...pipeline.ref ? { ref: pipeline.ref } : {},
    ...pipeline.sha ? { sha: pipeline.sha } : {} }, jobs: jobs.sort((a, b) => a.name.localeCompare(b.name)) }
}
/** Reads the newest pipeline for a commit or ref, or undefined when none ran. */
export async function pipelineFor(commands: Commands, selector: { sha?: string; ref?: string }, tally?: Tally): Promise<GitlabPipeline | undefined> {
  const query = selector.sha ? `sha=${encodeURIComponent(selector.sha)}` : `ref=${encodeURIComponent(selector.ref ?? '')}`
  const pipelines = await commands.gitlabPages(PipelineSchema, `pipelines?${query}&per_page=20&order_by=id&sort=desc`, tally)
  return pipelines.sort((a, b) => b.id - a.id)[0]
}



/** Selects the current MR pipeline; an old head pipeline cannot validate a newer commit. */
export async function mrPipeline(commands: Commands, mr: GitlabMergeRequest, tally?: Tally): Promise<GitlabPipeline | undefined> {
  const head = mr.head_pipeline
  return (head && (!mr.sha || !head.sha || head.sha === mr.sha) ? head : undefined)
    ?? pipelineFor(commands, { sha: mr.sha ?? undefined, ref: mr.source_branch }, tally)
}

/** Optional approval capability: forbidden/unavailable is unknown, never 'not approved'. Other failures stay retryable. */
export async function readApprovals(commands: Commands, iid: number) {
  try {
    const value = await commands.gitlabApi(ApprovalsSchema, `merge_requests/${iid}/approvals`)
    return { available: true as const, approved: value.approved ?? null,
      approved_by: [...new Set(value.approved_by.map(item => item.user.username))].sort() }
  } catch (error) {
    if (error instanceof CliError && (error.code === 403 || error.code === 404)) return { available: false as const, status: error.code }
    throw error
  }
}

/** Reads a non-hidden file or directory listing from the project's default branch; paths that leave the project are rejected. */
export async function readRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  if (/^\/|^[a-z]+:/i.test(path)) throw new Error('Only paths inside the project are available')
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  if (kind === 'file' && !parts.length) throw new Error('Name a file to read')
  const ref = commands.deployment.project?.defaultBranch ?? 'main'
  if (kind === 'file') {
    const encoded = encodeURIComponent(parts.join('/'))
    return commands.gitlabApi(`repository/files/${encoded}/raw?ref=${encodeURIComponent(ref)}`)
  }
  const query = parts.length ? `?path=${encodeURIComponent(parts.join('/'))}&ref=${encodeURIComponent(ref)}&per_page=100`
    : `?ref=${encodeURIComponent(ref)}&per_page=100`
  const entries = await commands.gitlabPages(z.looseObject({ name: z.string(), type: z.string().nullish(), path: z.string() }),
    `repository/tree${query}`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}

/** Formats a GitLab note as a model-facing message, marking bots and access-token users because their words never authorize work. */
function gitlabMessage(note: GitlabNote, text: string, id: string): ContextMessage {
  const line = note.position?.new_line ?? note.position?.old_line
  const path = note.position?.new_path ?? note.position?.old_path
  return { id, from: note.author.username, at: note.updated_at ?? note.created_at, text: text || note.body || '',
    ...!isHumanUser(note.author) ? { bot: true as const } : {},
    ...id.startsWith('http') ? { url: id } : {}, ...path ? { path, ...line != null ? { line } : {} } : {} }
}
/** Web page of an Issue or merge request, the base of a note's message ID. */
const entityPage = (commands: Commands, iid: number, mr: boolean): string =>
  commands.deployment.project?.webUrl ? `${commands.deployment.project.webUrl}/-/${mr ? 'merge_requests' : 'issues'}/${iid}` : ''
const noteUrl = (base: string, note: GitlabNote): string => `${base}#note_${note.id}`
const noteMessage = (note: GitlabNote, base: string, place = false): ContextMessage =>
  gitlabMessage(note, [place ? notePlace(note) : '', note.body ?? ''].filter(Boolean).join('\n\n'), noteUrl(base, note))
/** A discussion's notes as messages, the first with its diff place; later notes answer the first. */
function discussionMessages(discussion: GitlabDiscussion, base: string, place = true): ContextMessage[] {
  const notes = discussion.notes.filter(note => !note.system).sort((a, b) => a.created_at.localeCompare(b.created_at))
  const [first] = notes
  return notes.map(note => {
    const message = noteMessage(note, base, place && note === first)
    return note === first ? message : { ...message, ...first ? { reply_to: noteUrl(base, first) } : {} }
  })
}
const descriptionMessage = (item: GitlabMergeRequest | z.infer<typeof IssueSchema>): ContextMessage => ({
  id: item.web_url, from: item.author.username, at: item.created_at, text: `${item.title}\n\n${item.description ?? ''}`.trimEnd(),
  ...!isHumanUser(item.author) ? { bot: true as const } : {}, url: item.web_url })
async function conversationPage(commands: Commands, iid: number, mr: boolean, page: number) {
  const messages: ContextMessage[] = []
  if (page === 1) {
    const item = mr ? await commands.gitlabApi(MergeRequestSchema, `merge_requests/${iid}`)
      : await commands.gitlabApi(IssueSchema, `issues/${iid}`)
    messages.push(descriptionMessage(item))
  }
  const base = mr ? `merge_requests/${iid}` : `issues/${iid}`
  const listed = await commands.gitlabApi(z.array(z.unknown()), `${base}/notes?per_page=100&page=${page}&sort=asc&order_by=created_at`)
  const tally = { skipped: 0 }
  const notes = validItems(NoteSchema, listed, tally).filter(note => !note.system)
  const page0 = entityPage(commands, iid, mr)
  messages.push(...notes.map(note => noteMessage(note, page0, true)))
  return { messages, next_resource: listed.length === 100 ? String(page + 1) : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
}

/**
 * Reads an Issue, merge request, conversation page, discussion, or pipeline jobs as model-facing
 * `{ id, from, at, text, reply_to?, path?, line?, url }` messages rather than raw GitLab records.
 */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const jobs = /^gitlab\/pipelines\/([1-9]\d*)\/jobs$/.exec(resource)
  if (jobs) return { jobs: await readPipelineJobs(commands, Number(jobs[1])) }
  const match = /^gitlab\/(issues|merge_requests)\/([1-9]\d*)(?:\/(notes|discussions|pipelines|approvals)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) throw new Error('Use gitlab/issues/<iid>, gitlab/merge_requests/<iid>, append /notes/<page>, /discussions/<page>, /approvals or /pipelines, or gitlab/pipelines/<id>/jobs')
  const [, kind, iidText, section, page = '1'] = match
  const iid = Number(iidText)
  const mr = kind === 'merge_requests'
  const base = `${kind}/${iid}`
  if (section === 'approvals') {
    if (!mr || match[4]) throw new Error('Approvals require a merge request without a page')
    return readApprovals(commands, iid)
  }
  if (!section) {
    if (mr) {
      const item = await commands.gitlabApi(MergeRequestSchema, base)
      return { iid: item.iid, title: item.title, state: item.state, ...item.merged_at ? { merged: true } : {},
        ...item.draft ? { draft: true } : {}, auto_merge_enabled: autoMergeEnabled(item),
        detailed_merge_status: item.detailed_merge_status ?? null, approvals_resource: `gitlab/merge_requests/${iid}/approvals`, source_branch: item.source_branch, target_branch: item.target_branch,
        ...item.head_pipeline ? { pipeline: item.head_pipeline.id, pipeline_status: item.head_pipeline.status } : {},
        ...descriptionMessage(item) }
    }
    const item = await commands.gitlabApi(IssueSchema, base)
    return { iid: item.iid, title: item.title, state: item.state, ...descriptionMessage(item) }
  }
  if (section === 'pipelines') {
    if (mr) {
      const item = await commands.gitlabApi(MergeRequestSchema, base)
      const pipeline = await mrPipeline(commands, item)
      if (!pipeline) return { pipeline: null, jobs: [] }
      return pipelineSnapshot(commands, pipeline)
    }
    const issue = await commands.gitlabApi(IssueSchema, base)
    throw new Error(`Issue #${issue.iid} has no pipelines; read the merge request that closes it instead`)
  }
  if (section === 'discussions') {
    if (!mr) throw new Error('Discussions require a merge request')
    const listed = await commands.gitlabApi(z.array(z.unknown()), `${base}/discussions?per_page=100&page=${page}`)
    const tally = { skipped: 0 }
    const discussions = validItems(DiscussionSchema, listed, tally)
    const page0 = entityPage(commands, iid, true)
    const messages = discussions.flatMap(discussion => discussionMessages(discussion, page0)
      .map(message => ({ ...message, discussionId: discussion.id })))
    return { messages, ...tally.skipped ? { skipped: tally.skipped } : {},
      ...listed.length === 100 ? { next_resource: `gitlab/merge_requests/${iid}/discussions/${Number(page) + 1}` } : {} }
  }
  const listed = await commands.gitlabApi(z.array(z.unknown()), `${base}/notes?per_page=100&page=${page}&sort=asc&order_by=created_at`)
  const tally = { skipped: 0 }
  const notes = validItems(NoteSchema, listed, tally).filter(note => !note.system)
  const page0 = entityPage(commands, iid, mr)
  return { messages: notes.map(note => noteMessage(note, page0, true)), ...tally.skipped ? { skipped: tally.skipped } : {},
    ...listed.length === 100 ? { next_resource: `gitlab/${kind}/${iid}/notes/${Number(page) + 1}` } : {} }
}

/**
 * Context reader for a GitLab Trigger: reads the whole discussion for a discussion note, the Issue or merge request
 * conversation by page otherwise, and the Trigger itself for default-branch CI. Images are not supported.
 */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger, part, cursor): Promise<ContextPart> => {
    if (typeof trigger.meta.branch === 'string') {
      const message = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true as const }
      return { messages: [message], body: { status: 'branch_ci', messages: [message] }, status: 'branch_ci' }
    }
    const iid = Number(trigger.meta.iid)
    const mr = trigger.meta.mr === true
    const discussionId = typeof trigger.meta.discussionId === 'string' ? trigger.meta.discussionId : undefined
    if (mr && discussionId) {
      const discussions = await commands.gitlabPages(DiscussionSchema, `merge_requests/${iid}/discussions?per_page=100`)
      const discussion = discussions.find(item => item.id === discussionId)
      const base = entityPage(commands, iid, true)
      const messages = discussion ? discussionMessages(discussion, base, true) : []
      if (messages.length) {
        const read = part === 'thread' ? messages : messages.slice(0, 1)
        return { messages: read, body: { status: 'discussion', discussionId, messages: read }, status: 'discussion' }
      }
    }
    const body = await conversationPage(commands, iid, mr, Number(cursor ?? '1'))
    return { messages: body.messages, next: body.next_resource ?? undefined, body }
  },
}
