import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { GitlabConfigSchema, gitlabKind, pollRound, watch, retryAfter } from '../src/sources/gitlab.ts'
import { IssueSchema, MergeRequestSchema, NoteSchema, TodoSchema } from '../src/sources/gitlab-trigger.ts'
import { execution, gitlabHost, ticketOf } from './fixtures/gitlab-host.ts'

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/gitlab/entities', name), 'utf8'))
const issueFixture = IssueSchema.parse(fixture('issue.json'))
const mrFixture = MergeRequestSchema.parse(fixture('merge-request.json'))
const todoFixture = TodoSchema.parse((fixture('todo.json') as unknown[])[0])
const noteFixture = NoteSchema.parse((fixture('issue-notes.json') as unknown[])[1])
const pipelineFixture = fixture('pipeline.json') as Record<string, unknown>
const jobsFixture = fixture('jobs.json') as Record<string, unknown>[]
afterEach(() => vi.restoreAllMocks())

const issueOf = (overrides: Record<string, unknown> = {}) => IssueSchema.parse({ ...issueFixture, iid: 7, title: 'Fix the margin',
  description: '@agent please fix', created_at: '2026-11-15T12:00:00Z', updated_at: '2026-11-15T12:00:00Z',
  author: { ...issueFixture.author, username: 'pavel.evdokimov' },
  web_url: 'https://gitlab.example.com/tlcamp/human-resources/-/issues/7', ...overrides })
const noteOf = (overrides: Record<string, unknown> = {}) => NoteSchema.parse({ ...noteFixture, id: 9001, body: 'please look',
  created_at: '2026-11-15T12:05:00Z', updated_at: '2026-11-15T12:05:00Z', author: { ...noteFixture.author, username: 'pavel.evdokimov' }, ...overrides })
const todoOf = (iid: number, overrides: Record<string, unknown> = {}) => TodoSchema.parse({ ...todoFixture, id: 900, target: { iid },
  target_type: 'Issue', created_at: '2026-11-15T12:00:30Z', updated_at: '2026-11-15T12:00:30Z', body: '@agent please fix', ...overrides })
/** Replaces the GitLab Source instance's configuration, as the settings panel does. */
function configure(h: ReturnType<typeof gitlabHost>, config: Record<string, unknown>, enabled = true) {
  const settings = h.store.settings()
  const current = settings.sources.gitlab as { enabled: boolean; config: Record<string, unknown> }
  h.store.saveSettings({ ...settings, sources: { ...settings.sources, gitlab: { enabled, config: { ...current.config, ...config } } } })
}
/** Routes user-level and project-scoped API calls; array routes become newline-delimited JSON for paginated reads. */
function api(routes: Record<string, unknown>) {
  const reads: string[] = []
  const answer = (args: string[]) => {
    const path = String(args[1]).replace(/^projects\/25\//, '')
    reads.push(path)
    const route = routes[path.split('?')[0]!] ?? routes[path]
    const value = typeof route === 'function' ? (route as () => unknown)() : route
    if (value instanceof Error) throw value
    return value ?? (/merge_requests\/\d+\/approvals$/.test(path) ? fixture('approval.json') : [])
  }
  vi.spyOn(Commands.prototype, 'glab').mockImplementation(async args => JSON.parse(JSON.stringify(answer(args))) as never)
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
    const value = answer(args)
    return typeof value === 'string' ? value : (Array.isArray(value) ? value : [value]).map(item => JSON.stringify(item)).join('\n')
  })
  return reads
}
const host = () => gitlabHost()

