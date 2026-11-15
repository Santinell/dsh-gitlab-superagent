/** P3 model-facing GitLab workflow through real Runtime tools and persistence. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Commands, CliError } from '../src/infra/commands.ts'
import { NoteSchema, noteTrigger, IssueSchema, issueTrigger, MergeRequestSchema, mrTrigger } from '../src/sources/gitlab-trigger.ts'
import { defaultPrompts } from '../src/app/prompts.ts'
import { bundledSkills } from '../src/app/skill-files.ts'
import { ticketEnvironment } from '../src/app/execution-environment.ts'
import { admissionContext } from '../src/sources/admission-context.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime(undefined, { gitlab: true }) })
afterEach(async () => { await h.stop() })
const at = '2026-11-15T12:00:00Z'
const page = (iid: number, mr = false) => `https://gitlab.example.com/acme/widgets/-/${mr ? 'merge_requests' : 'issues'}/${iid}`
const note = (id: number, body = '@agent-bot please fix') => NoteSchema.parse({ id, body, author: { username: 'alice' }, created_at: at })
const request = (iid = 7, mr = false) => noteTrigger(note(iid), { iid, mr, url: page(iid, mr), ...(mr ? { discussionId: 'review' } : {}) }, 'agent-bot')!
const issue = (iid = 7) => IssueSchema.parse({ id: 90, iid, title: 'Fix', description: 'Please fix', author: { username: 'alice' }, state: 'opened', web_url: page(iid), created_at: at })
const read = (session: string, resource: string, extra = {}) => h.runTool(session, 'orchestrator_read', { resource, ...extra })
const body = (result: Record<string, unknown>) => JSON.parse(result.text as string)

it('acknowledges the originating discussion once, reports an MR idempotently and recovers its environment after restart', async () => {
  const glab = vi.mocked(Commands.prototype.glab)
  const original = glab.getMockImplementation()!
  glab.mockImplementation(async args => args[1]?.endsWith('/discussions/review') ? { id: 'review', notes: [] }
    : args[1]?.includes('/discussions?') ? [{ id: 'review', notes: [note(7)] }] : original(args))
  const { ticket, trigger, sessionId } = await h.acceptedTicket(request(7, true))
  expect(body(await read(sessionId, 'gitlab/merge_requests/7/discussions/1'))).toMatchObject({ messages: [{ discussionId: 'review', from: 'alice' }] })
  await h.runTool(sessionId, 'orchestrator_ack', { trigger_id: trigger.id, text: 'I will check this regression.' })
  await h.runTool(sessionId, 'orchestrator_ack', { trigger_id: trigger.id, text: 'I will check this regression.' })
  const posts = glab.mock.calls.filter(([args]) => args[1]?.endsWith('/discussions/review/notes') && args.includes('POST'))
  expect(posts).toHaveLength(1)
  expect(posts[0]![0][1]).toBe('projects/25/merge_requests/7/discussions/review/notes')
  for (let i = 0; i < 2; i++) await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'MR open', mr_iid: 42 })
  expect(h.runtime.store.tickets.get(ticket.id)!.follows?.filter(f => f.thread === 'gitlab:mr:42')).toHaveLength(1)
  await h.runTool(sessionId, 'orchestrator_thread_follow', { thread: 'gitlab:issue:9', reason: 'Related context' })
  expect(h.runtime.store.threads.get('gitlab:issue:9')).toMatchObject({ ref: { source: 'gitlab', id: 'issue:9' }, context: [ticket.id] })
  const before = h.runtime.ticketEnvironment(h.runtime.store.tickets.get(ticket.id)!)
  expect(before.some(v => /GITHUB|FEISHU/.test(v.key))).toBe(false)
  const stored = h.runtime.store.tickets.get(ticket.id)!
  // Restart reopens the same database and resumes the persisted Assignment.
  const resumed = await h.restart()
  await resumed.idle()
  const recovered = resumed.store.tickets.get(ticket.id)!
  expect(recovered.execution?.name).toBe(stored.execution?.name)
  expect(recovered.follows).toEqual(stored.follows)
  expect(resumed.ticketEnvironment(recovered)).toEqual(before)
  expect(recovered.inputs.some(input => input.kind === 'text' && input.text.includes('GitLab state'))).toBe(true)
  expect(vi.mocked(Commands.prototype.gh)).not.toHaveBeenCalled()
})

it('claims a source MR by another author and rejects an MR already owned by another ticket atomically', async () => {
  const first = await h.acceptedTicket(request(7, true))
  const entity = { iid: 7, title: 'Existing', state: 'opened', author: { username: 'someone' }, source_branch: 'unrelated', created_at: at, web_url: page(7, true) }
  vi.mocked(Commands.prototype.glab).mockResolvedValue(entity)
  await h.runTool(first.sessionId, 'orchestrator_report', { state: 'progress', summary: 'Adopted', mr_iid: 7 })
  const second = await h.acceptedTicket({ ...request(8), id: 'second-request' })
  // Both may receive the same source MR, but only one live ticket may bind it.
  h.runtime.store.triggers.save({ ...request(7, true), id: second.ticket.origin.triggerId })
  const before = h.runtime.store.tickets.get(second.ticket.id)!
  const relays = h.runtime.effects.pending('relay')
  await expect(h.runTool(second.sessionId, 'orchestrator_report', { state: 'progress', summary: 'Conflicting', mr_iid: 7, human_action: 'Which task?' })).rejects.toThrow('another active ticket')
  expect(h.runtime.store.tickets.get(second.ticket.id)).toEqual(before)
  expect(h.runtime.effects.pending('relay')).toBe(relays)
})

it('reads descriptions, paginated notes, discussions and pipeline jobs with per-session snapshots and error propagation', async () => {
  const { sessionId, ticket } = await h.acceptedTicket(request())
  const glab = vi.mocked(Commands.prototype.glab)
  glab.mockImplementation(async args => {
    const path = args[1]!
    if (path === 'projects/25/issues/7') return issue()
    if (path.includes('/notes?')) return path.includes('page=2') ? [] : Array.from({ length: 100 }, (_, id) => note(id, id === 0 ? 'old text' : 'context'))
    if (path.includes('/discussions?')) return [{ id: 'review', notes: [
      { ...note(1), position: { new_path: 'src/index.ts', new_line: 4 } }, note(2, 'reply'), { ...note(3), system: true },
    ] }]
    if (path === 'projects/25/merge_requests/7') return MergeRequestSchema.parse({ ...issue(), source_branch: 'fix', head_pipeline: { id: 9, status: 'failed' } })
    return []
  })
  const commands = vi.mocked(Commands.prototype.run)
  commands.mockImplementation(async (_program, args) => args[1]?.includes('/jobs') ? JSON.stringify({ id: 1, name: 'test', status: 'failed' }) : '')
  expect(body(await read(sessionId, 'gitlab/issues/7', { limit: 8000 }))).toMatchObject({ iid: 7, title: 'Fix' })
  const resource = 'gitlab/issues/7/notes/1'
  const first = await read(sessionId, resource, { limit: 100 })
  const start = glab.mock.calls.length
  expect(first.next_offset).toBe(100)
  await read(sessionId, resource, { offset: 100 })
  expect(glab.mock.calls).toHaveLength(start)
  await expect(read(h.runtime.masterId, resource, { offset: 100 })).rejects.toThrow('offset 0 first')
  let text = first.text as string, offset = first.next_offset as number | null
  while (offset !== null) { const next = await read(sessionId, resource, { offset, limit: 8000 }); text += next.text; offset = next.next_offset as number | null }
  expect(JSON.parse(text).next_resource).toBe('gitlab/issues/7/notes/2')
  expect(body(await read(sessionId, 'gitlab/issues/7/notes/2'))).toEqual({ messages: [] })
  const messages = body(await read(sessionId, 'gitlab/merge_requests/7/discussions/1', { limit: 8000 })).messages
  expect(messages).toHaveLength(2)
  expect(messages[0]).toMatchObject({ path: 'src/index.ts', line: 4, discussionId: 'review' })
  expect(messages[1].reply_to).toBe(messages[0].id)
  expect(body(await read(sessionId, 'gitlab/merge_requests/7/pipelines'))).toMatchObject({ pipeline: { id: 9 }, jobs: [{ name: 'test' }] })
  expect(body(await read(h.runtime.masterId, 'gitlab/pipelines/9/jobs'))).toMatchObject({ jobs: [{ name: 'test' }] })
  const other = await h.acceptedTicket({ ...request(8), id: 'other-request' })
  await expect(read(sessionId, `ticket/${other.ticket.id}`)).rejects.toThrow()
  await expect(read(sessionId, `trigger/${other.trigger.id}`)).rejects.toThrow()
  expect(await read(sessionId, `ticket/${ticket.id}/assignment`)).toHaveProperty('text')
  for (const code of [403, 404]) {
    glab.mockRejectedValueOnce(new CliError('Unavailable', code))
    await expect(read(sessionId, 'gitlab/issues/7')).rejects.toMatchObject({ code })
  }
  expect(glab.mock.calls.every(([args]) => args[1]?.startsWith('projects/25/'))).toBe(true)
  expect(vi.mocked(Commands.prototype.gh)).not.toHaveBeenCalled()
})

it('loads the GitLab skill and current prompt defaults without old built-ins, while preserving user overrides and their base', () => {
  expect(bundledSkills.gitlab.name).toBe('dsh-superagent-gitlab')
  const text = h.runtime.prompts.preview(defaultPrompts())
  expect(Object.keys(text.skills)).toEqual(['gitlab'])
  for (const content of [text.worker, text.orchestrator, text.skills.gitlab]) {
    expect(content).not.toMatch(/github|feishu|lark-cli|\bgh\b/i)
  }
  expect(text.worker).toContain('Never merge an MR or enable auto-merge')
  const config = { ...defaultPrompts(), overrides: { 'skill/gitlab': { text: 'Our GitLab workflow.', base: 'earlier' } } }
  h.runtime.prompts.save(config, 0, 'panel')
  expect(h.runtime.prompts.preview(config).skills.gitlab).toBe('Our GitLab workflow.')
  expect(h.runtime.prompts.defaultChanged(config)).toContainEqual({ part: 'skill/gitlab', base: 'earlier' })
  expect(h.runtime.prompts.current().config).toEqual(config)
})

it('exposes the right IID and source branch for issue, MR and note origins, and neither for other sources', async () => {
  const { ticket } = await h.acceptedTicket(request())
  const origins = [
    issueTrigger(issue(), 'agent-bot'),
    mrTrigger(MergeRequestSchema.parse({ ...issue(), source_branch: 'feature/original' }), 'agent-bot'),
    request(7, true),
    { ...request(), source: 'other', threads: [{ source: 'other', id: '7' }] },
  ]
  for (const [index, trigger] of origins.entries()) {
    const env = ticketEnvironment({ deployment: h.runtime.deployment, sources: h.runtime.sources, settings: h.runtime.store.settings(), ticket, trigger })
    const values = Object.fromEntries(env.map(v => [v.key, v.value]))
    expect(values.DSH_SUPERAGENT_GITLAB_PROJECT).toBe('acme/widgets')
    expect(values.DSH_SUPERAGENT_GITLAB_ACCOUNT).toBe('agent-bot')
    expect(values.DSH_SUPERAGENT_GITLAB_IID).toBe(index === 3 ? '' : '7')
    expect(values.DSH_SUPERAGENT_GITLAB_MR_SOURCE_BRANCH).toBe(index === 1 ? 'feature/original' : '')
    expect(values.DSH_SUPERAGENT_NAME).toBe(ticket.execution!.name)
  }
})

it('gives admission the GitLab description and paginated context with system notes filtered', async () => {
  vi.mocked(Commands.prototype.glab).mockImplementation(async args => args[1] === 'projects/25/issues/7' ? issue() : [note(7), { ...note(2), system: true }])
  const trigger = request()
  const result = await admissionContext(h.runtime.sources.threadContext(trigger)!, h.runtime.commands, 2)
  expect(result.complete).toBe(true)
  expect(result.messages).toHaveLength(2)
  expect(result.window.source_found).toBe(true)
})

it('delivers CI failure/recovery once for MR and default branch, exposes approvals/jobs and retains checkpoints after restart', async () => {
  const { pollRound } = await import('../src/sources/gitlab.ts')
  const { KV } = await import('../src/kv.ts')
  const { threadDetail } = await import('../src/app/views/threads.ts')
  const { gitlabLink } = await import('../src/sources/gitlab-channel.ts')
  const { ticket, sessionId } = await h.acceptedTicket(request())
  const store = h.runtime.store
  const settings = store.settings()
  store.saveSettings({ ...settings, sources: { ...settings.sources, gitlab: { ...settings.sources.gitlab!, config: { ...settings.sources.gitlab!.config, observeCi: true } } } })
  let status = 'success', approved = true, closed = false
  const glab = vi.mocked(Commands.prototype.glab), original = glab.getMockImplementation()!
  glab.mockImplementation(async args => {
    const path = args[1]!
    if (path === 'projects/25/issues/7') return issue()
    if (path.endsWith('/approvals')) return { approved, approved_by: approved ? [{ user: { username: 'alice' } }] : [] }
    if (path === 'projects/25/merge_requests/42') return MergeRequestSchema.parse({ ...issue(42), source_branch: `feature/${ticket.execution!.name}`,
      source_project_id: 25, target_project_id: 25, author: { username: 'agent-bot' }, sha: 'abc', detailed_merge_status: 'mergeable',
      merge_when_pipeline_succeeds: true, state: closed ? 'merged' : 'opened', merged_at: closed ? new Date(Date.now() + 1000).toISOString() : null,
      head_pipeline: { id: 901, status, sha: 'abc' } })
    return original(args)
  })
  const run = vi.mocked(Commands.prototype.run), originalRun = run.getMockImplementation()!
  run.mockImplementation(async (program, args) => {
    const path = args[1] ?? ''
    if (path === 'todos?project_id=25&state=pending&per_page=100') return ''
    if (path.startsWith('projects/25/pipelines?')) return JSON.stringify({ id: 900, status, sha: 'abc', ref: 'main' })
    if (/projects\/25\/pipelines\/90[01]\/jobs/.test(path)) return JSON.stringify({ id: 1, name: 'test', status })
    if (path.includes('/discussions?')) return ''
    return originalRun(program, args)
  })
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'MR open', mr_iid: 42 })
  await pollRound(h.runtime.context(gitlabKind))
  status = 'failed'
  await pollRound(h.runtime.context(gitlabKind)); await pollRound(h.runtime.context(gitlabKind))
  const failures = store.read.threadTriggers('gitlab:mr:42', 50).filter(trigger => trigger.meta.ci === true)
  expect(failures).toHaveLength(1)
  for (const session of [sessionId, h.runtime.masterId]) {
    expect(body(await read(session, 'gitlab/pipelines/901/jobs'))).toMatchObject({ jobs: [{ name: 'test', status: 'failed' }] })
    expect(body(await read(session, 'gitlab/merge_requests/42/approvals'))).toEqual({ available: true, approved: true, approved_by: ['alice'] })
  }
  const projected = threadDetail({ store, sources: h.runtime.sources, links: channel => gitlabLink(channel.address, {}) }, 'gitlab:mr:42', undefined, 50)!
  expect(projected.facts).toMatchObject({ approvals: { value: '@alice' }, approved: { value: { en: 'yes' } }, autoMerge: { value: { en: 'on' } }, ci: { problem: true } })
  const checkpoint = store.get(KV.gitlab.pipeline(42))
  const resumed = await h.restart()
  await resumed.idle()
  expect(resumed.store.get(KV.gitlab.pipeline(42))).toEqual(checkpoint)
  await pollRound(resumed.context(gitlabKind))
  expect(resumed.store.read.threadTriggers('gitlab:mr:42', 50).filter(trigger => trigger.meta.ci === true)).toHaveLength(1)
  status = 'running'; approved = false
  await pollRound(resumed.context(gitlabKind))
  status = 'success'
  await pollRound(resumed.context(gitlabKind)); await pollRound(resumed.context(gitlabKind))
  for (const thread of ['gitlab:mr:42', 'gitlab:ci:main']) {
    expect(resumed.store.read.threadTriggers(thread, 50).filter(trigger => trigger.meta.ci === true)).toHaveLength(2)
  }
  expect(resumed.store.threads.get('gitlab:mr:42')!.meta.facts).toMatchObject({ approvals: { value: { en: 'none' } }, approved: { value: { en: 'no' } } })
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Verified; waiting for human merge' })
  closed = true
  await pollRound(resumed.context(gitlabKind)); await pollRound(resumed.context(gitlabKind))
  expect(resumed.store.tickets.get(ticket.id)!.ended?.outcome).toBe('merged')
  expect(resumed.store.tickets.get(ticket.id)!.assignments.at(-1)?.state).toBe('ended')
  expect(glab.mock.calls.some(([args]) => args.includes('PUT') || args.some(arg => /\/merge(?:\?|$)/.test(arg)))).toBe(false)
})

it('rejects an actual schema-11 GitHub state before writable startup and releases its lock after refusal', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { mkdtempSync, readFileSync, rmSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Runtime } = await import('../src/app/runtime.ts')
  const { Store } = await import('../src/app/store.ts')
  const { SettingsSchema } = await import('../src/policy.ts')
  const { testMachine } = await import('./fixtures/deployment.ts')
  const directory = mkdtempSync(join(tmpdir(), 'reject-old-github-runtime-'))
  try {
    const path = join(directory, 'orchestrator.sqlite')
    const store = new Store(path)
    store.saveSettings(SettingsSchema.parse({ sources: { github: { enabled: false, config: { repository: 'g/p', cli: '/bin/false' } } } }))
    store.close()
    const before = readFileSync(path)
    // No legacy-fixture allowance for this path: exercise the real production gate twice.
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => new Runtime(new Context(), testMachine({ stateDir: directory }), vi.fn())).toThrow(/GitHub installation.*new state directory/)
      expect(readFileSync(path)).toEqual(before)
      expect(existsSync(join(directory, 'worker-bin'))).toBe(false)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
