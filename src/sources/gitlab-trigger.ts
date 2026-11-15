/** Normalizes GitLab Issues, merge requests, notes, discussions, and pipelines into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/** HTML marker embedded in a note so a repeated delivery of the same message ID creates no second note. */
export const commentMarker = (id: string): string => `<!-- dsh-superagent:${id} -->`
/** Thread key of a GitLab Issue or merge request; the two IID sequences are independent, so the kind is part of the key. */
export const gitlabThread = (iid: number, mr = false): string => `${SOURCE}:${gitlabThreadId(iid, mr)}`
/** `ThreadRef.id` of an Issue or merge request: the kind and IID, which `Thread.key` prefixes with the Source. */
export const gitlabThreadId = (iid: number, mr = false): string => `${mr ? 'mr' : 'issue'}:${iid}`
/** Parses a full Thread key (`gitlab:issue:<iid>`) or a ThreadRef id (`issue:<iid>`) into its kind and IID. */
export function gitlabThreadRef(thread: string): { iid: number; mr: boolean } | undefined {
  const match = /^(?:gitlab:)?(issue|mr):([1-9]\d*)$/.exec(thread)
  return match ? { iid: Number(match[2]), mr: match[1] === 'mr' } : undefined
}
/** A GitLab Issue or merge request the note belongs to, plus what a reply needs to reach the same place. */
export interface GitlabRef {
  iid: number
  mr: boolean
  /** Numeric project id, kept in trigger meta as groundwork for multi-project support. */
  projectId?: number
  host?: string
  projectPath?: string
  /** Web URL of the Issue or merge request. */
  url?: string
  /** Discussion the note belongs to, when the caller read it through `discussions`. */
  discussionId?: string
}
/** GitLab reply address: an Issue or merge request conversation, or one of its discussions. */
export const gitlabChannel = (iid: number, discussionId?: string, mr = false, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: gitlabThread(iid, mr), address: { iid: String(iid), mr: mr ? 'true' : 'false',
    ...(discussionId ? { discussion: discussionId } : {}), ...(url ? { url } : {}) } })
/** Web page of an Issue or merge request; `mr` selects `merge_requests` over `issues`. */
export const gitlabPage = (host: string, projectPath: string, iid: number, mr = false): string =>
  `https://${host}/${projectPath}/-/${mr ? 'merge_requests' : 'issues'}/${iid}`
/**
 * Parses a web URL of an Issue, work item, or merge request in `projectPath` on `host`.
 * A `#note_<id>` fragment is returned as `note`; the discussion id is not part of a note URL.
 */
export function gitlabAddress(url: string, host: string, projectPath: string): { iid: number; mr: boolean; note?: number } | undefined {
  const base = `^https?://${escapeRegExp(host)}/${escapeRegExp(projectPath)}/-/(issues|work_items|merge_requests)/([1-9]\\d*)`
  const match = new RegExp(`${base}(?:[/?#].*)?$`, 'i').exec(url)
  if (!match) return undefined
  const note = /#note_(\d+)/i.exec(url)?.[1]
  return { iid: Number(match[2]), mr: match[1]!.toLowerCase() === 'merge_requests', ...note ? { note: Number(note) } : {} }
}
/**
 * A GitLab user as an API entity returns it; a deleted account comes back as `null` or as the instance's Ghost User,
 * whose `blocked` state never authorizes work.
 */
export const UserSchema = z.looseObject({ id: z.number().optional(), username: z.string(), name: z.string().nullish(),
  state: z.string().default('active'), bot: z.boolean().optional() }).nullable()
  .transform(user => user ?? { username: 'ghost', name: 'Ghost User', state: 'blocked', bot: false })
/** True when GitLab reports an ordinary, active person: not a bot flag, GitLab's Ghost User, or a project/group access-token user. */
export const isHumanUser = (user: { username: string; state: string; bot?: boolean }): boolean =>
  user.state === 'active' && user.bot !== true && user.username !== 'ghost' && !/^(?:project|group)_\d+_bot_/i.test(user.username)
/** An inline discussion note's file and line; GitLab does not include the diff hunk in the note. */
export const PositionSchema = z.looseObject({ base_sha: z.string().nullish(), start_sha: z.string().nullish(), head_sha: z.string().nullish(),
  old_path: z.string().nullish(), new_path: z.string().nullish(), position_type: z.string().nullish(),
  old_line: z.number().nullish(), new_line: z.number().nullish() })