describe('gitlab source', () => {
  it('turns a TODO mention in an Issue body into one Trigger, and a repeated round creates no duplicate', async () => {
    const h = host()
    const issue = issueOf()
    api({ todos: [todoOf(7)], 'issues/7': issue, 'issues/7/notes': [] })
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ source: 'gitlab', threads: [{ source: 'gitlab', id: 'issue:7' }], human: true,
      addressed: 'mention', meta: { iid: 7, mr: false, kind: 'issue' } })
    expect(h.store.get(KV.gitlab.cursor('issue', 7))).toBeDefined()
    // The TODO is still pending (mark-as-done is best effort), but the cursor already passed it.
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    h.store.close()
  })
  it('catches an event no TODO reported through the observed Issue stream, with its new note', async () => {
    const h = host()
    configure(h, { observeIssues: true, observeNotes: true })
    h.store.set(KV.gitlab.stream('issues'), { since: '2026-11-15T11:59:00.000Z', started: '2026-11-15T11:59:00.000Z' })
    const issue = issueOf({ updated_at: '2026-11-15T12:05:00Z' })
    const note = noteOf()
    api({ todos: [], issues: [issue], 'issues/7/notes': [note] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.text)).toEqual([
      'Fix the margin\n\n@agent please fix',
      'please look',
    ])
    expect(h.store.get(KV.gitlab.stream('issues'))).toMatchObject({ since: expect.any(String), started: '2026-11-15T11:59:00.000Z' })
    h.store.close()
  })
  it('reads a subscribed Thread since its checkpoint without a new mention, skipping the agent\'s own notes', async () => {
    const h = host()
    h.store.threads.save({ key: 'gitlab:issue:7', ref: { source: 'gitlab', id: 'issue:7' }, createdAt: '2026-11-15T12:00:00Z',
      lastAt: new Date().toISOString(), subscriptions: ['t1'], correlated: [], pending: [], meta: { iid: 7, mr: false, title: 'Fix the margin' } })
    api({ todos: [], 'issues/7': issueOf(), 'issues/7/notes': [noteOf(), noteOf({ id: 9002, body: 'mine', author: { ...noteFixture.author, username: 'agent' } })] })
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ text: 'please look', human: true })
    expect(h.receive.mock.calls[0]![0]).not.toHaveProperty('addressed')
    expect(h.store.threads.get('gitlab:issue:7')!.meta).toMatchObject({ label: '#7 Fix the margin', facts: { number: { value: '#7' } } })
    h.store.close()
  })
  it('reports the default branch pipeline once per change in the failing jobs', async () => {
    const h = host()
    configure(h, { observeCi: true })
    let pipeline: Record<string, unknown> = { ...pipelineFixture, ref: 'main', status: 'success' }
    let jobs: Record<string, unknown>[] = [{ ...jobsFixture[0]!, name: 'test', status: 'success' }]
    api({ todos: [], pipelines: () => [pipeline], 'pipelines/1179/jobs': () => jobs })
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    pipeline = { ...pipeline, status: 'failed' }
    jobs = [{ ...jobs[0]!, status: 'failed' }]
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ meta: { ci: true, branch: 'main', revision: 1 },
      threads: [{ source: 'gitlab', id: 'ci:main' }], text: expect.stringContaining('CI failed 1/1') })
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    h.store.close()
  })
  it('polls the pipeline of an open ticket\'s merge request and records its CI fact', async () => {
    const h = host()
    h.store.tickets.save(ticketOf({ id: 't1', follows: [{ thread: 'gitlab:mr:3', own: true }], origin: { triggerId: 'x', triggerIds: [] } }))
    let jobs: Record<string, unknown>[] = [{ ...jobsFixture[0]!, name: 'test', status: 'success' }]
    api({ todos: [], 'merge_requests/3': { ...mrFixture, iid: 3, state: 'opened' }, 'pipelines/1180/jobs': () => jobs })
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    jobs = [{ ...jobs[0]!, status: 'failed' }]
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ meta: { iid: 3, mr: true, ci: true, revision: 1 },
      text: expect.stringContaining('MR !3') })
    expect(h.store.threads.get('gitlab:mr:3')!.meta.facts).toMatchObject({ ci: { value: '1' } })
    h.store.close()
  })
  it('keeps a failed read\'s cursor and retries it next round', async () => {
    const h = host()
    api({ todos: [todoOf(7)], 'issues/7': () => { throw new CliError('Bad Gateway', 502) } })
    await expect(pollRound(h)).rejects.toThrow(/1 GitLab reads failed: issue:7/)
    expect(h.store.get(KV.gitlab.cursor('issue', 7))).toBeUndefined()
    expect(h.store.get(KV.gitlab.retries)).toMatchObject({ 'issue:7': { pr: false } })
    h.store.close()
  })
  it('shows its scopes and observation flags, and stops polling when the Source is off', async () => {
    const h = host()
    expect(gitlabKind.scope!({ meta: { kind: 'issue' } }, GitlabConfigSchema.parse({ observeIssues: false })))
      .toEqual({ listened: true, observed: false, row: 'issues' })
    expect(gitlabKind.scope!({ meta: { iid: 1, mr: true, kind: 'mr' } }, GitlabConfigSchema.parse({ observeMergeRequests: true })))
      .toEqual({ listened: true, observed: true, row: 'mergeRequests' })
    expect(gitlabKind.scope!({ meta: { kind: 'note' } }, GitlabConfigSchema.parse({ observeNotes: true })))
      .toEqual({ listened: true, observed: true, row: 'notes' })
    const rows = gitlabKind.policy!.rows!(GitlabConfigSchema.parse({ observeIssues: true, observeNotes: false }))
    expect(rows.find(row => row.id === 'issues')).toMatchObject({ note: { en: 'All' } })
    expect(rows.find(row => row.id === 'notes')).toMatchObject({ note: { en: '@ only' } })
    expect(gitlabKind.fields.map(field => field.key)).toEqual(expect.arrayContaining(['project', 'observeIssues', 'observeMergeRequests',
      'observeNotes', 'observeCi']))
    // A disabled Source yields no config, so the loop reports it off and makes no request.
    configure(h, {}, false)
    const run = vi.spyOn(h.commands, 'run')
    const glab = vi.spyOn(h.commands, 'glab')
    const controller = new AbortController()
    const running = watch(h, controller.signal)
    await vi.waitFor(() => expect(h.health.gitlab).toMatchObject({ state: 'paused', code: 'sourceOff' }))
    controller.abort()
    await running
    expect(run).not.toHaveBeenCalled()
    expect(glab).not.toHaveBeenCalled()
    h.store.close()
  })
  it('uses its own KV key family, which does not collide with GitHub or Feishu', () => {
    expect(KV.gitlab.todos).toBe('gitlab-todos')
    expect(KV.gitlab.cursor('issue', 7)).toBe('gitlab-cursor:issue:7')
    expect(KV.gitlab.stream('issues')).toBe('gitlab-stream:issues')
    expect(KV.gitlab.branchPipeline).toBe('gitlab-branch-pipeline')
    expect(KV.gitlab.pipeline(3)).toBe('gitlab-pipeline:3')
    expect(KV.gitlab.retries).toBe('gitlab-retry')
    const keys = [KV.gitlab.todos, KV.gitlab.retries, KV.gitlab.cursor('issue', 1), KV.gitlab.stream('x'), KV.gitlab.branchPipeline, KV.gitlab.pipeline(1)]
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every(key => key.startsWith('gitlab-'))).toBe(true)
  })
})


