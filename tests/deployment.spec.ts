import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, GitlabAccountsSchema, machineOf, resolveDeployment, resolveGitlabDeployment, SETUP_FIELDS, workerProbe, type Machine, type Probe } from '../src/deployment.ts'
import { packagedGlabAgent } from '../src/package.ts'
import { Setup } from '../src/app/setup.ts'
import { SettingsSchema } from '../src/policy.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
const user = { id: 7, username: 'agent', commit_email: 'agent@example.com', web_url: 'https://gitlab.example.com/agent' }
/** Fake glab CLI signed in as the agent account, with configurable user fields and project access. */
const glab = (name: string, options: { user?: Record<string, unknown>; access?: number } = {}): string => {
  const account = { ...user, ...options.user }
  const project = { id: 25, path_with_namespace: 'acme/widgets', web_url: 'https://gitlab.example.com/acme/widgets', default_branch: 'main',
    permissions: { project_access: { access_level: options.access ?? 30 }, group_access: null } }
  return program(join(dir, 'bin', name), `case "$*" in\n  "api user") echo '${JSON.stringify(account)}' ;;\n  "api projects/"*) echo '${JSON.stringify(project)}' ;;\n  *) exit 1 ;;\nesac`)
}
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async argv => (await exec(argv[0]!, argv.slice(1), { env: { PATH: path, HOME: dir } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(':')
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', github: { cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), 'exit 1') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), `echo '{}'`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('resolves the project, account, commit email and host-pinned code host', async () => {
    const cli = glab('glab')
    const deployment = await resolveGitlabDeployment(machine(), { project: 'acme/widgets', cli, host: 'gitlab.example.com' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', project: { id: 25, path: 'acme/widgets', defaultBranch: 'main' },
      github: { cli, login: 'agent', noreply: 'agent@example.com' } })
    expect(deployment.codeHost).toEqual({ kind: 'gitlab', host: 'gitlab.example.com', apiBase: 'https://gitlab.example.com/api/v4',
      webBase: 'https://gitlab.example.com', cli, login: 'agent', userId: 7, commitEmail: 'agent@example.com' })
    expect(SETUP_FIELDS.gitlab).toEqual(['project', 'cli', 'host'])
  })

  it('uses the packaged glab-agent when the Source names no CLI', async () => {
    const seen: string[] = []
    const answer: Probe = async argv => {
      seen.push(argv[0]!)
      if (argv[1] === 'api' && argv[2] === 'user') return JSON.stringify(user)
      return JSON.stringify({ id: 25, path_with_namespace: 'acme/widgets', web_url: 'https://gitlab.example.com/acme/widgets', default_branch: 'main',
        permissions: { project_access: { access_level: 30 }, group_access: null } })
    }
    const deployment = await resolveGitlabDeployment(machine(), { project: 'acme/widgets', host: 'gitlab.example.com' }, answer, path)
    expect(deployment.codeHost?.cli).toBe(packagedGlabAgent())
    expect(seen).toEqual([packagedGlabAgent(), packagedGlabAgent()])
  })

  it('passes the GitLab host to worker probes', async () => {
    const calls: string[][] = []
    const subprocess = { spawn: (options: { argv: string[] }) => {
      calls.push(options.argv)
      return { done: Promise.resolve({ exitCode: 0 }), collected: {
        stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } } }
    } } as never
    await workerProbe(subprocess, join(dir, 'state'), dir, new AbortController().signal, 'gitlab.example.com')(['glab', 'api', 'user'])
    expect(calls[0]).toEqual(['env', expect.stringMatching(/^PATH=/), 'GITLAB_HOST=gitlab.example.com', 'glab', 'api', 'user'])
  })

  it('falls back to the GitLab private commit email format when the user API omits it', async () => {
    const cli = glab('glab-no-email', { user: { ...user, commit_email: null } })
    const deployment = await resolveGitlabDeployment(machine(), { project: 'acme/widgets', cli, host: 'gitlab.example.com' }, probe, path)
    expect(deployment.codeHost?.commitEmail).toBe('7-agent@users.noreply.gitlab.example.com')
  })

  it('refuses to add GitLab to a state directory that still has a GitHub Source', async () => {
    const setup = new Setup({ context: {} as never, machine: machine(), lifetime: new AbortController().signal, restart: vi.fn() })
    const settings = SettingsSchema.parse({ sources: {
      github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh' } },
      gitlab: { enabled: true, config: { project: 'acme/widgets', cli: 'glab', host: 'gitlab.example.com' } } } })
    expect(await setup.run(settings)).toBe(false)
    expect(setup.problem).toMatchObject({ place: 'deployment', code: 'stateDirUnsupported' })
  })

  it('passes the Source host to the account check performed on save', async () => {
    const calls: string[][] = []
    const project = { id: 25, path_with_namespace: 'acme/widgets', web_url: 'https://gitlab.example.com/acme/widgets', default_branch: 'main',
      permissions: { project_access: { access_level: 30 }, group_access: null } }
    const subprocess = { spawn: (options: { argv: string[] }) => {
      calls.push(options.argv)
      const text = options.argv.includes('user') ? JSON.stringify(user) : JSON.stringify(project)
      return { done: Promise.resolve({ exitCode: 0 }), collected: {
        stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } } }
    } } as never
    const setup = new Setup({ context: { subprocess } as never, machine: machine(), lifetime: new AbortController().signal, restart: () => {} })
    await setup.checkAccounts('source:gitlab', SettingsSchema.parse({ sources: {
      gitlab: { enabled: true, config: { project: 'acme/widgets', host: 'gitlab.example.com' } } } }))
    expect(calls.length).toBeGreaterThan(0)
    for (const argv of calls) expect(argv).toContain('GITLAB_HOST=gitlab.example.com')
  })

  it('names each missing or mismatched GitLab input', async () => {
    await expect(resolveGitlabDeployment(machine(), { cli: 'glab' }, probe, path)).rejects.toEqual(setupError('gitlab', 'projectUnset'))
    await expect(resolveGitlabDeployment(machine(), { project: 'acme/widgets', cli: join(dir, 'missing'), host: 'gitlab.example.com' }, probe, path))
      .rejects.toEqual(setupError('gitlab', 'gitlabCliMissing', { output: expect.stringContaining('not an executable file') }))
    program(join(dir, 'bin', 'glab-broken'), 'exit 1')
    await expect(resolveGitlabDeployment(machine(), { project: 'acme/widgets', cli: join(dir, 'bin', 'glab-broken'), host: 'gitlab.example.com' }, probe, path))
      .rejects.toEqual(setupError('gitlab', 'gitlabCliSignedOut', { output: expect.stringContaining('glab-broken') }))
    program(join(dir, 'bin', 'glab-anonymous'), `echo '{}'`)
    await expect(resolveGitlabDeployment(machine(), { project: 'acme/widgets', cli: join(dir, 'bin', 'glab-anonymous'), host: 'gitlab.example.com' }, probe, path))
      .rejects.toEqual(setupError('gitlab', 'gitlabCliNoAccount'))
    const foreign = glab('glab-foreign', { user: { ...user, web_url: 'https://gitlab.com/agent' } })
    await expect(resolveGitlabDeployment(machine(), { project: 'acme/widgets', cli: foreign, host: 'gitlab.example.com' }, probe, path))
      .rejects.toEqual(setupError('gitlab', 'projectHostMismatch', { host: 'gitlab.example.com', actual: 'gitlab.com' }))
    const readonly = glab('glab-reader', { access: 20 })
    await expect(resolveGitlabDeployment(machine(), { project: 'acme/widgets', cli: readonly, host: 'gitlab.example.com' }, probe, path))
      .rejects.toEqual(setupError('gitlab', 'projectReadOnly', { account: 'agent', project: 'acme/widgets' }))
  })
})

it.each([true, false])('rejects an old GitHub-only setup before any CLI probe, enabled=%s', async enabled => {
  const setup = new Setup({ context: {} as never, machine: machine(), lifetime: new AbortController().signal, restart: vi.fn() })
  const settings = SettingsSchema.parse({ sources: { github: { enabled, config: { repository: 'acme/widgets', cli: 'gh' } } } })
  expect(await setup.run(settings)).toBe(false)
  expect(setup.problem).toMatchObject({ code: 'stateDirUnsupported', place: 'deployment' })
})
