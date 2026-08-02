# fish completion for takt project-template
# Public options: --cwd --json --dry-run --apply --expected-plan-id --force --approve-policy --approve-capability
set -l root_commands release-info run watch add list resume clear eject reset prompt export-cc export-codex catalog workflow metrics purge repertoire
set -l pt_commands export inspect diff apply update rollback list

function __takt_is_root_command --argument-names expected
  set -l argv_words (commandline -opc)
  set -e argv_words[1]
  set -l short_options_with_value i w b t
  set -l short_boolean_options q c h V
  set -l skip_value 0
  set -l ambiguous 0
  for word in $argv_words
    if test $skip_value -eq 1
      set skip_value 0
      continue
    end
    switch $word
      case --issue --pr --workflow --branch --repo --provider --model --task --isolation --cwd
        set skip_value 1
        continue
      case '--issue=*' '--pr=*' '--workflow=*' '--branch=*' '--repo=*' '--provider=*' '--model=*' '--task=*' '--isolation=*' '--cwd=*'
        continue
      case --auto-pr --draft --pipeline --copy-workspace --skip-git --quiet --continue --help --version
        continue
      case '--auto-pr=*' '--draft=*' '--pipeline=*' '--copy-workspace=*' '--skip-git=*' '--quiet=*' '--continue=*' '--help=*' '--version=*'
        continue
      case '--'
        continue
      case '--*'
        set ambiguous 1
        continue
      case '-'
        continue
      case '-*'
        set -l short_names (string split '' -- (string sub -s 2 -- $word))
        for short_index in (seq (count $short_names))
          set -l short_name $short_names[$short_index]
          if contains -- $short_name $short_boolean_options
            continue
          end
          if contains -- $short_name $short_options_with_value
            if test $short_index -eq (count $short_names)
              set skip_value 1
            end
            break
          end
          set ambiguous 1
          break
        end
        continue
      case '*'
        test $ambiguous -eq 0; and test "$word" = "$expected"
        return
    end
  end
  return 1
end

function __takt_project_template_is_root_command
  __takt_is_root_command project-template
end

complete -c takt -n '__fish_use_subcommand' -a "$root_commands project-template"
complete -c takt -n '__takt_is_root_command reset' -a 'config categories'
complete -c takt -n '__takt_is_root_command workflow' -a 'init doctor'
complete -c takt -n '__takt_is_root_command metrics' -a review
complete -c takt -n '__takt_is_root_command repertoire' -a 'add remove list'
complete -c takt -n '__takt_project_template_is_root_command' -a "$pt_commands"

for command in inspect diff
  complete -c takt -n "__takt_project_template_is_root_command; and __fish_seen_subcommand_from $command" -l cwd -r
  complete -c takt -n "__takt_project_template_is_root_command; and __fish_seen_subcommand_from $command" -l json
  complete -c takt -n "__takt_project_template_is_root_command; and __fish_seen_subcommand_from $command" -l current-takt-version -r
end

complete -c takt -n '__takt_project_template_is_root_command; and __fish_seen_subcommand_from list' -l cwd -r
complete -c takt -n '__takt_project_template_is_root_command; and __fish_seen_subcommand_from list' -l json

for command in export apply update rollback
  complete -c takt -n "__takt_project_template_is_root_command; and __fish_seen_subcommand_from $command" -l cwd -r
  complete -c takt -n "__takt_project_template_is_root_command; and __fish_seen_subcommand_from $command" -l json
  complete -c takt -n "__takt_project_template_is_root_command; and __fish_seen_subcommand_from $command" -l dry-run
  complete -c takt -n "__takt_project_template_is_root_command; and __fish_seen_subcommand_from $command" -l apply
  complete -c takt -n "__takt_project_template_is_root_command; and __fish_seen_subcommand_from $command" -l expected-plan-id -r
  complete -c takt -n "__takt_project_template_is_root_command; and __fish_seen_subcommand_from $command" -l force
end

for command in apply update
  complete -c takt -n "__takt_project_template_is_root_command; and __fish_seen_subcommand_from $command" -l current-takt-version -r
end
complete -c takt -n '__takt_project_template_is_root_command; and __fish_seen_subcommand_from export' -l pack-version -r
complete -c takt -n '__takt_project_template_is_root_command; and __fish_seen_subcommand_from export' -l min-takt-version -r
complete -c takt -n '__takt_project_template_is_root_command; and __fish_seen_subcommand_from export' -l source-commit -r
complete -c takt -n '__takt_project_template_is_root_command; and __fish_seen_subcommand_from export' -l approve-policy -r
complete -c takt -n '__takt_project_template_is_root_command; and __fish_seen_subcommand_from export' -l approve-capability -r
