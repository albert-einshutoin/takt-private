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
- Publication writes `.takt-install-complete` last, fsyncs it and the containing
  directories, then performs a stable bounded tree proof.
- A failed install is detached to a different transaction as `partial` when its
  tree can be proven. The command returns the fixed `RECOVERY_REQUIRED` error;
  it does not expose paths, causes, or source tokens.
- A maintenance transaction writes `complete` only after the renamed tree has
  been proven at its retained location. Physical cleanup is an explicit future
  maintenance operation with its own authorization, never part of add/remove.

An incomplete transaction or an unprovable partial is intentionally preserved
for operator recovery. This trades disk space for the invariant that normal
mutation cannot silently destroy unrecognized bytes.

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
