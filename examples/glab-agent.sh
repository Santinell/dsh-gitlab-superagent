#!/bin/sh
# Example of a fixed custom wrapper. The package already ships scripts/glab-agent, which the plugin
# uses when the Source `cli` field is empty; copy this file only to pin your own host and location.
# Copy to ~/.local/bin/glab-agent and set these deployment-specific defaults.
# The executable MUST be the absolute path of real glab, never the worker shim.
set -eu
umask 077
agent_host='gitlab.example.com'
config_dir="${GLAB_AGENT_CONFIG_DIR:-$HOME/.config/glab-agent}"
real_glab="${GLAB_AGENT_EXECUTABLE:-/usr/local/bin/glab}"
case "$real_glab" in /*) ;; *) echo 'glab-agent: real glab must have an absolute path' >&2; exit 1 ;; esac
if [ ! -x "$real_glab" ] || [ "$real_glab" -ef "$0" ]; then
  echo 'glab-agent: select the real glab executable, not this wrapper' >&2
  exit 1
fi
if [ ! -r "$config_dir/token" ]; then
  echo 'glab-agent: no readable token file in the agent configuration directory' >&2
  exit 1
fi
# Override operator credentials/host; do not use auth login or the shared OS keyring.
unset GLAB_TOKEN CI_JOB_TOKEN GITLAB_ACCESS_TOKEN GITLAB_API_HOST
export GLAB_CONFIG_DIR="$config_dir"
export GITLAB_HOST="$agent_host"
# For a deliberately separate API host, set GITLAB_API_HOST here as well.
GITLAB_TOKEN="$(cat "$config_dir/token")"
if [ -z "$GITLAB_TOKEN" ]; then echo 'glab-agent: empty token file' >&2; exit 1; fi
export GITLAB_TOKEN
exec "$real_glab" "$@"
