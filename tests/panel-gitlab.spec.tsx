// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { SETUP_PROBLEMS } from '../src/setup.ts'
import { usePanel, mount, remount, at, all, field, type, click, text } from './fixtures/panel.tsx'
import { server, useGitlabData, gitlabTicketData, problemOf } from './fixtures/panel-server.ts'

usePanel()
for (const dictionary of [en, zh]) {
  it(`edits a nested self-managed GitLab project, CLI, host and observation settings in ${dictionary.lang}`, async () => {
    useGitlabData()
    at({ page: 'settings', query: { group: 'source', source: 'gitlab' } })
    await mount(dictionary)
    expect(all('.dt-card')).toHaveLength(1)
    expect(text()).toContain('@agent-bot')
    expect(text()).not.toMatch(/github|feishu/i)
    const project = field<HTMLInputElement>(dictionary.lang === 'en' ? 'Project' : '项目')
    await type(project, 'new-group/subgroup/project')
    await type(field(dictionary.lang === 'en' ? 'GitLab host' : 'GitLab 主机'), 'gitlab.internal.test:8443')
    await type(field(dictionary.lang === 'en' ? 'Agent glab CLI' : '智能体的 glab CLI'), '/usr/local/bin/glab-agent')
    await click(dictionary.lang === 'en' ? 'Receive new merge requests' : '接收新的 merge request')
    await click(dictionary.lang === 'en' ? "Receive the default branch's CI" : '接收默认分支的 CI')
    await click(dictionary.save)
    expect(server.settings.sources.gitlab?.config).toMatchObject({ project: 'new-group/subgroup/project', host: 'gitlab.internal.test:8443', cli: '/usr/local/bin/glab-agent', observeIssues: false, observeMergeRequests: true, observeNotes: false, observeCi: true })
    expect(text()).toContain(dictionary.savedRestarting)
    expect(server.requests.find(item => item.path === 'settings/source:gitlab')).toMatchObject({ method: 'PUT' })
  })

  it(`shows GitLab scope, allowed people, bots, health and disabled state in ${dictionary.lang}`, async () => {
    useGitlabData()
    at({ page: 'settings', query: { group: 'eval' } })
    await mount(dictionary)
    expect(text()).toContain('alice')
    expect(text()).toContain('review-bot')
    expect(text()).not.toMatch(/github|feishu/i)
    server.health.gitlab = { state: 'error', code: 'pollFailures', values: { count: '3', error: 'EOF' }, detail: 'diagnostic' }
    at({ page: 'source' })
    await remount(dictionary)
    expect(text()).toContain(dictionary['health.gitlab'])
    expect(text()).toContain('EOF')
    server.settings.sources.gitlab!.enabled = false
    await remount(dictionary)
    expect(text()).toContain(dictionary.sourceOff)
  })

  it(`renders all active setup failures with repair actions in ${dictionary.lang}`, async () => {
    useGitlabData()
    at({ page: 'overview' })
    for (const [code, [place]] of Object.entries(SETUP_PROBLEMS)) {
      if (place === 'github' || code === 'gitTooOld') continue
      server.setup = { ...server.setup, accounts: null, problem: problemOf(code as keyof typeof SETUP_PROBLEMS,
        { account: 'agent', project: 'group/project', actual: 'wrong.test', host: 'gitlab.test', file: 'config' }) }
      await remount(dictionary)
      expect(text()).not.toMatch(/setup\.|problemSetupFix\./)
      expect(text()).toContain(dictionary.problemSetup)
      expect(text()).toContain(dictionary.setupCheck)
    }
  })
}

for (const dictionary of [en, zh]) it(`opens separate Issue/MR cards and MR channels in ${dictionary.lang}`, async () => {
  gitlabTicketData()
  at({ page: 'execution', id: 't1' })
  await mount(dictionary)
  expect(text()).toContain('#1')
  expect(text()).toContain('!1')
  expect(text()).not.toMatch(/github|feishu/i)
  await click(dictionary['term.channel'])
  const links = all('.dt-disclosure-body a')
  expect(links.map(link => link.getAttribute('href'))).toEqual(server.ticketDetails.t1!.channels.map(channel => channel.url))
  expect(links[1]!.querySelector('svg path')?.getAttribute('d')).not.toBe(links[0]!.querySelector('svg path')?.getAttribute('d'))
})

// Optional HTML captures render the real React pages and panel CSS for browser QA without a live account.
it('captures GitLab screens for optional visual review', async () => {
  if (!process.env.P4_VISUAL_DIR) return
  const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
  const directory = process.env.P4_VISUAL_DIR
  mkdirSync(directory, { recursive: true })
  const css = readFileSync('src/client/client.css', 'utf8')
  const tokens = [...new Set(css.match(/--dsw-[a-z0-9-]+/g))].map(key => `${key}:${/label/.test(key) ? '#475569' : /border/.test(key) ? '#cbd5e1' : /error/.test(key) ? '#dc2626' : /success/.test(key) ? '#16a34a' : /brand|link/.test(key) ? '#2563eb' : '#f1f5f9'}`).join(';')
  for (const dictionary of [en, zh]) {
    for (const page of ['source', 'source-settings', 'policy', 'deployment', 'ticket', 'issue', 'mr', 'prompts', 'error']) {
      gitlabTicketData()
      if (page === 'error') server.setup = { ...server.setup, accounts: null, problem: problemOf('projectReadOnly', { account: 'agent', project: 'group/subgroup/widgets' }) }
      at(page === 'ticket' ? { page: 'execution', id: 't1' } : page === 'issue' || page === 'mr' ? { page: 'trigger', id: `gitlab:${page}:1` }
        : ['source-settings', 'policy', 'deployment', 'prompts'].includes(page) ? { page: 'settings', query: { group: page === 'source-settings' ? 'source' : page === 'policy' ? 'eval' : page as 'deployment' | 'prompts' } }
        : { page: page === 'error' ? 'overview' : 'source' })
      await remount(dictionary)
      if (page === 'prompts') {
        await click(dictionary.promptViewFull)
        await type(field(dictionary.promptPreviewTarget), 'skill/gitlab')
      }
      const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{${tokens}}body{margin:0;font:14px system-ui;background:white}html,body{height:100%}button,input,select,textarea{font:inherit}${css}</style>${document.body.innerHTML}`
      writeFileSync(`${directory}/${dictionary.lang}-${page}.html`, html)
    }
  }
})

for (const dictionary of [en, zh]) it(`shows CI, approvals, merge status and auto-merge facts without a merge action in ${dictionary.lang}`, async () => {
  gitlabTicketData()
  const thread = server.ticketDetails.t1!.threads[1]!
  thread.facts = { ...thread.facts, approvals: { label: { en: 'Approvals', zh: '批准' }, value: '@alice' },
    approved: { label: { en: 'Approved', zh: '已批准' }, value: { en: 'yes', zh: '是' } },
    mergeStatus: { label: { en: 'Merge status', zh: '合并状态' }, value: 'mergeable' },
    autoMerge: { label: { en: 'Auto-merge', zh: '自动合并' }, value: { en: 'on', zh: '已开启' } } }
  at({ page: 'execution', id: 't1' })
  await mount(dictionary)
  for (const fact of ['@alice', 'mergeable', dictionary.lang === 'en' ? 'Auto-merge' : '自动合并']) expect(text()).toContain(fact)
  expect(all('button').some(button => /^(Merge|Enable auto-merge|Approve|合并|启用自动合并|批准)$/.test(button.textContent ?? ''))).toBe(false)
})
