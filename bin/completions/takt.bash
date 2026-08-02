# bash completion for takt project-template
_takt_project_template() {
  local root_commands="release-info run watch add list resume clear eject reset prompt export-cc export-codex catalog workflow metrics purge repertoire"
  local pt_commands="export inspect diff apply update rollback list"
  local command="" root_command="" candidates="" index pt_index=-1 skip_value=0 root_skip_value=0
  for ((index = 1; index < COMP_CWORD; index++)); do
    if (( pt_index < 0 )); then
      if (( root_skip_value )); then root_skip_value=0; continue; fi
      case ${COMP_WORDS[index]} in
        -i|--issue|--pr|-w|--workflow|-b|--branch|--repo|--provider|--model|-t|--task|--isolation|--cwd)
          root_skip_value=1; continue ;;
        -*) continue ;;
        project-template)
          if [[ -z $root_command ]]; then
            root_command=project-template
            pt_index=$index
          fi
          continue ;;
        *)
          if [[ -z $root_command ]]; then root_command=${COMP_WORDS[index]}; fi
          continue ;;
      esac
    fi
    if (( pt_index >= 0 )); then
      if (( skip_value )); then skip_value=0; continue; fi
      if [[ ${COMP_WORDS[index]} == --cwd ]]; then skip_value=1; continue; fi
      if [[ ${COMP_WORDS[index]} != -* ]]; then command=${COMP_WORDS[index]}; break; fi
    fi
  done
  if (( pt_index < 0 )); then
    case "$root_command" in
reset) candidates="config categories" ;;
workflow) candidates="init doctor" ;;
metrics) candidates="review" ;;
repertoire) candidates="add remove list" ;;
"") candidates="$root_commands project-template" ;;
*) candidates="" ;;
    esac
  elif [[ -z $command ]]; then
    candidates="$pt_commands --cwd"
  else
    case "$command" in
inspect) candidates="--cwd --json --current-takt-version" ;;
list) candidates="--cwd --json" ;;
diff) candidates="--cwd --json --current-takt-version" ;;
export) candidates="--cwd --json --dry-run --apply --expected-plan-id --force --pack-version --min-takt-version --source-commit --approve-policy --approve-capability" ;;
apply) candidates="--cwd --json --dry-run --apply --expected-plan-id --force --current-takt-version" ;;
update) candidates="--cwd --json --dry-run --apply --expected-plan-id --force --current-takt-version" ;;
rollback) candidates="--cwd --json --dry-run --apply --expected-plan-id --force" ;;
*) candidates="" ;;
    esac
  fi
  COMPREPLY=($(compgen -W "$candidates" -- "${COMP_WORDS[COMP_CWORD]}"))
}
complete -F _takt_project_template takt
