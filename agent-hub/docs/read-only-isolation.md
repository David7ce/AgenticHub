# Read-only isolation: candidate design

Status: research only, 2026-11-16. No sandbox has been configured or verified
for Agent Hub. Restricted ACP dispatches remain blocked.

## Two different guarantees

1. **No writes:** the worker cannot change host or project files outside
   explicitly disposable locations.
2. **Confidentiality:** the worker cannot read files outside the authorized
   input set, including credentials and other agents' memory.

The first does not imply the second. Tool prompts, working directories, Git
worktrees, and model instructions are not operating-system boundaries. The
existing ACP policy cannot guarantee either when the agent executes tools
without requesting permission. Never copy tokens into a test sandbox or widen
an agent's consent to make a test work.

## Narrow design to evaluate: one Codex adapter in a disposable VM

**Design only, not implemented or approved for execution.** The candidate is
Codex ACP, selected because it is already part of the hub; neither its current
installation nor subscription is known to work in this design. Do not build a
general sandbox framework or change the existing fail-closed policy on this basis.

- **Trust boundary:** the host hub remains outside; a disposable guest runs the
  adapter, agent, tools and children under an unprivileged guest account. A VM
  gives a separate guest kernel, unlike a process sandbox sharing its kernel;
  hypervisor and integration vulnerabilities remain possible. Separate hardware
  may reduce shared-host exposure but does not eliminate supply-chain, network
  or human-transfer risks.
- **Inputs and output:** transfer only an explicitly reviewed synthetic fixture
  into the guest, not a host home directory, repository mount or credentials.
  No shared folders, clipboard, device passthrough or host services by default.
  Return a bounded result as untrusted data for review, never execute or apply
  guest output automatically. Output and logs are themselves potential
  exfiltration channels, including via the hub or model provider.
- **Network and identity:** start with no guest network for boundary tests.
  Cloud models need connectivity somewhere: offline operation requires a local
  model, while a host-side model broker or limited egress introduces a trusted
  channel that can carry input data out. A destination allowlist alone does not
  prevent data leakage through an allowed provider. Broker compatibility with
  Codex ACP, subscription terms, identity, billing, rate limits and abuse
  controls are unknown; do not copy tokens, reuse credentials in a guest, or
  silently substitute paid API access. If no supported channel exists, stop.
- **ACP and MCP:** any host/guest control channel must be explicitly scoped to
  a single run, authenticated and independently reviewed; do not expose a
  general host shell, file service or MCP server. Disable guest MCP/plugins by
  default and treat each enabled integration as a separate authority boundary.
  Host-side broker and ACP endpoints must not become generic network or file
  proxies. Audit environment variables, inherited handles, sockets and service
  endpoints end to end; clearing the guest environment alone is insufficient.
- **Lifecycle:** start from a known guest image and disposable state; define
  who can start or stop it and verify termination of the guest and its children.
  Cancellation acknowledgment alone does not undo prior actions or prove the
  guest stopped. Preserve host audit records, redact sensitive content, and
  explicitly decide how results and guest state are retained or disposed of.

Acceptance requires synthetic canaries for direct and indirect host access,
outside reads and writes, host services, network and allowed-channel leakage,
MCP, handles, child processes, failure-before-start, cancellation and resume,
followed by an independently inspected, specifically authorized real-adapter
test. Tests are evidence for their scope, not proof against all escapes.
Until integration and the relevant guarantees are verified, **restricted ACP
dispatches remain blocked** and Hermes remains disabled. Creating or configuring
a VM, installing guest software, changing network or authentication, running a
real agent, or disposing of retained state needs appropriate owner approval.

## Candidates

| Candidate                   | Documented property                                                                                    | Unverified or limiting factor                                                                                                                                                                                                                                                             |
|-----------------------------|--------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Codex native sandbox        | OpenAI documents `read-only` and Windows-native sandbox implementations for commands and subprocesses. | Which implementation actually runs on this machine, whether the ACP adapter uses it, treatment of built-in tools, plugins and MCP, and read confidentiality all need testing. `read-only` alone is not a directory-read boundary.                                                         |
| OpenCode policy             | OpenCode v2 supports explicit `edit`, `shell`, MCP and external-directory rules.                       | Its docs say shell has host authority and directory inference is best-effort. Policy and plugin coverage must not be assumed to be an OS sandbox.                                                                                                                                         |
| Claude Code modes and rules | Claude documents plan mode and rules for file, shell and MCP tools.                                    | Its docs warn that path rules do not cover arbitrary subprocess access; native settings or allowed tools can bypass a hub permission request. Plan mode alone is not an OS boundary.                                                                                                      |
| Windows Sandbox             | Microsoft documents hypervisor isolation and read-only mapped folders.                                 | The executable exists locally, but availability was not tested. Host tools are not automatically installed, networking is on by default, and closing the sandbox discards its state. Authentication and ACP transport are unresolved. Microsoft says only one instance can run at a time. |
| WSL 2                       | `wsl --status` reported Ubuntu and WSL 2.                                                              | A distribution is not automatically a sandbox. Host mounts, credentials, network and user permissions require separate controls and evidence.                                                                                                                                             |

