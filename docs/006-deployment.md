# 006 Deployment

Install and operate the GitLab fork using the concepts in [001 Domain model](001-domain.md) through [005 Panel](005-panel.md). The npm package is `dsh-gitlab-superagent`; Cordis ID `dsh-superagent`, the profile `superagent`, presets and panel namespace retain their identities.

## Prerequisites and scope

- POSIX host with Node.js 26.x, pnpm matching `package.json`, git 2.32+, Python 3.8+, tmux, curl and jq. Install git-lfs if the target uses LFS.
- DeepSeek Harness within `engines.dsh` (`0.2.2-rc.3` is the pinned local example), with a working model provider. Keep its web profile separate from your personal profile.
- Stable `glab`; self-managed GitLab **19.2.9+ Free** is the primary target, GitLab.com the secondary smoke target. Verify server version yourself: startup validates account/project access, not the server version.
- One project, canonical `path_with_namespace` (nested groups supported), and a dedicated agent account with **Maintainer** access. PAT scopes: **api + write_repository**. Protect the default branch against agent pushes; choose permitted work-branch names whose final segment is the Ticket name.
- A NEW absolute stateDir. An upstream GitHub stateDir, including schema 11, is refused before writable startup; there is no supported migration. Feishu is not an installed Source.

Workers run under the service's OS account, with unrestricted tools in their managed presets. Credential wrappers and blocked command names choose defaults; they are not OS isolation. Prefer a dedicated OS account containing only the agent's credentials when that isolation is required.

## Agent wrapper and token file

Copy [examples/glab-agent.sh](../examples/glab-agent.sh) to an absolute wrapper path, for example `/home/me/.local/bin/glab-agent`. Edit `agent_host` and select the absolute path of the real glab executable (`command -v glab` before entering a worker shell). Never point it at a worker shim. Prepare the directory without printing secrets:

```sh
install -d -m 700 "$HOME/.config/glab-agent"
install -d "$HOME/.local/bin"
install -m 700 examples/glab-agent.sh "$HOME/.local/bin/glab-agent"
```

The operator creates `$HOME/.config/glab-agent/token` in their own terminal/editor and sets `chmod 600` on it; keep the directory 0700. Enter the PAT there, never in command arguments, chat, the profile YAML, git or logs. `GLAB_AGENT_CONFIG_DIR` can relocate this directory; `GLAB_AGENT_EXECUTABLE` can select the real absolute binary. The wrapper exports `GITLAB_TOKEN` only to its own glab process and overrides inherited operator credentials/host. For a deliberately separate API endpoint, set `GITLAB_API_HOST` in the wrapper as indicated by its comment.

Do **not** run `glab auth login` for this wrapper. A separate `GLAB_CONFIG_DIR` does not isolate the OS keyring; changing login can disturb the operator. `glab auth status` can report signed out for environment-token authentication and is not a setup probe.

```sh
/home/me/.local/bin/glab-agent --version
/home/me/.local/bin/glab-agent api user --jq '{username, id, commit_email}'
/home/me/.local/bin/glab-agent api version --jq .version
/home/me/.local/bin/glab-agent api projects/group%2Fsubgroup%2Fproject --jq '{id, path_with_namespace, default_branch, permissions}'
```

Require the expected agent username, server 19.2.9+, canonical project and effective Maintainer access. Project access can be inherited from a group; setup's `resolveAccess` handles both. Operator and agent accounts must differ.

## Local build and installation

From a checkout, install dependencies, run the full check and create a local package:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack --pack-destination .artifacts
```

For the current version the output is `.artifacts/dsh-gitlab-superagent-0.1.0.tgz`. The tarball includes compiled entries, prompts, the GitLab skill, locales, patch, this guide, SETUP, examples and the service script. It excludes tests and fixtures. No npm publication is assumed.

For a new installation only:

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.3
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "$PWD/.artifacts/dsh-gitlab-superagent-0.1.0.tgz"
```

The DSH profile lives under `${DSH_HOME:-$HOME/.dsh}/profiles/superagent`. Check `dsh plugin --help` if using a different DSH version. For checkout development, `dsh plugin --profile superagent add "link:$PWD"` loads the checkout instead. Do not run profile creation on an existing profile: it replaces its configuration and patch.

