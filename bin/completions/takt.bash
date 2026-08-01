# bash completion for takt project-template
_takt_project_template() {
  local command="" candidates="" index pt_index=-1 skip_value=0
  for ((index = 1; index < COMP_CWORD; index++)); do
    if [[ ${COMP_WORDS[index]} == project-template ]]; then
      pt_index=$index
      continue
    fi
    if (( pt_index >= 0 )); then
      if (( skip_value )); then skip_value=0; continue; fi
      if [[ ${COMP_WORDS[index]} == --cwd ]]; then skip_value=1; continue; fi
      if [[ ${COMP_WORDS[index]} != -* ]]; then command=${COMP_WORDS[index]}; break; fi
    fi
  done
  if (( pt_index < 0 )); then
    candidates="project-template"
  elif [[ -z $command ]]; then
    candidates="export inspect diff apply update rollback list --cwd"
  else
    case "$command" in
inspect) candidates="--cwd --json --current-takt-version" ;;
list) candidates="--cwd --json" ;;
diff) candidates="--cwd --json --current-takt-version" ;;
export) candidates="--cwd --json --dry-run --apply --expected-plan-id --force --pack-version --min-takt-version --source-commit" ;;
apply) candidates="--cwd --json --dry-run --apply --expected-plan-id --force --current-takt-version" ;;
update) candidates="--cwd --json --dry-run --apply --expected-plan-id --force --current-takt-version" ;;
rollback) candidates="--cwd --json --dry-run --apply --expected-plan-id --force" ;;
*) candidates="" ;;
    esac
  fi
  COMPREPLY=($(compgen -W "$candidates" -- "${COMP_WORDS[COMP_CWORD]}"))
}
complete -F _takt_project_template takt