describe('GitLab polling regressions', () => {
  const mrOf = (overrides: Record<string, unknown> = {}) => ({ ...mrFixture, iid: 3, state: 'opened',
    source_branch: 'agent/fix-margin', author: { ...mrFixture.author, username: 'agent' }, ...overrides })

  it('discovers an agent MR with observation off, delivers replies, and ends its ticket on merge', async () => {
    const h = host()
    h.store.tickets.save(ticketOf())
    let mr = mrOf()
    let notes: ReturnType<typeof noteOf>[] = []
    const reads = api({ todos: [], merge_requests: () => [mr], 'merge_requests/3': () => mr,
      'merge_requests/3/discussions': () => [{ id: 'review', notes }], 'pipelines/1180/jobs': jobsFixture })
    await pollRound(h)
    expect(reads).toContain('merge_requests?state=opened&author_username=agent&per_page=100')
    expect(h.store.tickets.get('t1')!.follows).toContainEqual({ thread: 'gitlab:mr:3', own: true })
    const at = new Date(Date.now() + 1000).toISOString()
    notes = [noteOf({ created_at: at, updated_at: at })]
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.text)).toContain('please look')
    mr = mrOf({ state: 'merged', merged_at: new Date().toISOString() })
    await pollRound(h)
    expect(h.store.tickets.get('t1')!.ended?.outcome).toBe('merged')
    h.store.close()
  })

  it.each(['todo', 'stream'])('binds an agent MR received through %s without a second detail read', async path => {
    const h = host()
    h.store.tickets.save(ticketOf())
    configure(h, { observeMergeRequests: path === 'stream' })
    h.store.set(KV.gitlab.stream('mergeRequests'), { since: '2026-11-15T11:59:00Z', started: '2026-11-15T11:59:00Z' })
    const mr = mrOf()
    const reads = api({ todos: path === 'todo' ? [todoOf(3, { target_type: 'MergeRequest' })] : [],
      merge_requests: path === 'stream' ? [mr] : [], 'merge_requests/3': mr,
      'merge_requests/3/discussions': [], 'pipelines/1180/jobs': jobsFixture })
    await pollRound(h)
    expect(h.store.tickets.get('t1')!.follows).toContainEqual({ thread: 'gitlab:mr:3', own: true })
    expect(reads.filter(read => read === 'merge_requests/3')).toHaveLength(1)
    h.store.close()
  })

  it.each([
    { mr: false, observeNotes: false }, { mr: false, observeNotes: true },
    { mr: true, observeNotes: false }, { mr: true, observeNotes: true },
  ])('keeps subscribed notes with $mr MR and observeNotes=$observeNotes when the stream cursor is newer', async ({ mr, observeNotes }) => {
    const h = host()
    configure(h, { observeIssues: true, observeMergeRequests: true, observeNotes })
    h.store.tickets.save(ticketOf())
    const kind = mr ? 'mr' : 'issue'
    const stream = mr ? 'mergeRequests' : 'issues'
    h.store.threads.save({ key: `gitlab:${kind}:7`, ref: { source: 'gitlab', id: `${kind}:7` },
      createdAt: '2026-11-15T12:00:00Z', lastAt: new Date().toISOString(), subscriptions: ['t1'],
      correlated: [], pending: [], meta: { iid: 7, mr, title: 'Fix', url: issueOf().web_url } })
    h.store.set(KV.gitlab.stream(stream), { since: '2026-11-15T12:06:00Z', started: '2026-11-15T12:06:00Z' })
    api({ todos: [], issues: mr ? [] : [issueOf()], 'issues/7/notes': [noteOf()],
      merge_requests: mr ? [{ ...mrFixture, iid: 7 }] : [], 'merge_requests/7': { ...mrFixture, iid: 7 },
      'merge_requests/7/discussions': [{ id: 'review', notes: [noteOf()] }] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.text)).toContain('please look')
    h.store.close()
  })

  it('emits MR CI only for changed failures and waits for running jobs before recovery', async () => {
    const h = host()
    h.store.tickets.save(ticketOf({ follows: [{ thread: 'gitlab:mr:3', own: true }] }))
    let pipeline = { ...mrOf(), head_pipeline: { ...mrFixture.head_pipeline!, status: 'success' } }
    let jobs = [{ ...jobsFixture[0]!, id: 100, name: 'test', status: 'success' }]
    api({ todos: [], 'merge_requests/3': () => pipeline, 'pipelines/1180/jobs': () => jobs })
    await pollRound(h)
    for (const status of ['pending', 'running', 'success']) {
      jobs = [{ ...jobs[0]!, id: 101, status }]
      await pollRound(h)
    }
    expect(h.receive).not.toHaveBeenCalled()
    pipeline = { ...pipeline, head_pipeline: { ...pipeline.head_pipeline, status: 'failed' } }
    jobs = [{ ...jobs[0]!, status: 'failed' }]
    await pollRound(h)
    jobs = [{ ...jobs[0]!, id: 102 }]
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    pipeline = { ...pipeline, head_pipeline: { ...pipeline.head_pipeline, status: 'running' } }
    jobs = [{ ...jobs[0]!, status: 'running' }]
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    pipeline = { ...pipeline, head_pipeline: { ...pipeline.head_pipeline, status: 'success' } }
    jobs = [{ ...jobs[0]!, status: 'success' }]
    await pollRound(h)
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(h.receive.mock.calls[1]![0].text).toContain('CI passed')
    h.store.close()
  })
})


