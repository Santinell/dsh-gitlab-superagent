import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Commands, CliError } from '../src/infra/commands.ts'
import { ciCounts, ciFailures, ciRecovered, readApprovals, ciFact, ciSummary, gitlabThreadContext, pipelineSnapshot, readGitlab, readRepositoryPath } from '../src/sources/gitlab-read.ts'
import { DiscussionSchema, IssueSchema, MergeRequestSchema, NoteSchema, noteTrigger, issueTrigger } from '../src/sources/gitlab-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/gitlab/entities', name), 'utf8'))
const issue = IssueSchema.parse(fixture('issue.json'))
const mr = MergeRequestSchema.parse(fixture('merge-request.json'))
const pipeline = fixture('pipeline.json') as { id: number; status: string; ref: string; sha: string; web_url: string }
const jobs = fixture('jobs.json') as { id: number; name: string; status: string; stage: string }[]
const notes = (fixture('issue-notes.json') as unknown[]).map(note => NoteSchema.parse(note))
const discussions = (fixture('discussions.json') as unknown[]).map(discussion => DiscussionSchema.parse(discussion))
const deployment = testDeployment({ repository: 'tlcamp/human-resources',
  project: { id: 25, path: 'tlcamp/human-resources', webUrl: 'https://gitlab.example.com/tlcamp/human-resources', defaultBranch: 'main' },
  codeHost: { kind: 'gitlab', host: 'gitlab.example.com', apiBase: 'https://gitlab.example.com/api/v4',
    webBase: 'https://gitlab.example.com', cli: '/bin/false', login: 'agent', userId: 7, commitEmail: 'agent@example.com' } })
const commands = new Commands(() => deployment, {}, new AbortController().signal)
afterEach(() => vi.restoreAllMocks())
/** Routes project-scoped API calls; a string route is raw output, an array becomes newline-delimited JSON. */
function api(routes: Record<string, unknown>) {
  const reads: string[] = []
  const answer = (args: string[]) => {
    const path = String(args[1]).replace(/^projects\/25\//, '')
    reads.push(path)
    const route = routes[path.split('?')[0]!] ?? routes[path]
    const value = typeof route === 'function' ? (route as () => unknown)() : route
    if (value instanceof Error) throw value
    return value
  }
  vi.spyOn(commands, 'glab').mockImplementation(async args => JSON.parse(JSON.stringify(answer(args))) as never)
  vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
    const value = answer(args)
    return typeof value === 'string' ? value : (Array.isArray(value) ? value : [value]).map(item => JSON.stringify(item)).join('\n')
  })
  return reads
}

