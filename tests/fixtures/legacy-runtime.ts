/** Explicit compatibility for historical core tests until P7; never used by GitLab startup/guard tests. */
import { join } from 'node:path'
import { vi } from 'vitest'
import { Setup } from '../../src/app/setup.ts'
import * as persistence from '../../src/app/store.ts'
import { SetupError } from '../../src/setup.ts'
import type { Deployment } from '../../src/deployment.ts'
import type { Settings } from '../../src/policy.ts'
import { LegacySetup } from './legacy-setup.ts'

type Resolver = { resolve(settings: Settings): Promise<Deployment>; host: { machine: { stateDir: string } } }
const actualGuard = persistence.assertCurrentSchema
const actualResolve = (Setup.prototype as unknown as Resolver).resolve
const actualCheck = Setup.prototype.checkAccounts
const paths = new Set<string>()

/** Allow only directories explicitly owned by a legacy fixture to exercise its old setup and runtime recovery. */
export function allowLegacyRuntime(directory: string): void {
  paths.add(directory)
  if (!vi.isMockFunction(persistence.assertCurrentSchema)) vi.spyOn(persistence, 'assertCurrentSchema').mockImplementation(path => {
    try { actualGuard(path) } catch (error) {
      if (!(error instanceof SetupError) || error.code !== 'stateDirUnsupported'
        || ![...paths].some(directory => path === join(directory, 'orchestrator.sqlite'))) throw error
    }
  })
  const prototype = Setup.prototype as unknown as Resolver
  if (!vi.isMockFunction(prototype.resolve)) vi.spyOn(prototype, 'resolve').mockImplementation(function (this: Resolver, settings) {
    const resolve = paths.has(this.host.machine.stateDir) && settings.sources.github
      ? (LegacySetup.prototype as unknown as Resolver).resolve : actualResolve
    return resolve.call(this, settings)
  })
  if (!vi.isMockFunction(Setup.prototype.checkAccounts)) vi.spyOn(Setup.prototype, 'checkAccounts').mockImplementation(function (this: Setup, block, settings) {
    const owned = paths.has((this as unknown as Resolver).host.machine.stateDir)
    return (owned && settings.sources.github ? LegacySetup.prototype.checkAccounts : actualCheck).call(this, block, settings)
  })
}
