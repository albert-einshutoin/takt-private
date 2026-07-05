#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMMAND="${1:-once}"

common_args=(--cwd "$ROOT")
if [[ -n "${TAKT_LOOP_REPO:-}" ]]; then
  common_args+=(--repo "$TAKT_LOOP_REPO")
fi
if [[ -n "${TAKT_LOOP_WORKFLOW:-}" ]]; then
  common_args+=(--workflow "$TAKT_LOOP_WORKFLOW")
fi
if [[ -n "${TAKT_LOOP_POLICY:-}" ]]; then
  common_args+=(--policy "$TAKT_LOOP_POLICY")
fi

case "$COMMAND" in
  once|loop|issue-scout|issue-to-pr|pr-review|review-fix|pr-merge)
    exec devloopd staged "$COMMAND" "${common_args[@]}"
    ;;
  review-open)
    exec devloopd stage pr-review "${common_args[@]}"
    ;;
  fix-open)
    exec devloopd stage review-fix "${common_args[@]}"
    ;;
  merge-open)
    exec devloopd stage pr-merge "${common_args[@]}"
    ;;
  promote-pr|review-pr)
    if [[ -z "${2:-}" ]]; then
      echo "usage: $0 $COMMAND <pr-number>" >&2
      exit 2
    fi
    exec devloopd promote-auto-merge --pr "$2" "${common_args[@]}"
    ;;
  merge-pr)
    if [[ -z "${2:-}" ]]; then
      echo "usage: $0 merge-pr <pr-number>" >&2
      exit 2
    fi
    pr="$2"
    head_args=(pr view "$pr" --json headRefOid --jq .headRefOid)
    if [[ -n "${TAKT_LOOP_REPO:-}" ]]; then
      head_args+=(--repo "$TAKT_LOOP_REPO")
    fi
    head_sha="$(gh "${head_args[@]}")"
    devloopd promote-auto-merge --pr "$pr" "${common_args[@]}"
    exec devloopd merge-if-safe --pr "$pr" --expected-head "$head_sha" "${common_args[@]}"
    ;;
  *)
    echo "usage: $0 {once|loop|issue-scout|issue-to-pr|pr-review|review-fix|pr-merge|review-open|fix-open|merge-open|promote-pr|review-pr|merge-pr}" >&2
    exit 2
    ;;
esac