The repository commits the compiled `lib/`, so a git install needs neither a build step nor pnpm's build-script allowlist. Pin a tag or commit for reproducibility:

```sh
dsh plugin --profile superagent add "github:Santinell/dsh-gitlab-superagent#main"
```

Run `pnpm build` and commit `lib/` with every source change that affects the package; an installed git revision serves exactly the committed `lib/`.

[`scripts/install-dsh`](../scripts/install-dsh) wraps the steps above in one command: it creates the profile from the web template when it is missing, installs the plugin, and writes `stateDir` and `webserver.port` into the profile patch. It leaves a hand-written patch untouched unless you pass `--force-patch`, and it refuses a profile that exists without the web app bundle unless you pass `--recreate`.

```sh
scripts/install-dsh --profile superagent --port 3082
scripts/install-dsh --dsh "bunx @deepseek-ai/dsh@next"   # no dsh on PATH
scripts/install-dsh --ref <tag-or-commit>                # reproducible install
```

Copy/merge [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) into the profile's `cordis.patch.yml`, replacing its placeholder with a NEW absolute stateDir, such as `/home/me/.dsh/state/superagent-gitlab`. Preserve unrelated existing overrides. The `webserver` entry binds 127.0.0.1:3082. The `dsh-superagent` entry config has:

| Key | Meaning |
| --- | --- |
| `stateDir` | Required absolute path for SQLite, lock, worker-bin, worker-gitconfig and default Ticket work directories |
| `promptMaxChars` | Maximum saved prompt configuration size |
| `admissionContextMaxPages`, `admissionContextTimeoutMs` | Bounds for reading assessment context |

Machine limits can later change without restart in Deployment/Plugin Manager. Source/account fields live in the panel/API, not the profile. Keep `dsh-superagent-worker` and `dsh-superagent-router` preset rows supplied by the bundle: their Sessions require them for creation and recovery.

## Start, stop and recovery

From the unpacked package or checkout containing `scripts/`:

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
scripts/dsh-superagent stop
scripts/dsh-superagent restart
```

The script is **Python**, despite having no suffix. Validate it with `python3 -m py_compile scripts/dsh-superagent`, not `bash -n`. It starts `dsh --profile superagent` in tmux session `dsh-superagent`; another profile uses `dsh-<profile>`. `--profile`, `--url`, `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL` choose another profile/address. Only one instance per profile may run, including instances outside tmux.

`stop`/`restart` request graceful shutdown and wait up to five minutes by default; they do not force-kill or touch other tmux sessions. `--stop-timeout` changes that bound. The recorded PID is checked against the live process before signalling. `start`/`restart` wait up to one minute for runtime readiness or a setup requirement (`--timeout` changes it).

| Exit | Meaning and action |
| --- | --- |
| 0 | Running normally, or a successful/intentional control action |
| 1 | Stopped, duplicate, unreachable, failed startup/runtime or control operation; inspect output/log before retrying |
| 2 | A non-runtime component (e.g. GitLab) reports error; fix the reported component rather than restarting blindly |
| 3 | Setup is pending; fix `setup.problem` on the GitLab card or Deployment settings |

Starting/paused source health alone does not make runtime startup fail. `status` prints JSON with `pids`, `health`, `errors`, `setup` and `manually_stopped`. Only `stop` writes the intentional-stop marker. `start` clears it; `restart` does not create it, so a timed-out graceful restart remains recoverable.

Logs and controls are rooted beside the service script: `.artifacts/dsh-superagent-<profile>-<timestamp>-<pid>.log` (newest 20 per profile) and `.artifacts/control/profiles/<profile>/` (lock, stop marker, service PID). Use an unpacked package in a writable location if operating its supplied script.

### Hourly check

Schedule this in the operator's separate DSH profile, substituting the package/checkout directory:

```text
Run scripts/dsh-superagent --profile superagent status in <directory>. Exit 0: do nothing. Exit 2: report each changed errors entry with its detail; do not restart. Exit 3: report what setup needs; do not restart. If manually_stopped is true, leave it stopped. Otherwise on exit 1 run scripts/dsh-superagent --profile superagent --respect-stop restart. Interpret its exit code the same way. On another failure inspect the newest .artifacts/dsh-superagent-superagent-*.log and Troubleshooting, fix what you can, and report the cause and action. Do not repeat unchanged alerts.
```

## Configure the application

Start with GitLab Source fields `project`, `host` and the wrapper's absolute `cli` path. Defaults: pollSeconds 60, failuresBeforeError 3, all observe switches false. TODOs still carry mentions; subscription polling covers bound conversations. `observeIssues`, `observeMergeRequests`, `observeNotes`, `observeCi` opt into whole-project events. The lower bound on polling is 60 seconds.

Policy `sources.gitlab.allowed` lists usernames that may originate work; `bots` is separate. Begin with a narrow allowed list and observe mode for proactive rules. Set executor `directory`, `prepare`, `maxWorkers` and blocked personal CLI names. To make worktrees from a clean clone, adapt the branch pattern to the project's rules:

```sh
git -C /home/me/src/project fetch --no-tags origin "${DSH_SUPERAGENT_GITLAB_MR_SOURCE_BRANCH:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
git -C /home/me/src/project worktree add -b "$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
```

The worker inherits the generated git credential configuration for the configured host. Keep credentials and http.extraheader settings out of the clone's local config. Set team prompt sections, especially disclosure, review-bot handling and commit identity. Setup resolves the agent's commit email; workers expose it as `DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL`. They must set identity explicitly; git has `user.useConfigOnly=true`. No merge CLI is configured: a person merges every MR, approvals/auto-merge are read-only facts.

### Management API

Use `http://127.0.0.1:3082/orchestrator/api` (or localhost at the configured port) with header `x-orchestrator-request: 1`. Saves also need JSON content-type. Cross-origin/foreign-host requests are refused. Read revisions before each save; a 409 requires reloading. A save with `restarting:true` temporarily interrupts the API and restarts setup.