/** A GitLab note: a conversation comment, or an inline note carrying a diff `position`. */
export const NoteSchema = z.looseObject({ id: z.number(), type: z.string().nullish(), body: z.string().nullish(), author: UserSchema,
  created_at: z.string(), updated_at: z.string().nullish(), system: z.boolean().default(false), noteable_type: z.string().nullish(),
  noteable_iid: z.number().nullish(), resolvable: z.boolean().nullish(), resolved: z.boolean().nullish(),
  discussion_id: z.string().nullish(), position: PositionSchema.nullish() })
export type GitlabNote = z.infer<typeof NoteSchema>
/** A GitLab discussion: a group of notes, resolvable as a whole, that a diff thread or an ordinary thread lives in. */
export const DiscussionSchema = z.looseObject({ id: z.string(), individual_note: z.boolean().optional(),
  resolvable: z.boolean().nullish(), resolved: z.boolean().nullish(), notes: z.array(NoteSchema) })
export type GitlabDiscussion = z.infer<typeof DiscussionSchema>
/** An Issue, which shares the note body fields but carries `iid` and `description` instead of `body`. */
export const IssueSchema = NoteSchema.extend({ iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(),
  web_url: z.string(), project_id: z.number().optional(), updated_at: z.string().nullish() })
export type GitlabIssue = z.infer<typeof IssueSchema>
export const PipelineSchema = z.looseObject({ id: z.number(), iid: z.number().optional(), status: z.string(), ref: z.string().optional(),
  sha: z.string().optional(), web_url: z.string().nullish() })
export type GitlabPipeline = z.infer<typeof PipelineSchema>
/** A merge request; `state` is `opened`, `closed`, `locked`, or `merged`. */
export const MergeRequestSchema = z.looseObject({ id: z.number().optional(), iid: z.number(), title: z.string(),
  description: z.string().nullish(), state: z.string(), author: UserSchema, created_at: z.string(), updated_at: z.string().nullish(),
  web_url: z.string(), source_branch: z.string(), target_branch: z.string().optional(), sha: z.string().nullish(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(), merge_when_pipeline_succeeds: z.boolean().nullish(), auto_merge_enabled: z.boolean().nullish(),
  detailed_merge_status: z.string().nullish(), source_project_id: z.number().nullish(), target_project_id: z.number().nullish(),
  draft: z.boolean().optional(), discussion_locked: z.boolean().nullish(), project_id: z.number().optional(),
  head_pipeline: PipelineSchema.nullish() })
export type GitlabMergeRequest = z.infer<typeof MergeRequestSchema>
/** Free approval facts; Premium requirements are deliberately not part of this contract. */
export const ApprovalsSchema = z.looseObject({ approved: z.boolean().nullish(),
  approved_by: z.array(z.object({ user: UserSchema })).default([]) })
export type GitlabApprovals = z.infer<typeof ApprovalsSchema>
export const autoMergeEnabled = (mr: GitlabMergeRequest): boolean =>
  mr.auto_merge_enabled ?? mr.merge_when_pipeline_succeeds ?? false

export const JobSchema = z.looseObject({ id: z.number(), name: z.string(), status: z.string(), stage: z.string().nullish(),
  ref: z.string().optional(), allow_failure: z.boolean().optional(), web_url: z.string().nullish() })
export type GitlabJob = z.infer<typeof JobSchema>
/** A TODO of the agent account; `target.iid` exists for Issues and merge requests but not for every `target_type`. */
export const TodoSchema = z.looseObject({ id: z.number(), action_name: z.string(), target_type: z.string(), state: z.string().optional(),
  author: UserSchema, project: z.looseObject({ id: z.number(), path_with_namespace: z.string() }).optional(),
  target: z.looseObject({ iid: z.number().nullish() }).nullish(), target_url: z.string().nullish(), body: z.string().nullish(),
  created_at: z.string(), updated_at: z.string().nullish() })
export type GitlabTodo = z.infer<typeof TodoSchema>

/** Whether `text` mentions `username` as a standalone `@username`, case-insensitively; GitLab usernames may contain dots. */
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@.])@${escapeRegExp(username)}(?![a-zA-Z0-9_.-])`, 'i').test(text)
const author = (user: { username: string; state: string; bot?: boolean }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: isHumanUser(user) && !sameName(user.username, agent) })
/** Formats an inline note's file:line; a conversation note has no place. */
export function notePlace(note: GitlabNote): string {
  const line = note.position?.new_line ?? note.position?.old_line
  const path = note.position?.new_path ?? note.position?.old_path
  return path ? `${path}${line != null ? `:${line}` : ''}` : ''
}
const webUrl = (note: GitlabNote, ref: GitlabRef): string | undefined => {
  const page = ref.url ?? (ref.host && ref.projectPath ? gitlabPage(ref.host, ref.projectPath, ref.iid, ref.mr) : '')
  return page ? `${page}#note_${note.id}` : undefined
}
/**
 * Builds the trigger for a conversation or inline note.
 * A system note returns undefined: GitLab writes mentions into assignment and label notes, which grant nothing.
 */
