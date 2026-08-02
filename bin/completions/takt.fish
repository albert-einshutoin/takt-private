# fish completion for takt project-template
# Public options: --cwd --json --dry-run --apply --expected-plan-id --force --approve-policy --approve-capability
set -l root_commands release-info run watch add list resume clear eject reset prompt export-cc export-codex catalog workflow metrics purge repertoire
set -l pt_commands export inspect diff apply update rollback list

function __takt_matches_commandline --argument-names expected_root expected_child
  set -l argv_words (commandline -opc)
  set -e argv_words[1]
  set -l short_options_with_value i w b t
  set -l short_boolean_options q c h V
  set -l phase root
  set -l root_command
  set -l root_child
  set -l command
  set -l skip_value 0
  set -l delimiter_seen 0
  set -l root_ambiguous 0
  set -l group_ambiguous 0
  set -l terminal 0
  set -l child_operand_count 0
  for word in $argv_words
    if test $terminal -eq 1
      continue
    end
    if test $skip_value -eq 1
      set skip_value 0
      continue
    end

    if test "$phase" = root -o "$phase" = legacy
      if test $delimiter_seen -eq 1
        if test "$phase" = root
          set root_command $word
          if test "$word" = project-template
            set phase group
          else
            set phase legacy
          end
        else if test -z "$root_child"
          set root_child $word
        end
        continue
      end

      switch $word
        case --issue --pr --workflow --branch --repo --provider --model --task --isolation --cwd
          set skip_value 1
          continue
        case '--issue=*' '--pr=*' '--workflow=*' '--branch=*' '--repo=*' '--provider=*' '--model=*' '--task=*' '--isolation=*' '--cwd=*'
          continue
        case --help --version
          set terminal 1
          continue
        case --auto-pr --draft --pipeline --copy-workspace --skip-git --quiet --continue
          continue
        case '--auto-pr=*' '--draft=*' '--pipeline=*' '--copy-workspace=*' '--skip-git=*' '--quiet=*' '--continue=*'
          continue
        case '--'
          set delimiter_seen 1
          continue
        case '--*'
          set root_ambiguous 1
          continue
        case '-'
          continue
        case '-*'
          set -l short_names (string split '' -- (string sub -s 2 -- $word))
          for short_index in (seq (count $short_names))
            set -l short_name $short_names[$short_index]
            if contains -- $short_name h V
              set terminal 1
              break
            end
            if contains -- $short_name $short_boolean_options
              continue
            end
            if contains -- $short_name $short_options_with_value
              if test $short_index -eq (count $short_names)
                set skip_value 1
              end
              break
            end
            set root_ambiguous 1
            break
          end
          continue
        case project-template
          if test "$phase" = root -a $root_ambiguous -eq 0
            set root_command project-template
            set phase group
          else if test "$phase" = legacy -a -z "$root_child"
            set root_child $word
          end
          continue
        case '*'
          if test "$phase" = root
            set root_command $word
            set phase legacy
          else if test -z "$root_child"
            set root_child $word
          end
          continue
      end
    end

    if test "$phase" = group
      if test $terminal -eq 1
        continue
      end
      if test $delimiter_seen -eq 0
        switch $word
          case --cwd
            set skip_value 1
            continue
          case '--cwd=*'
            continue
          case --json
            continue
          case --issue --pr --workflow --branch --repo --provider --model --task --isolation
            set skip_value 1
            continue
          case '--issue=*' '--pr=*' '--workflow=*' '--branch=*' '--repo=*' '--provider=*' '--model=*' '--task=*' '--isolation=*'
            continue
          case --help --version
            set terminal 1
            continue
          case --auto-pr --draft --pipeline --copy-workspace --skip-git --quiet --continue
            continue
          case '--'
            set delimiter_seen 1
            continue
          case '-'
            set group_ambiguous 1
            continue
          case '-*'
            set -l short_names (string split '' -- (string sub -s 2 -- $word))
            for short_index in (seq (count $short_names))
              set -l short_name $short_names[$short_index]
              if contains -- $short_name h V
                set terminal 1
                break
              end
              if contains -- $short_name q c
                continue
              end
              if contains -- $short_name $short_options_with_value
                if test $short_index -eq (count $short_names)
                  set skip_value 1
                end
                break
              end
              set group_ambiguous 1
              break
            end
            continue
        end
      end
      if contains -- $word $pt_commands
        set command $word
      else
        set group_ambiguous 1
      end
      set phase child
      continue
    end

    if test "$phase" = child
      if test $terminal -eq 1
        continue
      end
      if test $delimiter_seen -eq 0
        switch $word
          case --cwd
            set skip_value 1
            continue
          case '--cwd=*'
            continue
          case --json
            continue
          case --issue --pr --workflow --branch --repo --provider --model --task --isolation
            set skip_value 1
            continue
          case '--issue=*' '--pr=*' '--workflow=*' '--branch=*' '--repo=*' '--provider=*' '--model=*' '--task=*' '--isolation=*'
            continue
          case --help --version
            set terminal 1
            continue
          case --auto-pr --draft --pipeline --copy-workspace --skip-git --quiet --continue
            continue
          case --current-takt-version
            if contains -- $command inspect diff apply update
              set skip_value 1
            else
              set group_ambiguous 1
            end
            continue
          case '--current-takt-version=*'
            contains -- $command inspect diff apply update; or set group_ambiguous 1
            continue
          case --dry-run --apply --force
            contains -- $command export apply update rollback; or set group_ambiguous 1
            continue
          case --expected-plan-id
            if contains -- $command export apply update rollback
              set skip_value 1
            else
              set group_ambiguous 1
            end
            continue
          case '--expected-plan-id=*'
            contains -- $command export apply update rollback; or set group_ambiguous 1
            continue
          case --pack-version --min-takt-version --source-commit --approve-policy --approve-capability
            if test "$command" = export
              set skip_value 1
            else
              set group_ambiguous 1
            end
            continue
          case '--pack-version=*' '--min-takt-version=*' '--source-commit=*' '--approve-policy=*' '--approve-capability=*'
            test "$command" = export; or set group_ambiguous 1
            continue
          case '--'
            set delimiter_seen 1
            continue
          case '-'
            set group_ambiguous 1
            continue
          case '-*'
            set -l short_names (string split '' -- (string sub -s 2 -- $word))
            for short_index in (seq (count $short_names))
              set -l short_name $short_names[$short_index]
              if contains -- $short_name h V
                set terminal 1
                break
              end
              if contains -- $short_name q c
                continue
              end
              if contains -- $short_name $short_options_with_value
                if test $short_index -eq (count $short_names)
                  set skip_value 1
                end
                break
              end
              set group_ambiguous 1
              break
            end
            continue
        end
      end
      set child_operand_count (math $child_operand_count + 1)
      if test "$command" = list -o $child_operand_count -gt 1
        set group_ambiguous 1
      end
    end
  end

  # Why: every completion predicate must validate the full argument prefix. This
  # prevents a later unknown option or positional operand from reviving a group.
  test $skip_value -eq 0; or return 1
  test $root_ambiguous -eq 0; or return 1
  test $group_ambiguous -eq 0; or return 1
  test $terminal -eq 0; or return 1
  test -z "$root_child"; or return 1
  test "$root_command" = "$expected_root"; or return 1
  if test -n "$expected_child" -a $delimiter_seen -eq 1
    return 1
  end
  test "$command" = "$expected_child"
