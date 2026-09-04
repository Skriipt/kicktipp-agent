# Service lock ownership

## Linux and the container deployment

New Service, Configuration, and Auth Profile mutation locks use schema 2 and a Linux kernel `flock`
on a persistent sibling file, `<lock-file>.guard`. The runtime needs the
util-linux `flock` executable on `PATH`. Failure to run it, including a missing
executable or timeout, fails closed rather than falling back to PID probing.

Node opens the guard and passes that descriptor to a short-lived `flock`
helper. Linux associates the lock with the **open file description** shared
by parent and helper. The helper exits; Node retains ownership until it closes
its descriptor or dies. No helper daemon, heartbeat, wall-clock expiry, or PID
identity inference is involved.

Consequently, SIGKILL releases ownership even though JSON metadata remains.
A subsequent process can reclaim schema-2 metadata even if its recorded PID
has been reused, the container hostname changed, or the containers use different
PID namespaces. Conversely, a real competing process holding the same guard
cannot be displaced just because its PID is invisible in another namespace.
Metadata PID and hostname are diagnostic, not proof of ownership.

These guarantees require a shared **local filesystem on the same Linux host**
with working `flock` semantics. Distributed/NFS/SMB storage is not a supported
coordination mechanism. This is not a distributed lock.

**Never unlink, replace, or clean up `.guard` files while any writer may run.**
Their stable inode is the common arbitration point. An empty guard left after
release is expected, not a stale lock to delete. All contenders must use the
same backing directory/inode, not independent copies of it.

Lock metadata is fsynced in an owner-only temporary file and published using an
atomic hard link. A hard crash during its write leaves only a non-authoritative
`<lock-file>.<token>.tmp` file; it does not publish truncated JSON. Such temporary
files may be removed while all writers are stopped. Invalid existing metadata
still fails closed: it could belong to a legacy writer that does not hold a
guard. Valid schema-2 metadata with a missing guard is ambiguous to observation.

Health/status observation opens an existing guard read-only and briefly probes
it without changing metadata, guard contents, or their mtimes. It does not need
a writable mount or create guard files. An observation is a point-in-time
result, not authorization to write; only acquisition grants ownership.

## Upgrade from schema 1

Legacy locks do not hold a kernel guard. A new binary therefore retains the
old conservative checks for **schema-1** records: foreign-host records are
ambiguous and any existing local PID prevents reclamation. Automatically
removing either would risk displacing a real old-version writer.

Before upgrading a deployment with such a stranded lock:

1. Stop every old/new service process and configuration writer that can access
   the shared directory, including containers and automated restart policies.
2. Independently establish that no writer remains. Do not infer that from a
   different hostname, an old timestamp, or one namespace's PID list.
3. Remove only the stranded legacy lock metadata (and legacy `.reclaim`
   metadata, if present), then start the new deployment.

This manual migration also applies to corrupt pre-existing records and the old
PID-only `auth-*.lock` / `.reap` files. Auth mutations now reuse the same lock
implementation so an interrupted session refresh cannot independently strand
the service. Stop all CLI/login/session writers before removing old auth locks.
The change
does **not** claim automatic recovery for legacy PID reuse or legacy foreign
hostnames. Old binaries reject schema-2 records instead of reclaiming them.

## Other platforms

Non-Linux platforms retain schema-1 PID/hostname locking and its limitations:
PID reuse can strand a lock, and a changed hostname is ambiguous. They refuse
schema-2 ownership they cannot probe. Equivalent kernel ownership guarantees on
macOS/Windows need a separately implemented and tested native primitive; no
unsafe heuristic fallback is introduced here.

## Regression checks

`npm test -- tests/service-lock.test.ts tests/service-store.test.ts`

Dedicated Linux tests use real Node child processes and SIGKILL, including a
crash during metadata writing and simultaneous recovery contenders. PID reuse
and a changed hostname are simulated by editing the diagnostic fields after a
real owner's death; tests do not force the kernel PID counter to wrap. Live-owner
exclusion is also checked with misleading PID/hostname metadata. A read-only-open
test verifies observation's filesystem access mode; actual Docker PID-namespace
and read-only bind-mount smoke tests are separate deployment checks.