describe('P5 CI and independent polling', () => {
  const bound = () => {
    const h = host()
    h.store.tickets.save(ticketOf({ follows: [{ thread: 'gitlab:mr:3', own: true }] }))
    h.store.threads.save({ key: 'gitlab:mr:3', ref: { source: 'gitlab', id: 'mr:3' }, createdAt: '2026-11-15T12:00:00Z',
      subscriptions: ['t1'], correlated: [], pending: [], meta: { title: 'Fix', url: 'https://gitlab.test/p/-/merge_requests/3' } })
    return h
  }
  it.each(['mr', 'branch'])('retains %s failures through missing, waiting and new pipeline IDs until confirmed success', async kind => {
    const h = kind === 'mr' ? bound() : host()
    configure(h, { observeCi: kind === 'branch' })
    let pipeline: Record<string, unknown> | undefined = { id: 1180, status: 'success', sha: 'new-sha', ref: 'main' }
    let jobs = [{ id: 1, name: 'test', status: 'success' }]
    const reads = api({ todos: [], 'merge_requests/3': () => ({ ...mrFixture, iid: 3, sha: 'new-sha', head_pipeline: pipeline ?? null }),
      pipelines: () => pipeline ? [pipeline] : [], 'pipelines/1180/jobs': () => jobs, 'pipelines/1181/jobs': () => jobs,
      'merge_requests/3/discussions': [] })
    try {
      await pollRound(h) // baseline
      pipeline!.status = 'failed'; jobs[0]!.status = 'failed'
      await pollRound(h); await pollRound(h)
      expect(h.receive).toHaveBeenCalledTimes(1)
      const checkpoint = kind === 'mr' ? h.store.get(KV.gitlab.pipeline(3)) : h.store.get(KV.gitlab.branchPipeline)
      pipeline = undefined
      await pollRound(h)
      expect(kind === 'mr' ? h.store.get(KV.gitlab.pipeline(3)) : h.store.get(KV.gitlab.branchPipeline)).toEqual(checkpoint)
      pipeline = { id: 1181, status: 'failed', sha: 'another-sha', ref: 'main' }
      jobs = [{ id: 20, name: 'test', status: 'failed' }]
      await pollRound(h)
      expect(h.receive).toHaveBeenCalledTimes(1)
      for (const status of ['pending', 'running', 'manual', 'blocked', 'skipped']) {
        pipeline.status = status; jobs = []
        await pollRound(h)
        expect(h.receive).toHaveBeenCalledTimes(1)
      }
      pipeline.status = 'success'; jobs = [{ id: 30, name: 'test', status: 'success' }]
      await pollRound(h); await pollRound(h)
      expect(h.receive).toHaveBeenCalledTimes(2)
      expect(h.receive.mock.calls[1]![0].text).toContain('CI passed')
      const triggers = h.store.read.threadTriggers(kind === 'mr' ? 'gitlab:mr:3' : 'gitlab:ci:main', 20)
      expect(triggers).toHaveLength(2)
      expect(reads.some(path => /\/merge(?:\?|$)/.test(path))).toBe(false)
    } finally { h.store.close() }
  })

  it('keeps independent discovery and stream targets moving after one MR or note read fails', async () => {
    const h = host()
    h.store.tickets.save(ticketOf())
    h.store.tickets.save(ticketOf({ id: 't2', execution: execution('second') }))
    configure(h, { observeNotes: true })
    const since = '2026-11-15T11:00:00Z'
    h.store.set(KV.gitlab.stream('issues'), { since, started: since })
    const goodMr = { ...mrFixture, iid: 4, source_branch: 'agent/second', author: { username: 'agent' } }
    let fail = true
    api({ todos: [], merge_requests: [{ ...mrFixture, iid: 3, source_branch: 'agent/fix-margin', author: { username: 'agent' } }, goodMr],
      'merge_requests/3': () => fail ? new CliError('EOF', 503) : { ...goodMr, iid: 3, source_branch: 'agent/fix-margin' },
      'merge_requests/4': goodMr, 'pipelines/1180/jobs': jobsFixture,
      issues: [issueOf(), issueOf({ iid: 8 })],
      'issues/7/notes': () => fail ? new CliError('Forbidden', 403) : [noteOf()],
      'issues/8/notes': [noteOf({ id: 9002, body: 'independent' })] })
    try {
      await expect(pollRound(h)).rejects.toThrow('GitLab reads failed')
      expect(h.store.tickets.get('t2')!.follows).toContainEqual({ thread: 'gitlab:mr:4', own: true })
      expect(h.receive.mock.calls.some(([trigger]) => trigger.text === 'independent')).toBe(true)
      expect(h.store.get(KV.gitlab.cursor('issue', 7))).toBeUndefined()
      expect(h.store.get(KV.gitlab.stream('issues'))!.since).toBe(since)
      fail = false
      await pollRound(h)
      expect(h.store.get(KV.gitlab.cursor('issue', 7))).toBeDefined()
      expect(h.store.threads.get('gitlab:issue:7')?.meta.pollError).toBeUndefined()
      expect(h.store.tickets.get('t1')!.follows).toContainEqual({ thread: 'gitlab:mr:3', own: true })
    } finally { h.store.close() }
  })

  it('preserves nested 429 backoff while subscribed discussion reads still run', async () => {
    const h = bound()
    api({ todos: [], 'merge_requests/3': { ...mrFixture, iid: 3 },
      'pipelines/1180/jobs': new CliError('HTTP 429\nRetry-After: 123', 429), 'merge_requests/3/discussions': [] })
    try {
      await expect(pollRound(h)).rejects.toMatchObject({ code: 429, message: expect.stringContaining('Retry-After: 123') })
      expect(h.store.get(KV.gitlab.cursor('mr', 3))).toBeDefined()
      expect(h.store.get(KV.gitlab.pipeline(3))).toBeUndefined()
    } finally { h.store.close() }
  })

  it.each(['abort', 'disable'])('does not issue another request or move notes cursor after %s during an API read', async stop => {
    const h = host(), controller = new AbortController()
    api({ todos: [todoOf(7)], 'issues/7': issueOf(), 'issues/7/notes': () => {
      if (stop === 'abort') controller.abort(); else configure(h, {}, false)
      return []
    } })
    try {
      await pollRound(h, controller.signal)
      expect(h.store.get(KV.gitlab.cursor('issue', 7))).toBeUndefined()
      expect(h.health.gitlab?.state).not.toBe('ready')
      const calls = h.commands.glab as ReturnType<typeof vi.fn>
      expect(calls.mock.calls.some(([args]) => args.includes('POST'))).toBe(false)
    } finally { h.store.close() }
  })

  it.each([404, 410])('drops a deleted TODO target (%s) without closing an unrelated ticket', async status => {
    const h = host()
    h.store.tickets.save(ticketOf({ execution: undefined }))
    api({ todos: [todoOf(7)], 'issues/7': new CliError('Gone', status) })
    try {
      await pollRound(h)
      expect(h.store.get(KV.gitlab.retries)).toEqual({})
      expect(h.store.tickets.get('t1')!.ended).toBeUndefined()
    } finally { h.store.close() }
  })

  it('backs off for a nested rate limit, reaches the health threshold, then resets on success', async () => {
    vi.useFakeTimers()
    const h = host(), controller = new AbortController()
    configure(h, { observeCi: true, failuresBeforeError: 2 })
    let fail = true, polls = 0
    api({ todos: () => { polls++; return [] }, pipelines: () => fail ? new CliError('HTTP 429\nRetry-After: 120', 429) : [] })
    const running = watch(h, controller.signal)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(polls).toBe(1)
      expect(h.health.gitlab?.state).not.toBe('error')
      await vi.advanceTimersByTimeAsync(119000)
      expect(polls).toBe(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(polls).toBe(2)
      expect(h.health.gitlab).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '2' } })
      fail = false
      await vi.advanceTimersByTimeAsync(120000)
      expect(h.health.gitlab?.state).toBe('ready')
      await vi.advanceTimersByTimeAsync(60000)
      expect(polls).toBe(4)
    } finally { controller.abort(); await running; vi.useRealTimers(); h.store.close() }
  })
})

