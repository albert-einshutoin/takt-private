#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE_OR_STAGE="${1:-once}"

args=(staged "$MODE_OR_STAGE" --cwd "$ROOT")
if [[ -n "${TAKT_LOOP_REPO:-}" ]]; then
  args+=(--repo "$TAKT_LOOP_REPO")
fi
if [[ -n "${TAKT_LOOP_WORKFLOW:-}" ]]; then
  args+=(--workflow "$TAKT_LOOP_WORKFLOW")
fi
if [[ -n "${TAKT_LOOP_POLICY:-}" ]]; then
  args+=(--policy "$TAKT_LOOP_POLICY")
fi
if [[ -n "${TAKT_LOOP_STAGE_STATE:-}" ]]; then
  args+=(--state "$TAKT_LOOP_STAGE_STATE")
fi

exec devloopd "${args[@]}"