export function noteTrigger(note: GitlabNote, ref: GitlabRef, agent: string): Trigger | undefined {
  if (note.system) return undefined
  const discussionId = note.discussion_id ?? ref.discussionId
  const kind = ref.mr ? note.position ? 'inline' as const : 'conversation' as const : 'note' as const
  const url = webUrl(note, ref)
  const line = note.position?.new_line ?? note.position?.old_line
  const path = note.position?.new_path ?? note.position?.old_path
  const at = note.updated_at ?? note.created_at
  return { id: key('gitlab-note', String(note.id), at), source: SOURCE, threads: [{ source: SOURCE, id: gitlabThreadId(ref.iid, ref.mr) }],
    ...author(note.author, agent), at, text: [notePlace(note), note.body ?? ''].filter(Boolean).join('\n\n'),
    ...mentions(note.body ?? '', agent) ? { addressed: 'mention' as const } : {},
    channel: gitlabChannel(ref.iid, discussionId, ref.mr, url),
    ...url ? { url } : {},
    meta: { iid: ref.iid, mr: ref.mr, kind, commentId: note.id, ...ref.projectId !== undefined ? { projectId: ref.projectId } : {},
      ...discussionId ? { discussionId } : {}, ...path ? { path, ...line != null ? { line } : {} } : {},
      ...note.resolvable != null ? { resolvable: note.resolvable, resolved: note.resolved === true } : {} } }
}
/** Builds the trigger for a newly opened Issue's title and description. */
export function issueTrigger(issue: GitlabIssue, agent: string): Trigger {
  const description = issue.description ?? ''
  return { id: key('gitlab-issue', String(issue.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: gitlabThreadId(issue.iid, false) }], ...author(issue.author, agent), at: issue.created_at,
    text: `${issue.title}\n\n${description}`, ...mentions(description, agent) ? { addressed: 'mention' as const } : {},
    channel: gitlabChannel(issue.iid, undefined, false, issue.web_url), url: issue.web_url,
    meta: { iid: issue.iid, mr: false, kind: 'issue', ...issue.project_id !== undefined ? { projectId: issue.project_id } : {} } }
}
/** Builds the trigger for a newly opened merge request's title and description. */
export function mrTrigger(mr: GitlabMergeRequest, agent: string): Trigger {
  const description = mr.description ?? ''
  return { id: key('gitlab-mr', String(mr.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: gitlabThreadId(mr.iid, true) }], ...author(mr.author, agent), at: mr.created_at,
    text: `${mr.title}\n\n${description}`, ...mentions(description, agent) ? { addressed: 'mention' as const } : {},
    channel: gitlabChannel(mr.iid, undefined, true, mr.web_url), url: mr.web_url,
    meta: { iid: mr.iid, mr: true, kind: 'mr', mrAuthor: mr.author.username, mrSourceBranch: mr.source_branch,
      ...mr.project_id !== undefined ? { projectId: mr.project_id } : {} } }
}
/** Builds a trigger for a change in the default branch's pipeline failures; default-branch CI has no person to reply to. */
export function branchPipelineTrigger(branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('gitlab-ci', `branch:${branch}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: `ci:${branch}` }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, branch, sha, revision } }
}
/** Builds a trigger for a change in an open merge request's pipeline failures. */
export function pipelineTrigger(mr: GitlabMergeRequest, revision: number, summary: string): Trigger {
  return { id: key('gitlab-ci', String(mr.iid), String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: gitlabThreadId(mr.iid, true) }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: gitlabChannel(mr.iid, undefined, true, mr.web_url), url: mr.web_url,
    meta: { iid: mr.iid, mr: true, mrAuthor: mr.author.username, ci: true, revision, ...mr.sha ? { sha: mr.sha } : {} } }
}