it('parses Retry-After seconds and HTTP dates, with a bounded fallback when absent or invalid', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-11-15T12:00:00Z'))
    expect(retryAfter(new CliError('HTTP 429\nRetry-After: 180', 429))).toBe(180)
    expect(retryAfter(new CliError('Retry-After: Sun, 15 Nov 2026 12:02:00 GMT', 429))).toBe(120)
    expect(retryAfter(new CliError('HTTP 429', 429))).toBe(300)
    expect(retryAfter(new CliError('Retry-After: bad', 429))).toBe(300)
    expect(retryAfter(new CliError('Forbidden', 403))).toBeUndefined()
  } finally { vi.useRealTimers() }
})

it('establishes a fresh CI baseline after the default branch changes', async () => {
  const h = host()
  configure(h, { observeCi: true })
  let failed = true
  api({ todos: [], pipelines: () => [{ id: 1, status: failed ? 'failed' : 'success', ref: h.deployment.project!.defaultBranch }],
    'pipelines/1/jobs': () => [{ id: 1, name: 'test', status: failed ? 'failed' : 'success' }] })
  const original = h.deployment.project!.defaultBranch
  try {
    await pollRound(h)
    h.deployment.project!.defaultBranch = 'trunk'
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    failed = false
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0].threads).toEqual([{ source: 'gitlab', id: 'ci:trunk' }])
  } finally { h.deployment.project!.defaultBranch = original; h.store.close() }
})

