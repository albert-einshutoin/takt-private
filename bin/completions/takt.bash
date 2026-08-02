# bash completion for takt project-template
_takt_project_template() {
  local root_commands="release-info run watch add list resume clear eject reset prompt export-cc export-codex catalog workflow metrics purge repertoire"
  local pt_commands="export inspect diff apply update rollback list"
  local command="" root_command="" root_child="" candidates="" phase="root" index skip_value=0 root_ambiguous=0 group_ambiguous=0 delimiter_seen=0 terminal=0 child_operand_count=0 short_index=0 short_name="" word=""
  # Why: matching the CLI's delimiter/root/group/child phases prevents a later
  # familiar word from reviving completion after ambiguous input.
  for ((index = 1; index < COMP_CWORD; index++)); do
    word=${COMP_WORDS[index]}
    if [[ $phase == root || $phase == legacy ]]; then
      if (( skip_value )); then skip_value=0; continue; fi
      if (( delimiter_seen )); then
        if [[ $phase == root ]]; then
          root_command=$word
          if [[ $word == project-template ]]; then phase=group; else phase=legacy; fi
        elif [[ -z $root_child ]]; then
          root_child=$word
        fi
        continue
      fi
      case $word in
        --issue|--pr|--workflow|--branch|--repo|--provider|--model|--task|--isolation|--cwd)
          skip_value=1; continue ;;
        --issue=*|--pr=*|--workflow=*|--branch=*|--repo=*|--provider=*|--model=*|--task=*|--isolation=*|--cwd=*)
          continue ;;
        --auto-pr|--draft|--pipeline|--copy-workspace|--skip-git|--quiet|--continue|--help|--version)
          continue ;;
        --auto-pr=*|--draft=*|--pipeline=*|--copy-workspace=*|--skip-git=*|--quiet=*|--continue=*|--help=*|--version=*)
          continue ;;
        --) delimiter_seen=1; continue ;;
        --*) root_ambiguous=1; continue ;;
        -*)
          for ((short_index = 1; short_index < ${#word}; short_index++)); do
            short_name=${word:short_index:1}
            case $short_name in
              q|c|h|V) ;;
              i|w|b|t)
                if (( short_index == ${#word} - 1 )); then
                  skip_value=1
                fi
                break ;;
              *) root_ambiguous=1; break ;;
            esac
          done
          continue ;;
        project-template)
          if [[ $phase == root ]] && (( ! root_ambiguous )); then
            root_command=project-template
            phase=group
          elif [[ $phase == legacy && -z $root_child ]]; then
            root_child=$word
          fi
          continue ;;
        *)
          if [[ $phase == root ]]; then
            root_command=$word
            phase=legacy
          elif [[ -z $root_child ]]; then
            root_child=$word
          fi
          continue ;;
      esac
    fi
    if [[ $phase == group ]]; then
      if (( skip_value )); then skip_value=0; continue; fi
      if (( terminal )); then continue; fi
      if (( ! delimiter_seen )); then
        case $word in
          --cwd) skip_value=1; continue ;;
          --cwd=*) continue ;;
          --json) continue ;;
          --help|-h) terminal=1; continue ;;
          --) delimiter_seen=1; continue ;;
          -*) group_ambiguous=1; continue ;;
        esac
      fi
      case " $pt_commands " in
        *" $word "*) command=$word ;;
        *) group_ambiguous=1 ;;
      esac
      phase=child
      continue
    fi
    if [[ $phase == child ]]; then
      if (( skip_value )); then skip_value=0; continue; fi
      if (( terminal )); then continue; fi
      if (( ! delimiter_seen )); then
        case $word in
          --cwd) skip_value=1; continue ;;
          --cwd=*) continue ;;
          --json) continue ;;
          --help|-h) terminal=1; continue ;;
          --current-takt-version)
            case $command in inspect|diff|apply|update) skip_value=1 ;; *) group_ambiguous=1 ;; esac
            continue ;;
          --current-takt-version=*)
            case $command in inspect|diff|apply|update) ;; *) group_ambiguous=1 ;; esac
            continue ;;
          --dry-run|--apply|--force)
            case $command in export|apply|update|rollback) ;; *) group_ambiguous=1 ;; esac
            continue ;;
          --expected-plan-id)
            case $command in export|apply|update|rollback) skip_value=1 ;; *) group_ambiguous=1 ;; esac
            continue ;;
          --expected-plan-id=*)
            case $command in export|apply|update|rollback) ;; *) group_ambiguous=1 ;; esac
            continue ;;
          --pack-version|--min-takt-version|--source-commit|--approve-policy|--approve-capability)
            if [[ $command == export ]]; then skip_value=1; else group_ambiguous=1; fi
            continue ;;
          --pack-version=*|--min-takt-version=*|--source-commit=*|--approve-policy=*|--approve-capability=*)
            if [[ $command != export ]]; then group_ambiguous=1; fi
            continue ;;
          --) delimiter_seen=1; continue ;;
          -*) group_ambiguous=1; continue ;;
        esac
      fi
      ((child_operand_count++))
      if [[ $command == list ]] || (( child_operand_count > 1 )); then
        group_ambiguous=1
      fi
    fi
  done
  if [[ $root_command != project-template ]]; then
    if (( root_ambiguous )) || [[ -n $root_child ]]; then
      candidates=""
    else
      case "$root_command" in
reset) candidates="config categories" ;;
workflow) candidates="init doctor" ;;
metrics) candidates="review" ;;
repertoire) candidates="add remove list" ;;
"") candidates="$root_commands project-template" ;;
*) candidates="" ;;
      esac
    fi
  elif (( root_ambiguous || group_ambiguous || terminal )); then
    candidates=""
  elif [[ -n $command ]] && (( delimiter_seen )); then
    candidates=""
  elif [[ -z $command ]]; then
    candidates="$pt_commands --cwd --json"
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
