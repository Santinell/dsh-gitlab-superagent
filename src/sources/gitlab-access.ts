/** Resolves the effective GitLab project access from project-level and inherited group-level membership. */
export interface GitlabAccessEntry { access_level: number }
/** The `permissions` object of `GET /projects/:id`; either entry is null when membership comes only from the other level. */
export interface GitlabPermissions {
  project_access?: GitlabAccessEntry | null
  group_access?: GitlabAccessEntry | null
}
export type GitlabAccessSource = 'project' | 'group' | 'none'
export interface GitlabAccess {
  /** Highest effective access level across project and group membership. */
  level: number
  /** Where the effective level came from. */
  source: GitlabAccessSource
  read: boolean
  write: boolean
  maintain: boolean
}
/** GitLab access levels: 20 Reporter reads, 30 Developer writes, 40 Maintainer administers the project. */
const READ = 20
const WRITE = 30
const MAINTAIN = 40

/** Resolves the highest of project and inherited group access; a missing `permissions` object means no access was reported. */
export function resolveAccess(permissions: GitlabPermissions | null | undefined): GitlabAccess {
  const project = permissions?.project_access?.access_level ?? 0
  const group = permissions?.group_access?.access_level ?? 0
  const level = Math.max(project, group)
  const source: GitlabAccessSource = level === 0 ? 'none' : project >= group ? 'project' : 'group'
  return { level, source, read: level >= READ, write: level >= WRITE, maintain: level >= MAINTAIN }
}