describe('gitlab read', () => {
  it('builds CI facts from a pipeline and its jobs, not from check-runs', async () => {
    api({ 'pipelines/1179/jobs': jobs })
    const snapshot = await pipelineSnapshot(commands, pipeline)
    expect(snapshot).toEqual({ pipeline: { id: 1179, status: 'success', ref: 'p0/credential-check',
      sha: '5a3347474c07fd5f1e483c8051b31935fa79536c' }, jobs: [{ ...jobs[0], stage: 'test' }] })
    expect(ciCounts(snapshot)).toEqual({ failed: 0, running: 0 })
    expect(ciFact(ciCounts(snapshot))).toEqual({ label: 'CI', value: { zh: '通过', en: 'passed' } })
  })
  it('describes failed jobs first, then running ones, and treats a failed pipeline without failed jobs as a failure', () => {
    const job = (name: string, status: string) => ({ id: 1, name, status, stage: 'test' })
    const failing = { pipeline: { id: 9, status: 'failed', sha: 'abc1234def' }, jobs: [job('test', 'failed'), job('lint', 'success'), job('e2e', 'running')] }
    expect(ciCounts(failing)).toEqual({ failed: 1, running: 1 })
    expect(ciFailures(failing)).toEqual(['test/test'])
    expect(ciSummary(failing, 'MR !7', 'gitlab/merge_requests/7/pipelines'))
      .toBe('CI failed 1/3 on MR !7 at abc1234: test/test; 1 still running\nRead gitlab/merge_requests/7/pipelines for every job.')
    expect(ciFact(ciCounts(failing))).toEqual({ label: { zh: 'CI 失败', en: 'CI failed' }, value: '1', problem: true })
    const broken = { pipeline: { id: 10, status: 'failed' }, jobs: [] }
    expect(ciFailures(broken)).toEqual(['pipeline:failed'])
    expect(ciCounts(broken)).toEqual({ failed: 1, running: 0 })
    const canceled = { pipeline: { id: 11, status: 'canceled' }, jobs: [job('docs', 'canceled')] }
    expect(ciFailures(canceled)).toEqual(['test/docs'])
    const running = { pipeline: { id: 12, status: 'running', sha: 'def4567' }, jobs: [job('test', 'running')] }
    expect(ciFact(ciCounts(running))).toEqual({ label: { zh: 'CI 进行中', en: 'CI running' }, value: '1' })
    expect(ciSummary(running, 'main', 'gitlab/pipelines/12/jobs')).toMatch(/^CI running 1\/1 on main at def4567: test/)
    expect(ciSummary({ pipeline: { id: 13, status: 'success' }, jobs: [job('test', 'success')] }, 'main', 'x'))
      .toMatch(/^CI passed 1\/1/)
  })
  it('reads an Issue description and its non-system notes, and exposes the next page', async () => {
    const routes: Record<string, unknown> = { 'issues/1': issue, 'issues/1/notes': notes }
    api(routes)
    const context = gitlabThreadContext
    const trigger = issueTrigger(issue, 'agent')
    expect(context.messageId(trigger)).toBe(issue.web_url)
    const first = await context.read(commands, trigger, 'thread', undefined, {})
    expect(first.messages[0]).toEqual({ id: issue.web_url, from: 'pavel.evdokimov', at: issue.created_at,
      text: `${issue.title}\n\n${issue.description}`, url: issue.web_url })
    // The system note is dropped; the project-access-token note is marked a bot, the person's note is not.
    expect(first.messages).toHaveLength(3)
    expect(first.messages[1]).toMatchObject({ bot: true })
    expect(first.messages[1]!.id).toContain('#note_2653')
    expect(first.messages[2]).toMatchObject({ from: 'pavel.evdokimov', text: 'P0 note fixture. Safe to delete.' })
    expect(first.messages[2]).not.toHaveProperty('bot')
    expect(first.next).toBeUndefined()
    // A full page of raw notes asks for page 2; page 2 has no description.
    const hundred = Array.from({ length: 100 }, (_, index) => ({ ...notes[1], id: 1000 + index, body: `note ${index}` }))
    routes['issues/1/notes'] = hundred
    const page = await gitlabThreadContext.read(commands, trigger, 'thread', undefined, {})
    expect(page.next).toBe('2')
    expect(page.messages).toHaveLength(101)
  })
  it('reads a discussion thread with its discussion id and diff place, and answers the first note', async () => {
    const inline = { ...discussions[0]!, notes: [
      { ...discussions[0]!.notes[0]!, id: 30, body: 'root', position: { new_path: 'src/render.ts', new_line: 43 } },
      { ...discussions[0]!.notes[0]!, id: 31, body: 'reply', position: null },
    ] }
    api({ [`merge_requests/1/discussions`]: [inline] })
    const trigger = noteTrigger(inline.notes[1]!, { iid: 1, mr: true, discussionId: inline.id, url: mr.web_url, host: 'gitlab.example.com',
      projectPath: 'tlcamp/human-resources' }, 'agent')!
    const thread = await gitlabThreadContext.read(commands, trigger, 'thread', undefined, {})
    expect(thread.status).toBe('discussion')
    expect(thread.messages.map(message => [message.id, message.reply_to, message.text]))
      .toEqual([[`${deployment.project!.webUrl}/-/merge_requests/1#note_30`, undefined, 'src/render.ts:43\n\nroot'],
        [`${deployment.project!.webUrl}/-/merge_requests/1#note_31`, `${deployment.project!.webUrl}/-/merge_requests/1#note_30`, 'reply']])
    expect((await gitlabThreadContext.read(commands, trigger, 'parent', undefined, {})).messages).toHaveLength(1)
  })
  it('reads repository files and directory listings on the default branch, refusing paths outside the project', async () => {
    const reads = api({ 'repository/files/src%2Frender.ts/raw': 'export const render = () => 1\n',
      'repository/tree': [{ name: 'src', type: 'tree', path: 'src' }, { name: '.env', type: 'blob', path: '.env' },
        { name: 'node_modules', type: 'tree', path: 'node_modules' }, { name: 'README.md', type: 'blob', path: 'README.md' }] })
    expect(await readRepositoryPath(commands, 'src/render.ts', 'file')).toBe('export const render = () => 1\n')
    expect(reads.at(-1)).toBe('repository/files/src%2Frender.ts/raw?ref=main')
    expect(await readRepositoryPath(commands, '', 'directory')).toBe('README.md\nsrc')
    expect(reads.at(-1)).toBe('repository/tree?ref=main&per_page=100')
    for (const path of ['../secret', '/etc/passwd', '.env', 'src/../secret', 'node_modules/x']) {
      await expect(readRepositoryPath(commands, path, 'file')).rejects.toThrow()
    }
    expect(reads).toHaveLength(2)
  })
  it('reads resources by their GitLab names: Issue, MR, discussions, and pipeline jobs', async () => {
    api({ 'issues/1': issue, 'merge_requests/1': mr, 'merge_requests/1/discussions': discussions, 'pipelines/1179/jobs': jobs })
    expect(await readGitlab(commands, 'gitlab/issues/1')).toMatchObject({ iid: 1, title: issue.title, state: 'opened' })
    expect(await readGitlab(commands, 'gitlab/merge_requests/1')).toMatchObject({ iid: 1, title: mr.title, source_branch: 'p0/mr-source',
      pipeline: 1180, pipeline_status: 'success' })
    const thread = await readGitlab(commands, 'gitlab/merge_requests/1/discussions') as { messages: { discussionId: string }[] }
    expect(thread.messages[0]).toMatchObject({ discussionId: discussions[0]!.id })
    expect(await readGitlab(commands, 'gitlab/pipelines/1179/jobs')).toMatchObject({ jobs: [expect.objectContaining({ id: 12991 })] })
    await expect(readGitlab(commands, 'gitlab/issues/1?x=1')).rejects.toThrow()
    await expect(readGitlab(commands, 'gitlab/../issues/1')).rejects.toThrow()
  })
})