it.each([403, 404, 410])('keeps an unreadable MR (%s) live and its notes checkpoint unchanged', async code => {
  const h = host()
  h.store.tickets.save(ticketOf({ follows: [{ thread: 'gitlab:mr:3', own: true }] }))
  h.store.set(KV.gitlab.cursor('mr', 3), '2026-11-15T11:00:00Z')
  api({ todos: [], 'merge_requests/3': new CliError('Unavailable', code) })
  try {
    await expect(pollRound(h)).rejects.toThrow('GitLab reads failed')
    expect(h.store.tickets.get('t1')!.ended).toBeUndefined()
    expect(h.store.get(KV.gitlab.cursor('mr', 3))).toBe('2026-11-15T11:00:00Z')
  } finally { h.store.close() }
})

it.each([403, 404])('does not let unavailable approvals (%s) block notes, CI or merge lifecycle', async code => {
  const h = host()
  h.store.tickets.save(ticketOf({ follows: [{ thread: 'gitlab:mr:3', own: true }] }))
  h.store.threads.save({ key: 'gitlab:mr:3', ref: { source: 'gitlab', id: 'mr:3' }, createdAt: new Date().toISOString(), subscriptions: ['t1'], correlated: [], pending: [], meta: { title: 'MR', url: mrFixture.web_url } })
  let mr = { ...mrFixture, iid: 3 }
  const reads = api({ todos: [], 'merge_requests/3': () => mr, 'merge_requests/3/approvals': new CliError('Unavailable', code),
    'pipelines/1180/jobs': jobsFixture, 'merge_requests/3/discussions': [] })
  try {
    await pollRound(h)
    expect(h.store.threads.get('gitlab:mr:3')!.meta.facts).toMatchObject({ approvalsUnavailable: { value: { en: 'unavailable' } } })
    expect(h.store.get(KV.gitlab.pipeline(3))).toBeDefined()
    mr = { ...mr, state: 'merged', merged_at: new Date().toISOString() }
    await pollRound(h)
    expect(h.store.tickets.get('t1')!.ended?.outcome).toBe('merged')
    expect(reads.filter(path => path === 'merge_requests/3/approvals')).toHaveLength(1)
  } finally { h.store.close() }
})

