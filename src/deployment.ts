/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'
import { packagedGlabAgent } from './package.ts'
import { resolveAccess } from './sources/gitlab-access.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const GitlabAccountsSchema = z.object({
  project: z.string().trim().regex(/^([A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+)?$/, 'group/project').default(''),
  cli: z.string().trim().default(''),
  host: z.string().trim().regex(/^[A-Za-z0-9.-]+(:[0-9]+)?$/, 'hostname or hostname:port').default('gitlab.com'),
})
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  github: Object.keys(GithubAccountsSchema.shape), gitlab: Object.keys(GitlabAccountsSchema.shape) }

export interface GitlabProject { id: number; path: string; webUrl: string; defaultBranch: string }
export interface GitlabCodeHost { kind: 'gitlab'; host: string; apiBase: string; webBase: string; cli: string; login: string; userId: number; commitEmail: string }
export interface Deployment extends Machine {
  repository: string
  github: { cli: string; login: string; noreply: string }
  /** Present for a GitLab deployment; the legacy fields above mirror its project and account for code not migrated yet. */
  project?: GitlabProject
  codeHost?: GitlabCodeHost
}

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal, host?: string): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  const hostEnv = host ? [`GITLAB_HOST=${host}`] : []
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...hostEnv, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const GitlabUser = z.object({ username: z.string().regex(/^[A-Za-z0-9_.-]+$/), id: z.number().int().positive(),
  commit_email: z.string().email().nullish(), web_url: z.string().url() })
const GitlabProject = z.object({ id: z.number().int().positive(), path_with_namespace: z.string().min(1), web_url: z.string().url(),
  default_branch: z.string().nullish(), permissions: z.object({
    project_access: z.object({ access_level: z.number().int() }).nullish(),
    group_access: z.object({ access_level: z.number().int() }).nullish(),
  }).nullish() })
const hostOf = (url: string): string | undefined => { try { return new URL(url).host.toLowerCase() } catch { return undefined } }
/** Verify the agent's glab identity and push access to the configured GitLab project; the glab-agent wrapper pins host and token. */
export async function resolveGitlabDeployment(machine: Machine, gitlab: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GitlabAccountsSchema.parse(gitlab ?? {})
  const projectPath = accounts.project
  if (!projectPath) throw new SetupError('projectUnset')
  let cli: string
  try { cli = executable(accounts.cli || packagedGlabAgent(), path, workerBin(stateDir)) } catch (error) { throw new SetupError('gitlabCliMissing', { output: reason(error) }) }
  const agent = parsed(GitlabUser, await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('gitlabCliSignedOut', { output: reason(error) }) }))
  if (!agent) throw new SetupError('gitlabCliNoAccount')
  const host = accounts.host.toLowerCase()
  const actual = hostOf(agent.web_url)
  if (actual !== host) throw new SetupError('projectHostMismatch', { host, actual: actual ?? agent.web_url })
  const project = parsed(GitlabProject, await probe([cli, 'api', `projects/${encodeURIComponent(projectPath)}`]).catch((error: unknown) => {
    throw new SetupError('projectUnreadable', { account: agent.username, project: projectPath, output: reason(error) })
  }))
  if (!project) throw new SetupError('projectUnreported', { project: projectPath })
  if (hostOf(project.web_url) !== host) throw new SetupError('projectHostMismatch', { host, actual: hostOf(project.web_url) ?? project.web_url })
  const access = resolveAccess(project.permissions)
  if (!access.write) throw new SetupError('projectReadOnly', { account: agent.username, project: project.path_with_namespace })
  const commitEmail = agent.commit_email || `${agent.id}-${agent.username}@users.noreply.${host.split(':')[0]}`
  return { ...machine, repository: project.path_with_namespace, github: { cli, login: agent.username, noreply: commitEmail },
    project: { id: project.id, path: project.path_with_namespace, webUrl: project.web_url, defaultBranch: project.default_branch || 'main' },
    codeHost: { kind: 'gitlab', host: accounts.host, apiBase: `https://${accounts.host}/api/v4`, webBase: `https://${accounts.host}`,
      cli, login: agent.username, userId: agent.id, commitEmail } }
}