| Route | Contract |
| --- | --- |
| `GET state` | `setup.problem` (null or place/code/values/detail), `setup.accounts` (project/agent/host/cli when ready), `health`, `load`, `paused`, `masterId` |
| `GET settings` | Blocks with revisions, Source values/forms/facts, policyVersion and execution environment |
| `GET sources` | Source lifecycle/health/stats, filtered Triggers and dropped messages |
| `PUT settings/<block>` | Body `{value, revision}`; returns saved/new revision/policy_changed/restarting |
| `POST executor/pause` | Body `{paused:true}` or false; pauses processing |
| `POST setup/check` | Restarts to recheck a pending setup; healthy setup refuses unnecessary recheck |
| `GET prompts`, `PUT prompts` | Current/default prompt config or save `{config, baseRevision}` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retry eligible work or stop its Ticket |

Example Source save (replace project, host and wrapper path):

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -fsS -H 'x-orchestrator-request: 1' "$api/settings" | jq '.sources[] | select(.id == "gitlab") | .revision')
curl -fsS -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' "$api/settings/source:gitlab" \
  --data "{\"value\":{\"enabled\":true,\"config\":{\"project\":\"group/subgroup/project\",\"host\":\"gitlab.example.com\",\"cli\":\"/home/me/.local/bin/glab-agent\"}},\"revision\":$rev}"
