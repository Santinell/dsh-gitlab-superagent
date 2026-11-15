import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { search, threadDetail } from '../src/app/views/threads.ts'
import { gitlabLink } from '../src/sources/gitlab-channel.ts'
import { IssueSchema, MergeRequestSchema, issueTrigger, mrTrigger, noteTrigger } from '../src/sources/gitlab-trigger.ts'
import { gitlabHost } from './fixtures/gitlab-host.ts'

it('keeps Issue #1 and MR !1 distinct in search, thread details and note links', async () => {
  const h = gitlabHost()
  try {
    const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/gitlab/entities/${name}.json`, import.meta.url), 'utf8'))
    const base = 'https://gitlab.example.test/group/subgroup/project'
    const issue = issueTrigger(IssueSchema.parse({ ...fixture('issue'), iid: 1, web_url: `${base}/-/issues/1` }), 'agent')
    const mr = mrTrigger(MergeRequestSchema.parse({ ...fixture('merge-request'), iid: 1, web_url: `${base}/-/merge_requests/1` }), 'agent')
    await h.receive(issue); await h.receive(mr)
    const host = { store: h.store, sources: h.sources, links: (channel: typeof issue.channel & {}) => gitlabLink(channel.address, {}) }
    const cache = { entries: () => [][Symbol.iterator]() }
    expect(search(host, '#1', cache).threads.map(thread => thread.key)).toEqual(['gitlab:issue:1'])
    expect(search(host, '!1', cache).threads.map(thread => thread.key)).toEqual(['gitlab:mr:1'])
    expect(search(host, '1', cache).threads.map(thread => thread.key)).toEqual(['gitlab:issue:1', 'gitlab:mr:1'])
    for (const trigger of [issue, mr]) {
      const key = `gitlab:${trigger.meta.mr ? 'mr' : 'issue'}:1`
      expect(search(host, key, cache).threads.map(thread => thread.key)).toEqual([key])
      expect(threadDetail(host, key, undefined, 20)?.url).toBe(trigger.url)
      expect(search(host, trigger.url!, cache).threads.map(thread => thread.key)).toEqual([key])
    }
    const notes = fixture('issue-notes') as Record<string, unknown>[]
    const note = noteTrigger({ ...notes.find(note => !note.system)!, id: 9001 } as Parameters<typeof noteTrigger>[0],
      { iid: 1, mr: true, host: 'gitlab.example.test', projectId: 25, projectPath: 'group/subgroup/project', url: mr.url!, discussionId: 'discussion-1' }, 'agent')!
    expect(note.url).toBe(`${mr.url}#note_9001`)
    expect(gitlabLink(note.channel!.address, {}).url).toBe(note.url)
  } finally { h.store.close() }
})
