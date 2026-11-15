/** Subprocess wrapper for running gh, glab, and git commands under the deployment's configured accounts. */
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Deployment } from '../deployment.ts'

const exec = promisify(execFile)
const TIMEOUT_MS = 90_000
/**
 * Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
}
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
export function commandError(error: unknown, program = 'command'): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try { parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed }
    catch { /* Non-JSON CLI diagnostics are retained below. */ }
    const code = parsed?.error?.code
    if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode)
    // `gh` exits non-zero on HTTP errors (such as `gh: Not Found (HTTP 404)`) and on `gh: HTTP 304`, which ETag polling relies on.
    if (stderr) return new CliError(stderr.slice(0, 2000), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined, exitCode)
  }
  return new CliError(`${basename(program)} ${ended(error)}`, undefined, exitCode)
}
function ended(error: unknown): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${TIMEOUT_MS / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}
export interface Tally { skipped: number }
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  return items
}
/**
 * Executes gh, glab, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
export class Commands {
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(private readonly resolved: () => Deployment, private readonly environment: Record<string, string | undefined>, private readonly signal: AbortSignal) {}
  get deployment(): Deployment { return this.resolved() }
  get repository(): string { return this.deployment.repository }
  withSignal(signal?: AbortSignal): Commands { return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal])) : this }
  async run(program: string, args: string[], cwd?: string): Promise<string> {
    try {
      const { stdout } = await exec(program, args, { cwd, signal: this.signal, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...this.environment, GH_PROMPT_DISABLED: '1' } })
      return stdout
    } catch (error) { throw commandError(error, program) }
  }
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  async gh<T>(args: string[]): Promise<T> { return JSON.parse(await this.run(this.deployment.github.cli, args)) as T }
  /** Runs the agent's GitLab CLI (the glab-agent wrapper) and parses its JSON output. */
  async glab<T>(args: string[]): Promise<T> {
    const host = this.deployment.codeHost
    if (!host) throw new Error('This deployment has no GitLab account')
    return JSON.parse(await this.run(host.cli, args)) as T
  }
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.run(this.deployment.github.cli, ['api', this.path(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.gh(['api', this.path(path), ...flags]))
  }
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }
  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
  }
  /** Numeric GitLab project id, or undefined for a legacy GitHub deployment. */
  get projectId(): number | undefined { return this.deployment.project?.id }
  /** `path_with_namespace` of the configured GitLab project. */
  get projectPath(): string | undefined { return this.deployment.project?.path }
  /**
   * Calls the GitLab API on a path within the configured project, validating JSON output when a schema is provided.
   * @throws CliError with GitLab's HTTP status as `code` on failure.
   */
  async gitlabApi<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async gitlabApi(path: string, ...flags: string[]): Promise<string>
  async gitlabApi<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.run(this.deployment.codeHost!.cli, ['api', this.gitlabPath(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.glab(['api', this.gitlabPath(path), ...flags]))
  }
  /** Fetches every page of a GitLab API list as newline-delimited JSON; malformed lines are skipped and counted. */
  async gitlabPages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const text = await this.run(this.deployment.codeHost!.cli, ['api', this.gitlabPath(path), '--paginate', '--output', 'ndjson'])
    return this.ndjson(item, text, tally)
  }
  private gitlabPath(path: string): string {
    const id = this.projectId
    if (id === undefined) throw new Error('This deployment has no GitLab project')
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitLab calls are restricted to the configured project')
    return path ? `projects/${id}/${path}` : `projects/${id}`
  }
  /**
   * Calls the user-level GitLab API, which is not scoped to the configured project: the agent's TODOs and own account.
   * @throws CliError with GitLab's HTTP status as `code` on failure.
   */
  async gitlabUserApi<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async gitlabUserApi(path: string, ...flags: string[]): Promise<string>
  async gitlabUserApi<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.run(this.deployment.codeHost!.cli, ['api', this.userPath(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.glab(['api', this.userPath(path), ...flags]))
  }
  /** Fetches every page of a user-level GitLab API list as newline-delimited JSON; malformed lines are skipped and counted. */
  async gitlabUserPages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const text = await this.run(this.deployment.codeHost!.cli, ['api', this.userPath(path), '--paginate', '--output', 'ndjson'])
    return this.ndjson(item, text, tally)
  }
  private userPath(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside || !/^(?:todos|user)(?:[/?]|$)/.test(path)) throw new Error('User-level GitLab calls are restricted to todos and the current user')
    return path
  }
  /** Parses newline-delimited JSON items, skipping malformed lines and items that fail `item` validation. */
  private ndjson<T>(item: z.ZodType<T>, text: string, tally?: Tally): T[] {
    const items = text.split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line) as unknown] } catch { if (tally) tally.skipped += 1; return [] }
    })
    return validItems(item, items, tally)
  }
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  async git(args: string[], cwd: string): Promise<string> { return this.run('git', args, cwd) }
}
