/** Test-only Feishu bot shape and accessor: production removed Feishu, but the runtime tests still drive core behaviour through it. */
import { z } from 'zod'
import type { Deployment } from '../../../src/deployment.ts'

export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }
/** The bot the test deployment fixture attaches, if any. */
export const feishuBot = (deployment: Deployment | undefined): FeishuBot | undefined =>
  (deployment as Deployment & { feishu?: FeishuBot } | undefined)?.feishu
