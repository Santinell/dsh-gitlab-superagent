/** Merge request binding, lifecycle observation, and terminal notice helpers for the GitLab Source. */
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { readApprovals } from './gitlab-read.ts'
import type { SourceContext } from './host.ts'
import { autoMergeEnabled, gitlabThread, gitlabThreadId, gitlabThreadRef, type GitlabMergeRequest, MergeRequestSchema, SOURCE } from './gitlab-trigger.ts'

export type MergeRequest = GitlabMergeRequest
export const readMr = async (ctx: SourceContext, iid: number, signal?: AbortSignal): Promise<MergeRequest> =>
  ctx.commands.withSignal(signal).gitlabApi(MergeRequestSchema, `merge_requests/${iid}`)
export const mrsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => {
    const ref = gitlabThreadRef(item.thread)
    return ref?.mr ? [ref.iid] : []
  })
export const mrOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => mrsOf(ticket, true).at(-1) ?? mrsOf(ticket).at(-1)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
/**
 * True when the MR was opened by the agent account from the configured project rather than from a fork.
 * Both project ids must identify the configured project; a missing source id can mean a deleted fork.
 */
export const agentMr = (mr: Pick<MergeRequest, 'author' | 'source_project_id' | 'target_project_id'>,
  deployment: Pick<Deployment, 'codeHost' | 'project'>): boolean => {
  if (!deployment.codeHost || !sameName(mr.author.username, deployment.codeHost.login)) return false
  const project = deployment.project?.id
  if (project === undefined) return true
  return mr.source_project_id === project && mr.target_project_id === project
}
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }
const mergeStatus = (status: string | null | undefined): ThreadFact | null => status
  ? { label: { zh: '合并状态', en: 'Merge status' }, value: status } : null

/**
 * Validates and binds an open MR to a ticket when the MR is either the ticket's origin MR or an agent-authored MR on the
 * ticket's branch, enforcing that one MR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the MR is bound or not open.
 */
export function claimMr(ctx: SourceContext, ticketId: string, mr: MergeRequest): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its MR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.mr === true && Number(source.meta.iid) === mr.iid
  if (ctx.deployment.project && mr.target_project_id != null && mr.target_project_id !== ctx.deployment.project.id) return 'MR targets another project'
  const opened = agentMr(mr, ctx.deployment) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const login = ctx.deployment.codeHost?.login ?? 'the agent account'
    return `MR does not belong to this ticket: use the source MR or an MR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit mr_iid when no MR exists`
  }
  const owner = ctx.tickets.open().find(item => mrsOf(item, true).includes(mr.iid))
  if (owner && owner.id !== ticketId) return 'MR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === gitlabThread(mr.iid, true))
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, mr, opened)
  return undefined
}
/**
 * Reconciles a polled MR's open/merged/closed/locked state, auto-merge request, and merge status with any bound or
 * branch-matching ticket. An open agent MR auto-binds to the single open ticket on its branch unless that ticket already
 * follows another open MR; `merge_when_pipeline_succeeds` stays a fact and never merges anything.
 * @returns whether the MR has ended.
 */
export async function observeMr(ctx: SourceContext, mr: MergeRequest): Promise<boolean> {
  if (ctx.deployment.project && mr.target_project_id != null && mr.target_project_id !== ctx.deployment.project.id) return false
  const ended = mr.state === 'merged' || mr.state === 'closed' || mr.state === 'locked'
  if (ended) closeMr(ctx, mr)
  else {
    const candidates = agentMr(mr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // An MR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === gitlabThread(mr.iid, true) && item.closed)
    if (ticket && (reopened || mrsOf(ticket, true).every(iid => iid === mr.iid))) claimMr(ctx, ticket.id, mr)
  }
  ctx.threads.describe(gitlabThread(mr.iid, true), { facts: {
    autoMerge: !ended && autoMergeEnabled(mr) ? AUTO_MERGE_ON : null,
    mergeStatus: ended ? null : mergeStatus(mr.detailed_merge_status) } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, mr: MergeRequest, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: gitlabThreadId(mr.iid, true) }, own)
    ctx.threads.patch(gitlabThread(mr.iid, true), { iid: mr.iid, mr: true, url: mr.web_url, title: mr.title, mrAuthor: mr.author.username })
  })
}
/** Reports a merged or closed MR once to the open tickets that follow it, whose end the core decides. */
function closeMr(ctx: SourceContext, mr: MergeRequest): void {
  if (!ctx.tickets.open().some(ticket => mrsOf(ticket, true).includes(mr.iid))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: gitlabThreadId(mr.iid, true) }, mr.merged_at || mr.state === 'merged' ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for an MR's merge or close, for every channel except GitLab, whose timeline already
 * shows it. `projectWebUrl` is the project page, such as `https://gitlab.example.com/group/project`.
 */
export function mrEndNotices(ticket: Ticket, request: string, projectWebUrl: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && gitlabThreadRef(item.thread)?.mr === true)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const iid = gitlabThreadRef(follow.thread)!.iid
  const url = `${projectWebUrl}/-/merge_requests/${iid}`
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[MR !${iid}](${url}) 已合并。` : `[MR !${iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', String(iid), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}

/** Publishes/clears optional approval facts without introducing authorization or lifecycle actions. */
export function observeApprovals(ctx: SourceContext, iid: number, value: Awaited<ReturnType<typeof readApprovals>> | undefined): void {
  ctx.threads.describe(gitlabThread(iid, true), { facts: {
    approvals: !value?.available ? null : { label: { en: 'Approvals', zh: '批准' },
      value: value.approved_by.length ? value.approved_by.map(user => `@${user}`).join(', ') : { en: 'none', zh: '无' } },
    approved: value?.available && value.approved !== null ? { label: { en: 'Approved', zh: '已批准' },
      value: value.approved ? { en: 'yes', zh: '是' } : { en: 'no', zh: '否' } } : null,
    approvalsUnavailable: value && !value.available ? { label: { en: 'Approvals', zh: '批准' }, value: { en: 'unavailable', zh: '不可用' } } : null,
  } })
}
