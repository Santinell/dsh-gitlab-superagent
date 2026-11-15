# dsh-gitlab-superagent

An independent GitLab fork of the dsh-superagent research prototype, packaged as a bundle for DeepSeek Harness. The npm package is `dsh-gitlab-superagent`; the Cordis plugin ID, panel namespace and worker/router presets remain `dsh-superagent`.

The agent works on **one GitLab project** as a dedicated account. An allowed person's `@mention` in an Issue or MR can create a Ticket. Each Ticket runs in its own Session and directory, answers in its originating conversation and can open an MR. The panel shows work waiting for a person, source health, policy and execution state.

Intake uses the agent's TODOs plus observed streams and subscribed discussions. Issue `#1` and MR `!1` have separate keys (`gitlab:issue:1`, `gitlab:mr:1`). CI changes are based on failing jobs, not pipeline IDs. Approvals and auto-merge status are facts: **a person merges every MR; the agent never merges or enables auto-merge**.

The supported target is self-managed GitLab **19.2.9+ Free**, with GitLab.com as the secondary smoke target. Use Node.js 26.x, pnpm matching `package.json`, git 2.32+, stable `glab`, and DeepSeek Harness in the declared engine range. Installation/service control requires a POSIX host, Python 3.8+, tmux and a configured DSH model provider.

Start with [SETUP.md](SETUP.md). For a coding agent: read it and follow the setup interview with the operator. For an operator: the detailed install, env-token wrapper, local management API and troubleshooting are in [006 Deployment](docs/006-deployment.md). No published npm release is assumed: build and install a local tarball.

## Guide

- [000 Philosophy](docs/000-philosophy.md): conserve human attention; start narrow and own what the agent says.
- [001 Domain model](docs/001-domain.md) and [002 Authorization](docs/002-authorization.md): Triggers, Tickets, Mandates and policy.
- [003 Execution](docs/003-execution.md), [004 Prompts](docs/004-prompts.md), [005 Panel](docs/005-panel.md): work, instructions and operations.
- [006 Deployment](docs/006-deployment.md), [007 Architecture](docs/007-architecture.md), [008 Cookbook](docs/008-cookbook.md): install, code index and extension points.
- [UPSTREAM](docs/UPSTREAM.md): fixture evidence, deliberate divergences and remaining live checks.

Use a **new state directory**. GitHub installations and schema versions below 11 are refused; state migration from that upstream product is unsupported. GitHub and Feishu are not active sources in this fork. Their remaining legacy code/test fixtures are scheduled for removal in P7 and do not provide a supported installation path.

The source repository is [Santinell/dsh-gitlab-superagent](https://github.com/Santinell/dsh-gitlab-superagent), forked from [DeepSeek's prototype](https://github.com/deepseek-ai/dsh-superagent-prototype). Those are source-history links, not supported target code hosts. This remains research software, not an official DeepSeek product. Review it for your environment.

## Local validation

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack --pack-destination .artifacts
```

Or install the bundle straight from the GitHub repository. It commits the compiled `lib/`, so `pnpm` runs no build scripts during installation:

```sh
dsh plugin --profile superagent add "github:Santinell/dsh-gitlab-superagent#main"
```

Local tests and tarball inspection do not establish a live GitLab deployment. The self-managed installation/Issue → MR → CI → human merge smoke and the GitLab.com smoke remain required before release. Real 429 behavior and custom TLS/proxy setups are not claimed as verified.
