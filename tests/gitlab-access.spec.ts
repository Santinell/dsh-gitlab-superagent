import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveAccess, type GitlabPermissions } from '../src/sources/gitlab-access.ts'

const fixture = (name: string): { permissions: GitlabPermissions } =>
  JSON.parse(readFileSync(new URL(`./fixtures/gitlab/entities/${name}`, import.meta.url), 'utf8')) as { permissions: GitlabPermissions }

describe('GitLab project access', () => {
  it('takes Maintainer from inherited group access', () => {
    expect(resolveAccess(fixture('project.json').permissions)).toEqual({ level: 40, source: 'group', read: true, write: true, maintain: true })
  })

  it('takes Developer from direct project access', () => {
    expect(resolveAccess(fixture('project-developer.json').permissions)).toEqual({ level: 30, source: 'project', read: true, write: true, maintain: false })
  })

  it('takes Reporter as read-only access', () => {
    expect(resolveAccess(fixture('project-reporter.json').permissions)).toEqual({ level: 20, source: 'project', read: true, write: false, maintain: false })
  })

  it('reports no access when the project API did not return permissions', () => {
    expect(resolveAccess(undefined)).toEqual({ level: 0, source: 'none', read: false, write: false, maintain: false })
  })

  it('uses the highest level when both project and group grant access', () => {
    expect(resolveAccess({ project_access: { access_level: 20 }, group_access: { access_level: 40 } }))
      .toEqual({ level: 40, source: 'group', read: true, write: true, maintain: true })
    expect(resolveAccess({ project_access: { access_level: 40 }, group_access: { access_level: 20 } }))
      .toEqual({ level: 40, source: 'project', read: true, write: true, maintain: true })
  })

  it('treats Guest and lower levels as no read/write access', () => {
    expect(resolveAccess({ project_access: { access_level: 10 } }))
      .toEqual({ level: 10, source: 'project', read: false, write: false, maintain: false })
  })
})
