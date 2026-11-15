import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ChannelRef } from '../src/core/index.ts'
import { MergeRequestSchema, mrTrigger } from '../src/sources/gitlab-trigger.ts'
import { agentMr, claimMr, mrEndNotices, mrOf, mrsOf, observeMr, observeApprovals, ticketBranch } from '../src/sources/gitlab-mr.ts'
import { execution, gitlabHost, ticketOf } from './fixtures/gitlab-host.ts'

const fixture = MergeRequestSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/gitlab/entities/merge-request.json'), 'utf8')))
const mergeRequest = (overrides: Record<string, unknown> = {}) => MergeRequestSchema.parse({ ...fixture, ...overrides })
const agent = (overrides: Record<string, unknown> = {}) => mergeRequest({ author: { id: 7, username: 'agent', state: 'active' },
  source_branch: 'agent/fix-margin', source_project_id: 25, target_project_id: 25, ...overrides })

it('binds the source merge request, and an agent MR whose branch ends with the ticket name', async () => {
  const h = gitlabHost()
  const source = mrTrigger(mergeRequest(), 'agent')
  h.store.triggers.save(source)
  h.store.tickets.save(ticketOf({ origin: { triggerId: source.id, triggerIds: [source.id] } }))
  expect(claimMr(h, 't1', mergeRequest())).toBeUndefined()
  expect(h.store.tickets.get('t1')).toMatchObject({ follows: [{ thread: 'gitlab:mr:1', own: false }] })
  expect(h.store.threads.get('gitlab:mr:1')?.meta).toMatchObject({ iid: 1, mr: true, title: fixture.title })
  // An MR on the ticket's branch, opened by the agent account in the same project, binds as its own.
  h.store.tickets.save(ticketOf({ id: 't2', origin: { triggerId: 'other', triggerIds: [] }, execution: execution('fix-margin') }))
  const own = agent({ iid: 2, web_url: 'https://gitlab.example.com/tlcamp/human-resources/-/merge_requests/2' })
  expect(claimMr(h, 't2', own)).toBeUndefined()
  expect(h.store.tickets.get('t2')).toMatchObject({ follows: [{ thread: 'gitlab:mr:2', own: true }] })
  h.store.close()
})

it('refuses a foreign MR, an MR from a fork, and a branch without the ticket name', async () => {
  const h = gitlabHost()
  h.store.tickets.save(ticketOf({ id: 't1', origin: { triggerId: 'other', triggerIds: [] }, execution: execution('fix-margin') }))
  expect(claimMr(h, 't1', agent({ author: { id: 9, username: 'carol', state: 'active' } }))).toMatch(/does not belong/)
  expect(claimMr(h, 't1', agent({ source_branch: 'feature/another-name' }))).toMatch(/does not belong/)
  expect(claimMr(h, 't1', agent({ source_project_id: 99 }))).toMatch(/does not belong/)
  expect(agentMr(agent(), h.deployment)).toBe(true)
  expect(agentMr(agent({ source_project_id: 99 }), h.deployment)).toBe(false)
  expect(agentMr(agent({ source_project_id: null }), h.deployment)).toBe(false)
  expect(agentMr(agent({ target_project_id: null }), h.deployment)).toBe(false)
  expect(ticketBranch({ execution: execution('fix-margin') }, 'agent/fix-margin')).toBe(true)
  expect(ticketBranch({ execution: execution('fix-margin') }, 'fix-margin-2')).toBe(false)
  expect(h.store.tickets.get('t1')!.follows).toBeUndefined()
  h.store.close()
})

it('binds one MR to at most one active ticket and keeps the first MR a ticket follows', async () => {
  const h = gitlabHost()
  h.store.tickets.save(ticketOf({ id: 't1', origin: { triggerId: 'x', triggerIds: [] } }))
  h.store.tickets.save(ticketOf({ id: 't2', origin: { triggerId: 'y', triggerIds: [] }, execution: execution('fix-margin') }))
  expect(claimMr(h, 't1', agent())).toBeUndefined()
  expect(claimMr(h, 't2', agent())).toBe('MR already belongs to another active ticket')
  expect(mrOf(h.store.tickets.get('t1')!)).toBe(1)
  expect(mrsOf(h.store.tickets.get('t1')!)).toEqual([1])
  h.store.close()
})

it('ends a ticket once when its MR merges, and reports close and locked as closed', async () => {
  const h = gitlabHost()
  h.store.tickets.save(ticketOf({ id: 't1', origin: { triggerId: 'x', triggerIds: [] }, follows: [{ thread: 'gitlab:mr:9', own: true }] }))
  h.store.threads.save({ key: 'gitlab:mr:9', ref: { source: 'gitlab', id: '9' }, createdAt: '', subscriptions: ['t1'], correlated: [], pending: [], meta: {} })
  const merged = mergeRequest({ iid: 9, state: 'merged', merged_at: '2026-09-02T00:00:00Z', web_url: 'https://gitlab.example.com/p/-/merge_requests/9' })
  expect(await observeMr(h, merged)).toBe(true)
  expect(h.store.tickets.get('t1')).toMatchObject({ ended: { by: 'executor', outcome: 'merged', at: '2026-09-02T00:00:00.000Z' } })
  const first = h.store.tickets.get('t1')!.ended!.at
  expect(await observeMr(h, merged)).toBe(true)
  expect(h.store.tickets.get('t1')!.ended!.at).toBe(first)
  // `locked` is a closed merge request too; a resumed ticket works on and ends once its work reports ready.
  h.store.tickets.save({ ...h.store.tickets.get('t1')!, ended: undefined, follows: [{ thread: 'gitlab:mr:10', own: true }],
    assignments: [...h.store.tickets.get('t1')!.assignments, { id: 'a2', state: 'pending', createdAt: '2026-09-03T00:00:00Z' }] })
  expect(await observeMr(h, mergeRequest({ iid: 10, state: 'locked', closed_at: '2026-09-02T00:00:00Z' }))).toBe(true)
  expect(h.store.tickets.get('t1')!.ended).toBeUndefined()
  h.store.close()
})