it('does not recover from an old successful head pipeline after the MR SHA changes', async () => {
  const h = host()
  h.store.tickets.save(ticketOf({ follows: [{ thread: 'gitlab:mr:3', own: true }] }))
  h.store.set(KV.gitlab.pipeline(3), { fingerprint: '["test"]', revision: 1 })
  const reads = api({ todos: [], 'merge_requests/3': { ...mrFixture, iid: 3, sha: 'new-commit', head_pipeline: { id: 1180, sha: 'old-commit', status: 'success' } }, pipelines: [] })
  try {
    await pollRound(h)
    expect(h.store.get(KV.gitlab.pipeline(3))).toEqual({ fingerprint: '["test"]', revision: 1 })
    expect(h.receive).not.toHaveBeenCalled()
    expect(reads).toContain('pipelines?sha=new-commit&per_page=20&order_by=id&sort=desc')
    expect(reads).not.toContain('pipelines/1180/jobs?per_page=100')
  } finally { h.store.close() }
})

describe('review regressions: edited descriptions and stopping during body reads', () => {
  it.each([false, true])('accepts a new description mention on an old entity, MR=%s, preserving the editor and deduplicating TODOs', async mr => {
    const h = host()
    const now = new Date().toISOString()
    const url = `https://gitlab.example.com/tlcamp/human-resources/-/${mr ? 'merge_requests' : 'issues'}/7`
    const todo = todoOf(7, { action_name: 'mentioned', author: { username: 'pavel.evdokimov' }, target_type: mr ? 'MergeRequest' : 'Issue',
      target_url: url, body: '@agent fix the edited description', created_at: now })
    const entity = { ...(mr ? mrFixture : issueOf()), iid: 7, author: { username: 'original-author' },
      created_at: '2026-11-14T00:00:00Z', updated_at: now, description: '@agent a later different edit', web_url: url }
    api({ todos: [todo], [mr ? 'merge_requests/7' : 'issues/7']: entity, 'issues/7/notes': [], 'merge_requests/7/discussions': [] })
    try {
      await pollRound(h); await pollRound(h)
      expect(h.receive).toHaveBeenCalledTimes(1)
      const trigger = h.receive.mock.calls[0]![0]
      expect(trigger).toMatchObject({ actor: { id: 'pavel.evdokimov' }, human: true, addressed: 'mention', at: now, meta: { iid: 7, mr, todoId: todo.id } })
      if (mr) expect(trigger.meta.mrAuthor).toBe('original-author')
      expect(trigger.text).toContain(todo.body)
      expect(trigger.text).not.toContain('later different edit')
      expect(h.store.triggers.disposition(trigger.id)?.filtered).toBeUndefined()
    } finally { h.store.close() }
  })

  it.each([false, true])('accepts a description mention edited after creation when GitLab puts the title in TODO.body, MR=%s', async mr => {
    const h = host()
    const now = new Date().toISOString()
    const url = `https://gitlab.example.com/tlcamp/human-resources/-/${mr ? 'merge_requests' : 'issues'}/7`
    const title = 'Smoke: test'
    const todo = todoOf(7, { action_name: 'mentioned', author: { username: 'pavel.evdokimov' }, target_type: mr ? 'MergeRequest' : 'Issue',
      target_url: url, body: title, created_at: now })
    const entity = { ...(mr ? mrFixture : issueOf()), iid: 7, title, author: { username: 'original-author' },
      created_at: '2026-11-16T08:47:35Z', updated_at: now, description: '@agent добавь строчку и создай MR', web_url: url }
    api({ todos: [todo], [mr ? 'merge_requests/7' : 'issues/7']: entity, 'issues/7/notes': [], 'merge_requests/7/discussions': [] })
    try {
      await pollRound(h); await pollRound(h)
      expect(h.receive).toHaveBeenCalledTimes(1)
      const trigger = h.receive.mock.calls[0]![0]
      expect(trigger).toMatchObject({ actor: { id: 'pavel.evdokimov' }, human: true, addressed: 'mention', at: now, meta: { iid: 7, mr, todoId: todo.id } })
      expect(trigger.text).toContain('добавь строчку')
      expect(h.store.triggers.disposition(trigger.id)?.filtered).toBeUndefined()
    } finally { h.store.close() }
  })

  it("never borrows the Issue author's authority for a body mention by an unlisted editor", async () => {
    const h = host(), now = new Date().toISOString()
    api({ todos: [todoOf(7, { action_name: 'mentioned', author: { username: 'outsider' }, target_url: issueOf().web_url, created_at: now })],
      'issues/7': issueOf({ created_at: '2026-11-14T00:00:00Z', updated_at: now }), 'issues/7/notes': [] })
    try {
      await pollRound(h)
      const trigger = h.receive.mock.calls[0]![0]
      expect(trigger.actor.id).toBe('outsider')
      expect(h.engine.candidate(trigger.id)).toBeUndefined()
      expect(h.store.tickets.open()).toEqual([])
    } finally { h.store.close() }
  })

  it('retains the body-mention TODO across a failed read even if it disappears from the next TODO list', async () => {
    const h = host(), now = new Date().toISOString()
    let fail = true
    const todo = todoOf(7, { action_name: 'mentioned', author: { username: 'pavel.evdokimov' }, target_url: issueOf().web_url, created_at: now })
    api({ todos: () => fail ? [todo] : [], 'issues/7': () => fail ? new CliError('EOF', 503) : issueOf({ created_at: '2026-11-14T00:00:00Z', updated_at: now }), 'issues/7/notes': [] })
    try {
      await expect(pollRound(h)).rejects.toThrow('GitLab reads failed')
      expect(h.store.get(KV.gitlab.retries)?.['issue:7']?.todos).toHaveLength(1)
      fail = false
      await pollRound(h); await pollRound(h)
      expect(h.receive).toHaveBeenCalledTimes(1)
      expect(h.receive.mock.calls[0]![0].actor.id).toBe('pavel.evdokimov')
      expect(h.store.get(KV.gitlab.retries)).toEqual({})
    } finally { h.store.close() }
  })

  it.each([{ mr: false, stream: false }, { mr: true, stream: false }, { mr: false, stream: true }, { mr: true, stream: true }])(
    'does not filter away a body when disabled during its read, MR=$mr stream=$stream', async ({ mr, stream }) => {
      const h = host(), now = new Date().toISOString()
      let stop = true
      configure(h, { observeIssues: stream, observeMergeRequests: stream })
      const streamKey = KV.gitlab.stream(mr ? 'mergeRequests' : 'issues')
      h.store.set(streamKey, { since: '2026-11-15T00:00:00Z', started: '2026-11-15T00:00:00Z' })
      const entity = { ...(mr ? mrFixture : issueOf()), iid: 7, author: { username: 'pavel.evdokimov' }, created_at: now, updated_at: now }
      const stoppingRead = () => { if (stop) { configure(h, {}, false); stop = false }; return entity }
      api({ todos: stream ? [] : [todoOf(7, { target_type: mr ? 'MergeRequest' : 'Issue', created_at: now })],
        issues: !mr && stream ? () => [stoppingRead()] : [], merge_requests: mr && stream ? [entity] : [],
        [mr ? 'merge_requests/7' : 'issues/7']: stoppingRead,
        'issues/7/notes': [], 'merge_requests/7/discussions': [] })
      try {
        await pollRound(h)
        expect(h.receive).not.toHaveBeenCalled()
        expect(h.store.get(KV.gitlab.cursor(mr ? 'mr' : 'issue', 7))).toBeUndefined()
        configure(h, {}, true)
        await pollRound(h)
        expect(h.receive).toHaveBeenCalledTimes(1)
        const trigger = h.receive.mock.calls[0]![0]
        expect(h.store.triggers.disposition(trigger.id)?.filtered).toBeUndefined()
      } finally { h.store.close() }
    })
})

it('distinguishes a second body-mention TODO by the same author on a recently created Issue', async () => {
  const h = host(), born = new Date().toISOString()
  let todos = [todoOf(7, { author: { username: 'pavel.evdokimov' }, action_name: 'mentioned', target_url: issueOf().web_url, created_at: born, body: '@agent first request' })]
  api({ todos: () => todos, 'issues/7': () => issueOf({ created_at: born, updated_at: todos.at(-1)!.created_at, description: todos.at(-1)!.body }), 'issues/7/notes': [] })
  try {
    await pollRound(h)
    todos = [...todos, todoOf(7, { id: 901, author: { username: 'pavel.evdokimov' }, action_name: 'mentioned', target_url: issueOf().web_url,
      created_at: new Date(Date.parse(born) + 30000).toISOString(), body: '@agent second request' })]
    await pollRound(h); await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.actor.id)).toEqual(['pavel.evdokimov', 'pavel.evdokimov'])
    expect(h.receive.mock.calls[0]![0].id).not.toBe(h.receive.mock.calls[1]![0].id)
    expect(h.receive.mock.calls[1]![0].text).toContain('second request')
  } finally { h.store.close() }
})