Codex's documented Windows implementations differ: `unelevated` does not
support denied read paths and has weaker network isolation than `elevated`;
`elevated` requires administrator-approved setup; `mxc` depends on supported
Windows capabilities. Availability and effective selection here are unknown.
An executable on PATH does not establish that a feature is enabled or safe.

## Local compatibility probe

On 2026-11-16, with owner authorization and without changing saved sandbox
selection, the documented one-command MXC probe was run in an existing
temporary directory. Local CLI: `codex-cli 0.167.2`; Windows version reported
by .NET: `10.0.26200.0` (no revision was established). The command was:

```powershell
codex -c windows.sandbox=mxc sandbox --include-managed-config --permission-profile :workspace -- cmd.exe /d /c echo MXC_OK
```

It exited 1 with `failed to prepare MXC sandbox: native MXC is unavailable on
this executor`. `MXC_OK` was not produced. This only establishes that MXC
could not be prepared in that execution environment; it does not determine
whether the host or a normal user terminal can support it. No agent,
credentials, file-boundary tests, saved configuration changes or legacy
fallback were involved. The global fail-closed gate remains in place.

## WSL bubblewrap preliminary probe

On the same date, Ubuntu under WSL 2 reported kernel
`6.18.58.1-microsoft-standard-WSL2` and `bubblewrap 0.11.1`. A minimal
`bwrap --ro-bind / / --proc /proc --dev /dev -- /bin/echo BWRAP_OK`
completed. A second invocation with the same mounts attempted `touch` on a
synthetic target in the approved Windows temporary directory. It failed with
`Read-only file system`, and the target was independently confirmed absent.

**This is not a secure agent sandbox configuration.** Binding all of `/`
read-only exposes its readable content, potentially including host mounts and
credentials. The probe did not constrain or test outside reads, networking,
MCP servers, sockets, other write paths, child processes, cancellation, or any
agent/ACP integration. It does not satisfy the user's Hermes authorization.
No real agent was started, no existing data were used as test targets, and no
system policies or saved sandbox settings were changed.

## Synthetic path-boundary probe

Still on 2026-11-16, an owner-authorized test used new synthetic files in the
approved temporary directory. No agent or real secret was involved. A minimal
WSL `bwrap --unshare-all` process mounted the host's `/usr` read-only, created
`/proc`, `/dev` and a private `/tmp`, and mounted only the synthetic `allowed`
directory as `/input` read-only. The host's `/mnt/c` and the synthetic
`outside` directory were not mounted.

| Probe | Observed result |
|---|---|
| Read `/input/public.txt` | Succeeded and returned the synthetic marker. |
| Read outside marker by absolute host path | Failed: path not present. |
| Read `../outside/canary.txt` | Failed: path not present. |
| Read `/input/outside-link` pointing at the outside host path | Failed; the same link was separately confirmed to resolve to the marker outside the sandbox. |
| Create `/input/blocked.txt` | Failed with read-only filesystem; host target confirmed absent. |
| Modify metadata of `/input/public.txt` | Failed with read-only filesystem. |
| Create `/tmp/ephemeral.txt` | Succeeded inside the sandbox's private temporary filesystem. |

This is evidence for the tested **fixture and commands only**. `/usr` is still
host content and is not an attested minimal runtime. The test did not exercise
Windows junctions, alternative host mounts, MCP servers, sockets, network
access, arbitrary child processes, cancellation, or actual agents. `--unshare-all`
was used, but no network-denial test was performed. The result must not be used
to enable Hermes or relax the ACP gate. The fixture and link were retained.

## Synthetic child-process, network and cancellation probes

With the same minimal WSL namespace and owner authorization:

- A Python child invoked `touch /input/child-blocked.txt`; it failed with a
  read-only filesystem and the host-side target was absent.
- A synthetic TCP listener bound to WSL host `127.0.0.1` on an ephemeral port.
  The control connection from outside bubblewrap succeeded; a connection to
  the same address and port from `--unshare-all` failed with
  `ConnectionRefusedError`. This tests host-loopback separation only: it is
  not proof that every network route, inherited socket or MCP bridge is blocked.
- A deliberately missing bind source caused bubblewrap startup to fail; a
  marker that the command would have written in the synthetic output directory
  was absent. This validates this invocation's failure-before-exec, not the
  hub's eventual integration.
- For cancellation, a synthetic Python process started a `sleep 12` child in
  a `--die-with-parent --unshare-all` sandbox. The external harness observed
  three descendants, terminated the bubblewrap wrapper and, after one second,
  found none of the observed descendants live. The sleep was time-bounded. This
  single process-tree observation is not proof for escaped processes, provider
  daemons, interrupted writes, Windows-native agents or all cancellation races.

