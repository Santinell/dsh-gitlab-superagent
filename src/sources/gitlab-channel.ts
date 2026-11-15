/** GitLab outbound channel: posts Issue or merge request notes, and replies inside the discussion a note came from. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { commentMarker, DiscussionSchema as Discussion, gitlabAddress, gitlabPage, NoteSchema } from './gitlab-trigger.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

/** True when a note can never be posted: its Issue or MR is gone (404), or its discussion is locked (403). */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 404 || error.code === 410 || (error.code === 403 && /locked|note locked/i.test(error.message)))
/** The project the reply belongs to, so a retained address without its own URL still resolves against this deployment. */
const projectOf = (host: Pick<SourceContext, 'commands'>): { host: string; path: string } | undefined => {
  const { project, codeHost } = host.commands.deployment
  return codeHost && project ? { host: codeHost.host, path: project.path } : undefined
}
/** Finds the discussion that holds `note` by listing the MR's discussions; undefined when the note is not there. */
async function discussionOfNote(host: Pick<SourceContext, 'commands'>, iid: number, note: number): Promise<string | undefined> {
  const discussions = await host.commands.gitlabPages(Discussion, `merge_requests/${iid}/discussions?per_page=100`)
  return discussions.find(discussion => discussion.notes.some(item => item.id === note))?.id
}
/**
 * Posts a note with an embedded HTML marker so a repeated delivery with the same message ID does not create a second note.
 * A reply into a discussion stays in that discussion; a missing discussion or a locked/deleted target is `'gone'`.
 */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { login } = commands.deployment.codeHost ?? { login: '' }
  const iid = Number(message.channel.address.iid)
  if (!iid) throw new Error('Missing GitLab reply target')
  let mr = message.channel.address.mr === 'true'
  let discussion = message.channel.address.discussion
  const project = projectOf(host)
  const parsed = project ? gitlabAddress(message.channel.address.url ?? '', project.host, project.path) : undefined
  const marker = commentMarker(message.id)
  const mine = (notes: z.infer<typeof NoteSchema>[]) => notes.some(note =>
    sameName(note.author.username, login) && (note.body ?? '').includes(marker))
  try {
    if (parsed && parsed.iid === iid) {
      mr = mr || parsed.mr
      // A reply queued before thread-aware delivery names the note, not its discussion; find the discussion it lives in.
      if (mr && !discussion && parsed.note) {
        discussion = await discussionOfNote(host, iid, parsed.note)
        if (!discussion) return 'gone'
      }
    }
    const base = mr ? `merge_requests/${iid}` : `issues/${iid}`
    if (discussion) {
      const current = await commands.gitlabApi(Discussion, `${base}/discussions/${encodeURIComponent(discussion)}`)
      if (mine(current.notes)) return 'sent'
      await commands.gitlabApi(z.unknown(), `${base}/discussions/${encodeURIComponent(discussion)}/notes`, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
      return 'sent'
    }
    if (mine(await commands.gitlabPages(NoteSchema, `${base}/notes?per_page=100&sort=desc&order_by=created_at`))) return 'sent'
    await commands.gitlabApi(z.unknown(), `${base}/notes`, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** The URL and label of an Issue or merge request reply target, preferring the note URL the Trigger carried. */
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const iid = Number(address.iid)
  const mr = address.mr === 'true'
  const number = Number.isFinite(iid) && iid > 0 ? iid : 0
  const discussion = !!address.discussion
  const base = address.url || (links.codeHost && links.project && number
    ? gitlabPage(links.codeHost.host, links.project.path, number, mr) : '')
  const mark = mr ? `!${number}` : `#${number}`
  return { url: base, label: discussion
    ? { zh: `GitLab ${mark} 的 discussion`, en: `Discussion on GitLab ${mark}` }
    : { zh: `GitLab ${mark}`, en: `GitLab ${mark}` } }
}
