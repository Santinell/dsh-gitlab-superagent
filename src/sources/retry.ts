/** Shared retry record of a Source's failed target read, keeping where the read stopped so the next poll resumes there. */
export interface Retry {
  /** Read cursor the retry starts from; the caller keeps it so no event between the failure and the retry is lost. */
  since: string
  /** True when the target is a merge/pull request rather than an issue, for Sources that read both. */
  pr?: boolean
  /** When the first attempt of this retry failed; a Source may abandon a retry after a long window. */
  failedAt?: string
  /** Number of failed attempts; diagnostics only. */
  attempts?: number
}
