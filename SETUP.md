# SETUP

Instructions for a coding agent installing dsh-gitlab-superagent with its operator. This is a GitLab-only installation for one project; retain Cordis ID `dsh-superagent` and default DSH profile `superagent`.

## Interview

Read this file and [000 Philosophy](docs/000-philosophy.md), then probe local prerequisites. Ask one question per message, skip facts already known, and keep questions short. Collect missing decisions before making external changes. Never request a token in chat: the operator enters it in their own terminal. Prepare the concrete install plan and ask for confirmation before installing or altering their profile/accounts.

```sh
node --version
pnpm --version
git --version
glab --version
tmux -V
python3 --version
dsh --version
```

Require Node 26.x, pnpm as declared in `package.json`, git 2.32+, stable glab, Python 3.8+, tmux, a POSIX host and DSH in `engines.dsh`. Read the installed DSH CLI's help before applying profile/plugin commands if its version differs from the pinned example. A configured model provider is also required. Do not print credentials or operator authentication status.

Ask in this order:

1. **GitLab host:** host[:port], without a URL path. Recommend the team's self-managed GitLab 19.2.9+ Free; GitLab.com is supported as a secondary target. Ask about custom CA/proxy requirements when applicable.
2. **Project:** canonical `path_with_namespace`, including nested groups, e.g. `group/subgroup/project`.
3. **Agent account:** a dedicated account with Maintainer access, separate from the operator. It needs a PAT with `api` and `write_repository`. The default branch must be protected; work branches follow project naming rules.
4. **Allowed people and bots:** list GitLab usernames separately. Start with a narrow allowed list. Bot content cannot grant human authority; there is no cross-service identity mapping.
5. **Checkout:** reuse a clean local clone or create one, and where. Each Ticket needs its own worktree/directory; the last segment of its branch must be `$DSH_SUPERAGENT_NAME` for MR discovery.
6. **Commit identity and team text:** accept the agent account/email resolved by setup, or specify explicit identity in Delivery requirements. Capture review-bot rules. A person merges every MR; there is no merge CLI or auto-merge option.
7. **Local installation:** use the dedicated `superagent` profile, port 3082, and a NEW absolute stateDir. An existing GitLab profile can be retained; an upstream stateDir cannot be reused.

Recommend accept mode `observe` for proactive rules, all observe switches off initially, and explicit allowed-user mentions for the first smoke. Schedule any hourly service check in the operator's separate profile so it survives a service outage.

## Plan and execute

Explain the paths, host/project/account, token-file location, profile, new stateDir, worktree command and operator-only steps. Use [006 Deployment](docs/006-deployment.md) and [profile example](examples/profile.cordis.patch.yml). Do not overwrite an existing profile's patch or rerun profile creation on it.

After confirmation:

1. Create the private agent configuration directory (0700) and let the operator write a nonempty `token` file (0600) there from their own terminal; the package ships the `glab-agent` wrapper, so the Source `cli` field stays empty. No token goes into argv, chat, git, a profile patch or a generated artifact.
2. Verify the packaged wrapper with `GITLAB_HOST` set (`"$DSH_PROFILE_DIR/node_modules/dsh-gitlab-superagent/scripts/glab-agent" --version`, `api user`, `api version`; 006 lists the commands). Check the exact username, server version 19.2.9+, canonical project and permissions. **Do not use `glab auth login` or `auth status` for this wrapper**: environment-token authentication uses no login/keyring, and status can say signed out. Never change the operator's authentication.
3. Build, pack and install the local bundle using the commands in 006. Apply profile overrides with the new stateDir; start the service. A first start may exit 3 while GitLab setup is incomplete.
4. Save `source:gitlab` through the local API/panel with `project` and `host` (leave `cli` empty to use the packaged wrapper); then `policy.sources.gitlab.allowed`/`bots`, eval mode and executor configuration. GET each current revision before saving. Preserve team rules/settings that already exist. If `restarting:true`, wait for the API to return before the next save.
5. Validate clone and push using the generated worker credential configuration, on an operator-approved test branch allowed by the project; never push the protected default branch. See the isolated clone/push commands in 006. This is a live verification step, not satisfied by unit tests.
6. Save team prompt text and explicit commit identity where chosen; keep the instruction prohibiting merge and auto-merge. Resolve setup errors at their named Source or Deployment location. TLS/proxy must be checked from both glab and worker git.

## Verify and hand over

Require `scripts/dsh-superagent status` exit 0, populated project/agent facts, and no source health errors. From a second allowed account, mention `@agent` in an Issue, check its Ticket and acknowledgement, open/bind an MR, deliver a discussion reply, fail/recover CI, restart without duplicates, then merge as a human. Record what was actually run; pending live checks remain pending.

Give the operator the panel URL, service commands/exit codes and the hourly-check prompt in 006. Explain: start narrow, tune noise, and own what the agent says. Link the numbered guide and identify any unverified host-specific TLS/proxy, 429 or GitLab.com behavior.
