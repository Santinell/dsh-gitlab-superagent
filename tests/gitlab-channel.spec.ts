import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands, CliError } from '../src/infra/commands.ts'
import { sendGitlab, gitlabLink } from '../src/sources/gitlab-channel.ts'
import { testDeployment } from './fixtures/deployment.ts'

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/gitlab/entities', name), 'utf8'))
const discussion = (fixture('discussions.json') as { id: string; notes: { id: number; body: string; author: { username: string } }[] }[])[0]!
const deployment = testDeployment({ repository: 'tlcamp/human-resources',
  project: { id: 25, path: 'tlcamp/human-resources', webUrl: 'https://gitlab.example.com/tlcamp/human-resources', defaultBranch: 'main' },
  codeHost: { kind: 'gitlab', host: 'gitlab.example.com', apiBase: 'https://gitlab.example.com/api/v4',
    webBase: 'https://gitlab.example.com', cli: '/bin/false', login: 'agent', userId: 7, commitEmail: 'agent@example.com' } })
const commands = new Commands(() => deployment, {}, new AbortController().signal)
afterEach(() => vi.restoreAllMocks())

const message = (address: Record<string, string>): OutboundMessage => ({ id: 'reply-1', channel: { source: 'gitlab', thread: 'gitlab:issue:1', address },
  text: 'On it.', kind: 'reply', ticketId: 't1' })
const note = (id: number, body: string, username = 'carol') => ({ id, body, author: { id: 1, username, state: 'active', bot: false },
  created_at: '2026-11-15T12:00:00Z', updated_at: '2026-11-15T12:00:00Z', system: false })
/** Routes `glab api` and paginated `glab api` calls by path, returning the recorded call paths and methods. */
function api(routes: Record<string, unknown>) {
  const calls: string[] = []
  vi.spyOn(commands, 'glab').mockImplementation(async args => {
    const path = String(args[1]).replace(/^projects\/25\//, '')
    calls.push(`${args.includes('POST') || args.includes('--method') && args[args.indexOf('--method') + 1] === 'POST' ? 'POST' : 'GET'} ${path}`)
    const route = routes[path.split('?')[0]!] ?? routes[path] ?? []
    const value = typeof route === 'function' ? (route as () => unknown)() : route
    if (value instanceof Error) throw value
    return JSON.parse(JSON.stringify(value)) as unknown
  })
  vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
    const path = String(args[1]).replace(/^projects\/25\//, '')
    calls.push(`GET ${path}`)
    const route = routes[path.split('?')[0]!] ?? routes[path] ?? []
    const value = typeof route === 'function' ? (route as () => unknown)() : route
    if (value instanceof Error) throw value
    return (Array.isArray(value) ? value : [value]).map(item => JSON.stringify(item)).join('\n')
  })
  return calls
}

it('posts an Issue note once, embedding the message marker in the Markdown body', async () => {
  const routes: Record<string, unknown> = { 'issues/1/notes': [] }
  const calls = api(routes)
  expect(await sendGitlab({ commands }, message({ iid: '1', mr: 'false' }))).toBe('sent')
  const post = calls.find(call => call.startsWith('POST'))
  expect(post).toBe('POST issues/1/notes')
  const args = vi.mocked(commands.glab).mock.calls.at(-1)![0]
  expect(args).toContain('body=On it.\n\n<!-- dsh-superagent:reply-1 -->')
  // The next delivery finds the agent's marked note and posts nothing.
  routes['issues/1/notes'] = [note(5, 'On it.\n\n<!-- dsh-superagent:reply-1 -->', 'agent')]
  expect(await sendGitlab({ commands }, message({ iid: '1', mr: 'false' }))).toBe('sent')
  expect(vi.mocked(commands.glab).mock.calls.filter(([args]) => args.includes('POST'))).toHaveLength(1)
})

it('does not mistake another user\'s marker for its own note', async () => {
  const routes: Record<string, unknown> = { 'merge_requests/2/notes': [note(6, 'On it.\n\n<!-- dsh-superagent:reply-1 -->', 'carol')] }
  const calls = api(routes)
  expect(await sendGitlab({ commands }, message({ iid: '2', mr: 'true' }))).toBe('sent')
  expect(calls).toContain('POST merge_requests/2/notes')
})

it('replies inside the discussion that carried the note', async () => {
  const routes: Record<string, unknown> = { [`merge_requests/1/discussions/${discussion.id}`]: discussion }
  const calls = api(routes)
  expect(await sendGitlab({ commands }, message({ iid: '1', mr: 'true', discussion: discussion.id }))).toBe('sent')
  expect(calls).toContain(`POST merge_requests/1/discussions/${discussion.id}/notes`)
  // Its own marked note in that discussion is `sent`, without a second post.
  const marked = { ...discussion, notes: [note(9, 'On it.\n\n<!-- dsh-superagent:reply-1 -->', 'agent')] }
  routes[`merge_requests/1/discussions/${discussion.id}`] = marked
  expect(await sendGitlab({ commands }, message({ iid: '1', mr: 'true', discussion: discussion.id }))).toBe('sent')
  expect(calls.filter(call => call.startsWith('POST'))).toHaveLength(1)
})