it('reports auto-merge and detailed merge status as facts without merging or enabling anything', async () => {
  const h = gitlabHost()
  h.store.tickets.save(ticketOf({ id: 't1', origin: { triggerId: 'x', triggerIds: [] }, execution: execution('fix-margin') }))
  const run = vi.spyOn(h.commands, 'run')
  expect(await observeMr(h, agent({ merge_when_pipeline_succeeds: true, detailed_merge_status: 'mergeable' }))).toBe(false)
  expect(h.store.threads.get('gitlab:mr:1')!.meta.facts).toMatchObject({
    autoMerge: { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } },
    mergeStatus: { label: { zh: '合并状态', en: 'Merge status' }, value: 'mergeable' } })
  // Observing may read, but never posts, merges, or enables auto-merge.
  expect(run).not.toHaveBeenCalled()
  expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'gitlab:mr:1', own: true }])
  h.store.close()
})

it('writes terminal notices for other channels only, in the request\'s language, with a stable ID', async () => {
  const h = gitlabHost()
  const channels: ChannelRef[] = [{ source: 'gitlab', thread: 'gitlab:mr:9', address: { iid: '9', mr: 'true' } },
    { source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } }]
  h.store.tickets.save(ticketOf({ id: 't1', channels, follows: [{ thread: 'gitlab:mr:9', own: true, closed: { at: '2026-09-02T00:00:00Z', outcome: 'merged' } }],
    ended: { at: '2026-09-02T00:00:00Z', by: 'executor', outcome: 'merged' } }))
  const notices = mrEndNotices(h.store.tickets.get('t1')!, 'fix the margin', 'https://gitlab.example.com/tlcamp/human-resources')
  expect(notices).toEqual([expect.objectContaining({ kind: 'notice', channel: expect.objectContaining({ source: 'feishu' }),
    text: '[MR !9](https://gitlab.example.com/tlcamp/human-resources/-/merge_requests/9) has merged.' })])
  expect(mrEndNotices(h.store.tickets.get('t1')!, 'fix the margin', 'https://gitlab.example.com/tlcamp/human-resources').map(notice => notice.id))
    .toEqual(notices.map(notice => notice.id))
  h.store.tickets.save({ ...h.store.tickets.get('t1')!, ended: { at: '2026-09-02T00:00:00Z', by: 'executor', outcome: 'closed' } })
  expect(mrEndNotices(h.store.tickets.get('t1')!, '修一下', 'https://gitlab.example.com/tlcamp/human-resources')[0]!.text)
    .toBe('[MR !9](https://gitlab.example.com/tlcamp/human-resources/-/merge_requests/9) 已关闭，未合并。')
  h.store.close()
})

it('updates and clears approval facts independently of merge lifecycle', async () => {
  const h = gitlabHost()
  try {
    h.store.tickets.save(ticketOf())
    await observeMr(h, agent({ auto_merge_enabled: true, merge_when_pipeline_succeeds: null }))
    observeApprovals(h, 1, { available: true, approved: true, approved_by: ['alice'] })
    expect(h.store.threads.get('gitlab:mr:1')!.meta.facts).toMatchObject({ approvals: { value: '@alice' }, approved: { value: { en: 'yes' } }, autoMerge: { value: { en: 'on' } } })
    observeApprovals(h, 1, { available: true, approved: false, approved_by: [] })
    expect(h.store.threads.get('gitlab:mr:1')!.meta.facts).toMatchObject({ approvals: { value: { en: 'none' } }, approved: { value: { en: 'no' } } })
    observeApprovals(h, 1, { available: false, status: 403 })
    const facts = h.store.threads.get('gitlab:mr:1')!.meta.facts as Record<string, unknown>
    expect(facts.approvals).toBeUndefined()
    expect(facts.approved).toBeUndefined()
    expect(facts.approvalsUnavailable).toBeTruthy()
    await observeMr(h, agent({ auto_merge_enabled: false, merge_when_pipeline_succeeds: true, detailed_merge_status: null }))
    expect(h.store.threads.get('gitlab:mr:1')!.meta.facts).not.toHaveProperty('autoMerge')
    expect(h.store.tickets.get('t1')!.ended).toBeUndefined()
    await observeMr(h, agent({ state: 'closed', closed_at: '2026-11-15T12:30:00Z' }))
    const ended = h.store.tickets.get('t1')!.ended
    expect(ended?.outcome).toBe('closed')
    await observeMr(h, agent({ state: 'opened' }))
    expect(h.store.tickets.get('t1')!.ended).toEqual(ended)
  } finally { h.store.close() }
})

it('treats a locked discussion as open and rejects a foreign target project', async () => {
  const h = gitlabHost()
  try {
    h.store.tickets.save(ticketOf())
    expect(await observeMr(h, agent({ discussion_locked: true }))).toBe(false)
    expect(h.store.tickets.get('t1')!.ended).toBeUndefined()
    expect(claimMr(h, 't1', agent({ target_project_id: 99 }))).toContain('another project')
    await observeMr(h, agent({ state: 'merged', target_project_id: 99 }))
    expect(h.store.tickets.get('t1')!.ended).toBeUndefined()
  } finally { h.store.close() }
})