it('ignores allowed failures, identifies stages, and never calls a waiting pipeline passed', () => {
  const snapshot = { pipeline: { id: 1, status: 'success' }, jobs: [
    { id: 1, name: 'optional', status: 'failed', allow_failure: true },
    { id: 2, name: 'test', stage: 'unit', status: 'failed' },
    { id: 3, name: 'test', stage: 'integration', status: 'failed' },
    { id: 4, name: 'test', stage: 'unit', status: 'failed' },
  ] }
  expect(ciFailures(snapshot)).toEqual(['integration/test', 'unit/test'])
  for (const status of ['running', 'pending', 'manual', 'blocked', 'skipped', 'scheduled', 'unknown']) {
    const waiting = { pipeline: { id: 2, status }, jobs: [{ id: 5, name: 'test', status: 'success' }] }
    expect(ciCounts(waiting).running).toBe(1)
    expect(ciRecovered(waiting)).toBe(false)
    expect(ciSummary(waiting, 'main', 'jobs')).not.toContain('CI passed')
  }
  const allowed = { pipeline: { id: 2, status: 'success' }, jobs: snapshot.jobs.slice(0, 1) }
  expect(ciFailures(allowed)).toEqual([])
  expect(ciRecovered(allowed)).toBe(true)
  expect(ciCounts({ ...allowed, jobs: [{ id: 9, name: 'deploy', status: 'manual', allow_failure: false }] }).running).toBe(1)
})

it('reads Free approvals without Premium requirements and distinguishes forbidden from revoked', async () => {
  const raw = fixture('approval.json')
  const routes = { 'merge_requests/1/approvals': raw as unknown }
  api(routes)
  expect(await readGitlab(commands, 'gitlab/merge_requests/1/approvals')).toEqual({ available: true, approved: false, approved_by: [] })
  routes['merge_requests/1/approvals'] = { approved: true, approved_by: [{ user: { username: 'alice' } }] }
  expect(await readApprovals(commands, 1)).toEqual({ available: true, approved: true, approved_by: ['alice'] })
  for (const status of [403, 404]) {
    routes['merge_requests/1/approvals'] = new CliError('Unavailable', status)
    expect(await readApprovals(commands, 1)).toEqual({ available: false, status })
  }
  routes['merge_requests/1/approvals'] = new CliError('Rate limited', 429)
  await expect(readApprovals(commands, 1)).rejects.toMatchObject({ code: 429 })
  await expect(readGitlab(commands, 'gitlab/issues/1/approvals')).rejects.toThrow('merge request')
  await expect(readGitlab(commands, 'gitlab/merge_requests/1/approvals/2')).rejects.toThrow('without a page')
})

it('does not confirm recovery from a partial job list and uses the API default excluding retried jobs', async () => {
  const reads = api({ 'pipelines/1179/jobs': [{ id: 99, name: 'test', status: 'success' }, { id: 98 }] })
  await expect(pipelineSnapshot(commands, pipeline)).rejects.toThrow('Incomplete pipeline jobs')
  expect(reads).toContain('pipelines/1179/jobs?per_page=100')
  expect(reads.join(' ')).not.toContain('include_retried=true')
  api({ 'merge_requests/1': { ...mr, sha: 'new-sha', head_pipeline: { id: 1, sha: 'old-sha', status: 'success' } }, pipelines: [] })
  expect(await readGitlab(commands, 'gitlab/merge_requests/1/pipelines')).toEqual({ pipeline: null, jobs: [] })
})
