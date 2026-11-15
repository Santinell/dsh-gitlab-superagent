/** In-memory SourceContext fixture for the GitLab Source: a real Store, SourceRegistry, HealthBoard, and Engine with stub ports. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Assessor, Executor, Ticket, Trigger } from '../../src/core/index.ts'
import { Engine } from '../../src/core/index.ts'
import { Store } from '../../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../../src/app/source-context.ts'
import { Commands } from '../../src/infra/commands.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../../src/policy.ts'
import { SourceRegistry } from '../../src/sources/registry.ts'
import { gitlabKind } from '../../src/sources/gitlab.ts'
import { testDeployment } from './deployment.ts'

export const PROJECT = { id: 25, path: 'tlcamp/human-resources', webUrl: 'https://gitlab.example.com/tlcamp/human-resources',
  defaultBranch: 'main' }
export const CODE_HOST = { kind: 'gitlab' as const, host: 'gitlab.example.com', apiBase: 'https://gitlab.example.com/api/v4',
  webBase: 'https://gitlab.example.com', cli: '/bin/false', login: 'agent', userId: 7, commitEmail: 'agent@example.com' }
export const gitlabDeployment = () => testDeployment({ repository: PROJECT.path, project: PROJECT, codeHost: CODE_HOST })
export const execution = (name: string) => ({ name, directory: `/w/${name}`, assignment: '' })
export const ticketOf = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 't1', title: 'Fix the margin', decisionId: 'd1',
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'gitlab', id: 'pavel.evdokimov' }, scope: '' },
  channels: [], assignments: [{ id: 'a1', state: 'running', createdAt: '2026-09-01T00:00:00Z' }], inputs: [], undelivered: [], createdAt: '',
  updatedAt: '', origin: { triggerId: 'origin', triggerIds: [] }, execution: execution('fix-margin'), ...overrides })

export function gitlabHost(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-sources-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({ eval: { mode: 'auto' }, policy: { sources: { gitlab: { allowed: [{ id: 'pavel.evdokimov' }] } } },
    sources: { gitlab: { enabled: true, config: { project: PROJECT.path, cli: CODE_HOST.cli, host: CODE_HOST.host } } } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const deployment = gitlabDeployment()
  sources.register(gitlabKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const context = sourceContextOf(parts, gitlabKind)
  return { ...value, ...context, context, health: board.all, store, engine, commands, receive }
}