```

For policy, GET the entire current `blocks.policy.value` and revision, edit that JSON and PUT the whole block back. Its Source portion is `{"gitlab":{"allowed":[{"id":"alice"}],"bots":[{"id":"review-bot"}]}}`; preserve other keys, particularly team rules. Admission rows are `issues`, `mergeRequests`, `notes`, `ci`. Eval contains mode/timeoutSeconds/model; executor contains model/maxWorkers/directory/prepare/blockedCommands. A 400 can carry `issues`, structured `setup`, or a user-error code/values; 404 means missing resource, 409 stale revision, 500 unexpected failure.

Health entries: `runtime`, `models`, `evals`, `worker`, `gitlab`, plus `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply`. Setup errors are separate from source polling errors. A successful poll clears its prior polling health failure; 429 uses Retry-After when available, otherwise fallback backoff.

## Worker credentials, clone/push and TLS

Setup writes `<stateDir>/worker-bin` and `worker-gitconfig`; it refuses files it did not create. The glab shim invokes the wrapper after removing its own directory from PATH, so the wrapper must exec real glab by absolute path. An obsolete CLI name is blocked. Token environment variables inherited from the operator are cleared; the wrapper loads its own token after the child starts.

Worker git replaces system/global git config, uses the agent wrapper as the configured host's credential helper, rewrites that host's SSH URLs to HTTPS and supplies LFS filters. It does not set commit identity. Repository-local credential/helper/extraheader overrides are refused when work starts.

After setup, test in an isolated clone with its generated configuration (replace paths, host, project and branch):

```sh
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/home/me/.dsh/state/superagent-gitlab/worker-gitconfig
export GIT_TERMINAL_PROMPT=0
git clone https://gitlab.example.com/group/subgroup/project.git /tmp/agent-push-check
git -C /tmp/agent-push-check switch -c <allowed-test-branch>
git -C /tmp/agent-push-check -c user.name='Agent' -c user.email='agent@example.com' commit --allow-empty -m 'Verify agent push'
git -C /tmp/agent-push-check push origin HEAD
```

Run these in a subshell or a dedicated terminal to keep the operator's git environment unchanged. The branch is a live artifact: agree on its name/cleanup first. Do not push the protected default branch or print credential helper output. This test is required on the live host; packaging tests cannot replace it.

For custom CA/proxy, test both wrapper API and worker git. Global/system operator git proxy or CA settings are replaced, so configure the required nonsecret settings explicitly in the worker's execution environment/prepare command, e.g. `GIT_SSL_CAINFO`, `HTTPS_PROXY` and an appropriate `NO_PROXY`. Ensure the same trusted CA/proxy works for real glab. Never turn off TLS verification as a workaround. P0 does not establish compatibility with arbitrary custom CAs/proxies, and real 429 behavior remains unverified.

## Try it and upgrade

From a second allowed account, mention the agent in an Issue or MR comment. A description mention creates a TODO even on an older Issue; the editor's TODO identity is used. Expect a Ticket/acknowledgement, an agent work branch and bound MR, then human discussion delivery without another mention. Verify failed → running → success CI, approve/revoke facts, restart without duplicates and a human merge closing the completed Ticket.

For an existing GitLab installation: back up the state with the service stopped (including WAL if not cleanly stopped), build/check/pack the new checkout and update the bundle in the existing profile. Keep profile ID, stateDir and preset IDs; do not recreate the profile. Restart and review changed prompt defaults. Recovery notes ask workers to inspect local/GitLab state before repeating external effects. Rollback needs a compatible pre-upgrade state backup; an older binary may not understand newer state.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `The GitLab Source names no project.` | Set canonical project on the GitLab Source card |
| glab CLI unset/missing | Set the wrapper's absolute executable path and check real glab exists |
| CLI cannot read/report its account | Check the private token file, scopes, expiry and wrapper host; use `api user`, not auth status |
| Project unreadable/read-only | Check effective Maintainer role, PAT api/write_repository and project path; a 404 can also conceal denied access |
| CLI/project host mismatch | Correct the wrapper GITLAB_HOST and Source host together |
| Old state directory refused | Choose a new absolute stateDir; do not migrate upstream state |
| git credential verification fails | Require git 2.32+, correct wrapper, and generated worker-gitconfig; do not print credentials |
| Local repository adds credentials/extraheader | Use a clean clone or remove the conflicting local settings |
| Foreign file in worker-bin/config | Move it aside or choose a new stateDir; setup will not overwrite it |
| TLS/proxy failure | Check custom CA/proxy for both wrapper and worker git under the actual service account |
| `status` exit 2 | Fix the named health component; do not blindly restart |
| `status` exit 3 | Fix the structured setup problem; saving or Check again reruns setup |
| `status` exit 1 | Inspect PID/URL/lock/startup log; honor manually_stopped during automatic recovery |
| No Ticket after mention | Check exact username, allowed list, source enabled, processing pause, TODO access and source health |
| CI does not announce a new pipeline ID | Expected: only changed failing-job sets after baseline produce events; waiting does not confirm recovery |
| Approvals unavailable | Capability/permissions can be absent on a host; unavailable is not a new approval requirement |
| Panel plugin/preset unavailable after DSH upgrade | Restart matching artifacts and retain managed preset rows |
| Service-script tests hang only in a restricted runner | They need child processes, signals and a local mock HTTP listener; run with loopback permitted and diagnose environment errors rather than skipping assertions |
