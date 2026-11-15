import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentModel, modelSelectionProjectionDefinition, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const host = { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') }
  // Use DSH's real model and durable projection, including selections restored from the log.
  const definition = modelSelectionProjectionDefinition
  const model = new AgentModel(() => session.snapshotEvents().reduce(definition.apply,
    definition.init(session.header, session.inheritedEventCount)), session, host)
  const agent = { id: session.id, ctx, session, model } as unknown as Agent
  const record = (selection: ModelSelection) => session.append('request/header', { header: { config: selection }, reason: 'initial' })
  return { ctx, agent, host, resolve, flush, record }
}
it('persists the role model across requests without changing the host default or inheriting its effort', async () => {
  const { ctx, agent, host, flush, record } = fixture()
  const selected = { provider: 'worker-provider', model: 'worker-model' }
  await initializeRoleModel(ctx, agent, selected)
  expect(agent.model.current()).toEqual(selected)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
  expect(flush).toHaveBeenCalledOnce()
  record(selected)
  expect(agent.model.current()).toEqual(selected)
  expect(host).toEqual({ provider: 'host', model: 'default', reasoningEffort: 'high' })
  // Reopening a configured session must not replace its recorded route.
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(agent.model.current()).toEqual(selected)
  expect(flush).toHaveBeenCalledOnce()
})
it('preserves a later manual selection when the role is initialized again', async () => {
  const { ctx, agent } = fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  agent.model.select(manual)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(agent.model.current()).toEqual(manual)
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve, flush } = fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(agent.model.current()).toEqual(existing)
  expect(resolve).not.toHaveBeenCalled()
  expect(flush).not.toHaveBeenCalled()
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, host, resolve, flush } = fixture()
  await initializeRoleModel(ctx, agent, null)
  expect(agent.model.current()).toEqual(host)
  expect(resolve).not.toHaveBeenCalled()
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents()).toEqual([])
  expect(flush).not.toHaveBeenCalled()
})
it('records the provider-normalized route and configured reasoning effort', async () => {
  const { ctx, agent, resolve } = fixture()
  resolve.mockResolvedValueOnce({ provider: 'canonical', model: 'resolved', reasoningEffort: ReasoningEffortId('low') })
  await initializeRoleModel(ctx, agent, { provider: 'alias', model: 'requested', reasoningEffort: 'low' })
  expect(resolve).toHaveBeenCalledWith({ provider: 'alias', model: 'requested', reasoningEffort: 'low' })
  expect(agent.model.current()).toEqual({ provider: 'canonical', model: 'resolved', reasoningEffort: 'low' })
})
