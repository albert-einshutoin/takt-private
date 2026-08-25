# ADR 0001: Repertoire maintenance transactions

- Status: Accepted
- Date: 2026-08-01

## Context

TaktDesk must install, replace, and remove shared repertoire packages without
destroying data that appeared concurrently. Node's standard filesystem API does
not expose the directory-fd-relative compare-and-swap and recursive unlink
primitives needed to prove every descendant immediately before deletion. A
process running as the same OS user can also change pathnames between otherwise
correct `lstat`, `rename`, and removal calls.

## Decision

Normal repertoire mutations never recursively delete package trees and never
automatically restore an old tree. The writer lease serializes cooperating
TaktDesk processes, while stable bounded tree proofs detect changes by
non-cooperating processes.

- Remove atomically renames the approved active package to
  `~/.takt/.repertoire-maintenance/transactions/<nonce>/payload`.
- Overwrite retains the approved old package as `payload`, exclusively reserves
  the final package directory, and writes only bytes approved through a
  no-follow file descriptor.
- First install also reserves the final directory before writing any bytes.
- Publication fsyncs every approved file and nested directory bottom-up, takes
  a stable bounded live tree proof, writes and fsyncs
  `.takt-install-complete.pending`, renames it to `.takt-install-complete`, then
  fsyncs the package and parent directories. The final marker is never visible
  before content durability and proof succeed.
- A failed install is detached to a different transaction as `partial` when its
  tree can be proven. The command returns the fixed `RECOVERY_REQUIRED` error;
  it does not expose paths, causes, or source tokens.
- Before detaching bytes, a maintenance transaction durably writes canonical
  `intent.json`. After rename it fsyncs the source and destination parents,
  proves the retained live tree, and durably writes `outcome.json`. It publishes
  `complete` through `complete.pending` plus file fsync, rename, and directory
  fsync. Startup classification requires the intent, outcome, final witness,
  and retained payload to agree.

Live tree proofs contain host filesystem identity and are used only for the
in-process CAS decision. Persistent intent/outcome records use a portable
canonical summary of relative path, entry type, file size, and content SHA-256;
they never bind device, inode, ctime, or absolute realpath. Consequently a
transaction remains verifiable after an authorized recursive copy to another
TaktDesk root, while changed or added payload bytes make it incomplete.

The classifier first reads and validates bounded metadata for all transactions,
then checks aggregate transaction count, entry count, and byte limits before it
opens any payload. Exceeding a valid aggregate limit returns
`MAINTENANCE_REQUIRED`; malformed or unstable evidence returns
`RECOVERY_REQUIRED`.

An incomplete transaction or an unprovable partial is intentionally preserved
for operator recovery. This trades disk space for the invariant that normal
mutation cannot silently destroy unrecognized bytes.

Maintenance transaction directories are excluded from package discovery,
reference resolution, export, and normal migration payloads. A future explicit
maintenance command may include selected completed transactions in a recovery
bundle or delete them after separate authorization. Until that command exists,
reaching the aggregate limit intentionally blocks new mutations with
`MAINTENANCE_REQUIRED`; normal add/remove never guesses which retained history
is disposable.

## Reader coordination

The writer lease alone does not protect a reader that resolves a package while
it is being detached. Every package-consuming callsite must therefore
participate in the repertoire read lease before this protocol is considered a
complete cross-process migration boundary. Reader inventory and integration are
tracked as a separate implementation group so omissions can be reviewed and
tested explicitly.

## Security boundary

This protocol coordinates compliant TaktDesk processes and fails closed on
observable filesystem instability. It is not a security boundary against a
malicious process with the same UID: such a process can mutate user-owned paths
and files between Node calls. Stronger hostile-same-UID guarantees require a
native helper using directory descriptors and platform-specific primitives, or
OS-level isolation.