The fixture scripts are retained in the approved temporary directory. No real
agent, existing credentials, external network service, system policy change,
or actual project was used. Keep the ACP gate in place.

## Environment and inherited-descriptor probes

Using a synthetic environment variable and no agent, `bwrap` inherited that
variable by default. With `--clearenv --setenv PATH /usr/bin`, the variable was
absent while the explicitly set `PATH` remained available. Clearing the
environment is therefore necessary to avoid accidentally passing ambient
credentials, but the agent's actual minimum environment and authentication
requirements remain unknown.

In a separate synthetic test, the launcher opened the outside marker and
**explicitly passed its file descriptor** to bubblewrap. The isolated Python
process read the marker through that descriptor even though its host path was
not mounted. When the launcher used `close_fds=True` and did not pass the
descriptor, reading that descriptor failed with `EBADF` (errno 9). This shows
that path isolation does not revoke already-open handles. It does not establish
what Node, WSL, ACP, MCP, stdin/stdout or a particular adapter actually inherits;
each launcher and intentionally passed pipe/socket must be audited and tested.
The synthetic fixture scripts remain in the approved temporary directory.

## Proposed acceptance protocol

Start with disposable data and an unprivileged, explicitly authorized test;
do not change the existing grants or authentication as part of a probe.

1. Record OS, runtime and adapter versions, effective sandbox and approval
   settings, without printing configuration secrets or token stores.
2. Place synthetic markers in an allowed input directory and outside it.
   Never use an actual `.env`, credential, or private memory as a test target.
3. Test direct file tools, shell and child processes, absolute and relative
   paths, parent directories, temporary directories, symlinks/junctions,
   plugins and MCP tools. Independently inspect resulting files and processes.
4. Separately verify allowed input reads, blocked outside reads, blocked writes,
   network policy, resume, mode switching, cancellation and concurrent runs.
   Record unknowns and failures; an agent declining to try is not proof.
5. Verify the hub passes the intended settings at **session creation** and
   continuation, rejects missing or weaker enforcement, and cannot silently
   fall back. Repeat against actual installed versions for each adapter.
6. Keep the global fail-closed gate until the specific guarantee is verified.
   A write-only boundary cannot satisfy the narrower Hermes authorization to
   read only inside a temporary directory.

Testing a local sandbox or changing system features, accounts, ACLs, firewall
rules, settings or authentication needs the owner's authorization appropriate
to that action. Never disable security protections to make a test pass.

## Sources

- [Codex sandboxing](https://developers.openai.com/codex/sandboxing.md)
- [Codex Windows sandbox](https://developers.openai.com/codex/windows.md)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [OpenCode v2 permissions](https://opencode.ai/docs/permissions/)
- [Microsoft Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/)

## OpenCode v2.3.2: native read-only via project config (2026-11-19)

Live tests with `opencode run -m opencode-go/deepseek-v4.1-flash`, each asked to
create `marker.txt` and to try shell, subagents and MCP:

| How the rules were supplied | Result |
| --- | --- |
| Old-style `{"permission":{"edit":"deny","bash":"deny"}}` in `OPENCODE_CONFIG_CONTENT` | Ignored: wrote four files, ran shell, and dispatched an `allow-all` worker through the agent-hub MCP. |
| V2 `permissions` array (catch-all deny, then allow `read`/`glob`/`grep`) in `opencode.json` **inside the working directory** | Enforced: the agent only had `read`, `glob`, `grep` and `skill`; no `marker.txt`, no shell, no MCP, no Code Mode, no subagents. It read `seed.txt`. |
| Same array via `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG` or `OPENCODE_CONFIG_DIR` | Ignored: `marker.txt` was written. |

Consequences: the catch-all deny also removes the `agent-hub` MCP, so a
read-only worker cannot escalate by dispatching another agent. Only the
project-level file worked here, so a hub implementation would have to place it
in a disposable worktree/copy (never overwrite a project's own `opencode.json`)
and verify at session creation that the effective tool list has no write tool.
This is tool removal inside OpenCode, not an OS sandbox: it does not cover
confidentiality, and it applies to OpenCode only. Claude and Codex remain
fail-closed.

**Implemented 2026-11-19** in `acp/readonly.mjs`: `deny` and `allow-reads` now run for the native OpenCode ACP adapter in a stable scratch directory (`%TEMP%/agenthub-readonly\<hash>`) holding the profile above, with reads re-allowed only for the authorized tree via `external_directory`. The prompt is prefixed with the real project path. After the run, any completed `edit`/`delete`/`move`/`execute` tool marks the run `failed` ("read-only guarantee violated"). Verified through `hub-acp` on a disposable project: read of the project file succeeded; file creation, shell, MCP and an outside canary were all unavailable or rejected. Not covered: confidentiality beyond `external_directory`, the `skill` tool, OS-level isolation, Claude, Codex, Hermes.