it('finds the discussion of a note URL retained from an older queued reply', async () => {
  const routes: Record<string, unknown> = { 'merge_requests/1/discussions': [discussion], [`merge_requests/1/discussions/${discussion.id}`]: discussion }
  const calls = api(routes)
  expect(await sendGitlab({ commands }, message({ iid: '1', mr: 'true',
    url: `https://gitlab.example.com/tlcamp/human-resources/-/merge_requests/1#note_${discussion.notes[0]!.id}` }))).toBe('sent')
  expect(calls).toContain(`POST merge_requests/1/discussions/${discussion.id}/notes`)
})

it('reports gone for a deleted target or a locked discussion, but retries other failures', async () => {
  const { CliError } = await import('../src/infra/commands.ts')
  api({ 'issues/3/notes': () => { throw new CliError('404 Not found', 404) },
    [`merge_requests/4/discussions/d-1`]: () => { throw new CliError('Note locked', 403) } })
  expect(await sendGitlab({ commands }, message({ iid: '3', mr: 'false' }))).toBe('gone')
  expect(await sendGitlab({ commands }, message({ iid: '4', mr: 'true', discussion: 'd-1' }))).toBe('gone')
  api({ 'issues/5/notes': () => { throw new CliError('Forbidden', 403) } })
  await expect(sendGitlab({ commands }, message({ iid: '5', mr: 'false' }))).rejects.toThrow('Forbidden')
  api({ 'issues/6/notes': () => { throw new CliError('Bad Gateway', 502) } })
  await expect(sendGitlab({ commands }, message({ iid: '6', mr: 'false' }))).rejects.toThrow('Bad Gateway')
})

it('links an Issue, a merge request, and a discussion with the Trigger\'s note URL', () => {
  expect(gitlabLink({ iid: '12', mr: 'false', url: 'https://gitlab.example.com/p/-/issues/12#note_3' }, {})).toEqual({ url: 'https://gitlab.example.com/p/-/issues/12#note_3',
    label: { zh: 'GitLab #12', en: 'GitLab #12' } })
  expect(gitlabLink({ iid: '7', mr: 'true', discussion: 'd', url: 'https://gitlab.example.com/p/-/merge_requests/7#note_4' }, {}).label.en)
    .toBe('Discussion on GitLab !7')
  expect(gitlabLink({ iid: '7', mr: 'true' }, { codeHost: deployment.codeHost, project: deployment.project }).url)
    .toBe('https://gitlab.example.com/tlcamp/human-resources/-/merge_requests/7')
  expect(gitlabLink({ iid: '7' }, {}).url).toBe('')
})

it('replies to an Issue note URL without querying an unrelated MR with the same IID', async () => {
  const calls = api({ 'merge_requests/1/discussions': new CliError('Not found', 404), 'issues/1/notes': [] })
  expect(await sendGitlab({ commands }, message({ iid: '1', mr: 'false', url: `${deployment.project!.webUrl}/-/issues/1#note_123` }))).toBe('sent')
  expect(calls.some(call => call.includes('merge_requests/'))).toBe(false)
  expect(calls).toContain('POST issues/1/notes')
})

it.each([404, 410, 403])('handles a gone/locked MR while looking up a retained note URL (%s)', async status => {
  const calls = api({ 'merge_requests/1/discussions': new CliError(status === 403 ? 'Notes are locked' : 'Gone', status) })
  expect(await sendGitlab({ commands }, message({ iid: '1', mr: 'true', url: `${deployment.project!.webUrl}/-/merge_requests/1#note_123` }))).toBe('gone')
  expect(calls.filter(call => call.startsWith('POST'))).toEqual([])
})

it('propagates retryable discussion lookup failures without posting in a different place', async () => {
  const calls = api({ 'merge_requests/1/discussions': new CliError('HTTP 429', 429) })
  await expect(sendGitlab({ commands }, message({ iid: '1', mr: 'true', url: `${deployment.project!.webUrl}/-/merge_requests/1#note_123` }))).rejects.toMatchObject({ code: 429 })
  expect(calls.filter(call => call.startsWith('POST'))).toEqual([])
})

it('does not move a reply to the MR timeline if its retained note no longer belongs to a discussion', async () => {
  const calls = api({ 'merge_requests/1/discussions': [] })
  expect(await sendGitlab({ commands }, message({ iid: '1', mr: 'true', url: `${deployment.project!.webUrl}/-/merge_requests/1#note_123` }))).toBe('gone')
  expect(calls.filter(call => call.startsWith('POST'))).toEqual([])
})
