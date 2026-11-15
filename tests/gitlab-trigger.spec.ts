import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { key } from '../src/core/index.ts'
import { branchPipelineTrigger, gitlabAddress, gitlabChannel, gitlabPage, isHumanUser, issueTrigger, mentions,
  MergeRequestSchema, mrTrigger, NoteSchema, noteTrigger, pipelineTrigger, type GitlabNote, type GitlabRef } from '../src/sources/gitlab-trigger.ts'

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/gitlab/entities', name), 'utf8'))
const issue = fixture('issue.json') as Parameters<typeof issueTrigger>[0]
const mr = MergeRequestSchema.parse(fixture('merge-request.json'))
const notes = (fixture('issue-notes.json') as unknown[]).map(note => NoteSchema.parse(note))
const discussion = (fixture('discussions.json') as { id: string; notes: unknown[] }[])[0]!
const discussionNote = NoteSchema.parse(discussion.notes[0])
const ref = (overrides: Partial<GitlabRef> = {}): GitlabRef => ({ iid: 1, mr: false, projectId: 25, host: 'gitlab.example.com',
  projectPath: 'tlcamp/human-resources', url: 'https://gitlab.example.com/tlcamp/human-resources/-/issues/1', ...overrides })

describe('gitlab trigger', () => {
  it('turns an Issue into a Trigger on a kind-qualified thread, with the agent account as the only non-human sender', () => {
    const trigger = issueTrigger(issue, 'agent')
    expect(trigger).toMatchObject({
      id: key('gitlab-issue', '1'), source: 'gitlab', threads: [{ source: 'gitlab', id: 'issue:1' }],
      actor: { source: 'gitlab', id: 'pavel.evdokimov' }, human: true, at: issue.created_at,
      text: 'P0 spike: entity fixture\n\nTest issue for P0 fixtures. Safe to close.',
      channel: { source: 'gitlab', thread: 'gitlab:issue:1', address: { iid: '1', mr: 'false',
        url: 'https://gitlab.campbox.tech/tlcamp/human-resources/-/work_items/1' } },
      url: issue.web_url, meta: { iid: 1, mr: false, kind: 'issue', projectId: 25 },
    })
    expect(trigger).not.toHaveProperty('addressed')
    expect(issueTrigger(issue, 'pavel.evdokimov').human).toBe(false)
    expect(issueTrigger({ ...issue, description: 'Hi @agent please fix' }, 'agent').addressed).toBe('mention')
  })
  it('turns a merge request into a Trigger with its author and source branch, never reusing an Issue trigger ID', () => {
    const trigger = mrTrigger(mr, 'agent')
    expect(trigger).toMatchObject({
      id: key('gitlab-mr', '1'), source: 'gitlab', threads: [{ source: 'gitlab', id: 'mr:1' }],
      actor: { source: 'gitlab', id: 'pavel.evdokimov' }, human: true,
      channel: { source: 'gitlab', address: { iid: '1', mr: 'true', url: mr.web_url } },
      meta: { iid: 1, mr: true, kind: 'mr', mrAuthor: 'pavel.evdokimov', mrSourceBranch: 'p0/mr-source', projectId: 25 },
    })
    expect(trigger.id).not.toBe(issueTrigger(issue, 'agent').id)
  })
  it('turns a conversation note into a reply in its discussion, and ignores system notes', () => {
    expect(noteTrigger(notes.find(note => note.system)!, ref(), 'agent')).toBeUndefined()
    const trigger = noteTrigger(discussionNote, ref({ mr: true, discussionId: discussion.id, url: mr.web_url }), 'agent')!
    expect(trigger).toMatchObject({
      id: key('gitlab-note', String(discussionNote.id), discussionNote.updated_at ?? discussionNote.created_at),
      source: 'gitlab', threads: [{ source: 'gitlab', id: 'mr:1' }], human: true, text: 'P0 discussion fixture.',
      channel: { source: 'gitlab', thread: 'gitlab:mr:1', address: { iid: '1', mr: 'true', discussion: discussion.id,
        url: `${mr.web_url}#note_${discussionNote.id}` } },
      meta: { iid: 1, mr: true, kind: 'conversation', commentId: discussionNote.id, discussionId: discussion.id,
        resolvable: true, resolved: false },
    })
    expect(trigger.url).toBe(`${mr.web_url}#note_${discussionNote.id}`)
  })
  it('starts an inline note with its file and line and keeps the diff position in meta', () => {
    const inline: GitlabNote = NoteSchema.parse({ ...discussionNote, id: 77, body: 'Please rename this', resolvable: true, resolved: null,
      discussion_id: 'd-1', position: { old_path: 'src/render.ts', new_path: 'src/render.ts', old_line: null, new_line: 43 } })
    const trigger = noteTrigger(inline, ref({ mr: true }), 'agent')!
    expect(trigger.text).toBe('src/render.ts:43\n\nPlease rename this')
    expect(trigger.meta).toMatchObject({ kind: 'inline', path: 'src/render.ts', line: 43, discussionId: 'd-1' })
    expect(trigger.channel?.address.discussion).toBe('d-1')
  })
  it('marks bots, access-token users, GitLab\'s Ghost User and the agent account as automated', () => {
    expect(isHumanUser({ username: 'alice', state: 'active' })).toBe(true)
    expect(isHumanUser({ username: 'alice', state: 'active', bot: true })).toBe(false)
    expect(isHumanUser({ username: 'project_25_bot_abc', state: 'active' })).toBe(false)
    expect(isHumanUser({ username: 'group_7_bot_abc', state: 'active' })).toBe(false)
    expect(isHumanUser({ username: 'ghost', state: 'blocked' })).toBe(false)
    expect(isHumanUser({ username: 'alice', state: 'blocked' })).toBe(false)
    const botNote = notes.find(note => note.id === 2653)!
    expect(botNote.author.username).toMatch(/^project_25_bot_/)
    expect(noteTrigger(botNote, ref(), 'agent')).toMatchObject({ human: false, actor: { id: botNote.author.username } })
    // A deleted account is returned as Ghost User; its mention grants nothing but the note stays context.
    const ghost = NoteSchema.parse({ ...discussionNote, id: 88, author: null, body: '@agent take over' })
    expect(noteTrigger(ghost, ref(), 'agent')).toMatchObject({ human: false, actor: { id: 'ghost' }, addressed: 'mention' })
  })
  it('recognizes a standalone mention of a GitLab username with dots, and not an email or a longer name', () => {
    expect(mentions('@agent.bot please fix', 'agent.bot')).toBe(true)
    expect(mentions('ping @Agent.Bot', 'agent.bot')).toBe(true)
    expect(mentions('mail@agent.bot', 'agent.bot')).toBe(false)
    expect(mentions('@agent.bot.example', 'agent.bot')).toBe(false)
    expect(mentions('@agent.bot', 'agent')).toBe(false)
  })
  it('reads web addresses of Issues, work items, and merge requests, including a note fragment', () => {
    const host = 'gitlab.example.com', path = 'tlcamp/human-resources'
    expect(gitlabAddress(`https://${host}/${path}/-/issues/12`, host, path)).toEqual({ iid: 12, mr: false })
    expect(gitlabAddress(`https://${host}/${path}/-/work_items/12#note_7`, host, path)).toEqual({ iid: 12, mr: false, note: 7 })
    expect(gitlabAddress(`https://${host}/${path}/-/merge_requests/9#note_2652`, host, path)).toEqual({ iid: 9, mr: true, note: 2652 })
    for (const url of [`https://${host}/other/project/-/issues/12`, `https://gitlab.com/${path}/-/issues/12`,
      `https://${host}/${path}/-/pipelines/12`, '']) expect(gitlabAddress(url, host, path)).toBeUndefined()
    expect(gitlabPage(host, path, 9, true)).toBe(`https://${host}/${path}/-/merge_requests/9`)
  })
  it('addresses replies by iid and discussion, and CI triggers by the MR thread or the default branch thread', () => {
    expect(gitlabChannel(9, undefined, true, 'https://x/y')).toEqual({ source: 'gitlab', thread: 'gitlab:mr:9',
      address: { iid: '9', mr: 'true', url: 'https://x/y' } })
    const branch = branchPipelineTrigger('main', 'abc', 2, 'CI failed 1/2 on main at abc: test', 'https://x/pipeline/1')
    expect(branch).toMatchObject({ id: key('gitlab-ci', 'branch:main', '2'), threads: [{ source: 'gitlab', id: 'ci:main' }],
      human: false, meta: { ci: true, branch: 'main', sha: 'abc', revision: 2 } })
    expect(branch).not.toHaveProperty('channel')
    const ci = pipelineTrigger(mr, 1, 'CI failed on !1')
    expect(ci).toMatchObject({ id: key('gitlab-ci', '1', '1'), threads: [{ source: 'gitlab', id: 'mr:1' }],
      channel: { source: 'gitlab', thread: 'gitlab:mr:1', address: { iid: '1', mr: 'true', url: mr.web_url } },
      meta: { iid: 1, mr: true, ci: true, revision: 1, mrAuthor: 'pavel.evdokimov' } })
  })
})