end

function __takt_is_root_position
  __takt_matches_commandline '' ''
end

function __takt_is_root_command --argument-names expected
  __takt_matches_commandline $expected ''
end

function __takt_project_template_is_root_command
  __takt_matches_commandline project-template ''
end

function __takt_project_template_is_command --argument-names expected
  __takt_matches_commandline project-template $expected
end

complete -c takt -n '__takt_is_root_position' -a "$root_commands project-template"
complete -c takt -n '__takt_is_root_command reset' -a 'config categories'
complete -c takt -n '__takt_is_root_command workflow' -a 'init doctor'
complete -c takt -n '__takt_is_root_command metrics' -a review
complete -c takt -n '__takt_is_root_command repertoire' -a 'add remove list'
complete -c takt -n '__takt_project_template_is_root_command' -a "$pt_commands"
complete -c takt -n '__takt_project_template_is_root_command' -l cwd -r
complete -c takt -n '__takt_project_template_is_root_command' -l json

for command in inspect diff
  complete -c takt -n "__takt_project_template_is_command $command" -l cwd -r
  complete -c takt -n "__takt_project_template_is_command $command" -l json
  complete -c takt -n "__takt_project_template_is_command $command" -l current-takt-version -r
end

complete -c takt -n '__takt_project_template_is_command list' -l cwd -r
complete -c takt -n '__takt_project_template_is_command list' -l json

for command in export apply update rollback
  complete -c takt -n "__takt_project_template_is_command $command" -l cwd -r
  complete -c takt -n "__takt_project_template_is_command $command" -l json
  complete -c takt -n "__takt_project_template_is_command $command" -l dry-run
  complete -c takt -n "__takt_project_template_is_command $command" -l apply
  complete -c takt -n "__takt_project_template_is_command $command" -l expected-plan-id -r
  complete -c takt -n "__takt_project_template_is_command $command" -l force
end

for command in apply update
  complete -c takt -n "__takt_project_template_is_command $command" -l current-takt-version -r
end
complete -c takt -n '__takt_project_template_is_command export' -l pack-version -r
complete -c takt -n '__takt_project_template_is_command export' -l min-takt-version -r
complete -c takt -n '__takt_project_template_is_command export' -l source-commit -r
complete -c takt -n '__takt_project_template_is_command export' -l approve-policy -r
complete -c takt -n '__takt_project_template_is_command export' -l approve-capability -r
