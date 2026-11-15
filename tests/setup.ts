/** Test-only transport for the legacy Feishu fixture: production removed `lark`, but core tests still spy on it. */
import type { Deployment } from '../src/deployment.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import type { FeishuBot } from './fixtures/feishu/types.ts'

declare module '../src/infra/commands.ts' {
  interface Commands {
    lark<T>(args: string[], cwd?: string): Promise<T>
  }
}

/** Rewrites Feishu error 232011 (bot not in chat) with remediation instructions, as the removed production method did. */
function membership(error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== 232011) return error
  return new CliError('The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.', error.code, error.exitCode)
}
Commands.prototype.lark = async function <T>(this: Commands, args: string[], cwd?: string): Promise<T> {
  const bot = (this.deployment as Deployment & { feishu?: FeishuBot }).feishu
  if (!bot) throw new Error('The Feishu Source has no working bot CLI')
  const output = await this.run(bot.cli, [...args, '--as', 'bot', '--format', 'json'], cwd).catch((error: unknown) => { throw membership(error) })
  const result = JSON.parse(output) as { ok: boolean; data: T; error?: { code?: number; message?: string } }
  const code = result.error?.code
  if (!result.ok) throw membership(new CliError(`${result.error?.message ?? 'Feishu command failed'}${code ? ` (${code})` : ''}`, code))
  return result.data
}
