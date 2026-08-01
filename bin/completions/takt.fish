# fish completion for takt project-template
# Public options: --cwd --json --dry-run --apply --expected-plan-id --force
set -l pt_commands export inspect diff apply update rollback list
complete -c takt -n '__fish_use_subcommand' -a project-template
complete -c takt -n '__fish_seen_subcommand_from project-template' -a "$pt_commands"

for command in inspect diff
  complete -c takt -n "__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from $command" -l cwd -r
  complete -c takt -n "__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from $command" -l json
  complete -c takt -n "__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from $command" -l current-takt-version -r
end

complete -c takt -n '__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from list' -l cwd -r
complete -c takt -n '__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from list' -l json

for command in export apply update rollback
  complete -c takt -n "__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from $command" -l cwd -r
  complete -c takt -n "__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from $command" -l json
  complete -c takt -n "__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from $command" -l dry-run
  complete -c takt -n "__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from $command" -l apply
  complete -c takt -n "__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from $command" -l expected-plan-id -r
  complete -c takt -n "__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from $command" -l force
end

for command in apply update
  complete -c takt -n "__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from $command" -l current-takt-version -r
end
complete -c takt -n '__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from export' -l pack-version -r
complete -c takt -n '__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from export' -l min-takt-version -r
complete -c takt -n '__fish_seen_subcommand_from project-template; and __fish_seen_subcommand_from export' -l source-commit -r
