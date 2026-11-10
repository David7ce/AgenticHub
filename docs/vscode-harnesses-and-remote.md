# VS Code harnesses and remote sessions: what they change for the hub

Read 2026-10-29 against VS Code 1.144.0 on this machine. Sources: the official
[agent harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses),
[remote agent sessions](https://code.visualstudio.com/docs/agents/run/remote-agent-sessions),
[remote tunnels](https://code.visualstudio.com/docs/remote/tunnels), and
[AI security](https://code.visualstudio.com/docs/agents/run/security) pages.
Docs are dated 2026-10-28; treat details as moving.

## The session target list

The **Session Target** control offers targets whose requirements are met in the
current window:

| Target      | What actually runs                                                    | Practical difference                                                                     |
|-------------|-----------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| **Copilot** | Copilot SDK in the Agent Host                                         | Survives closing the editor window; continues across supported Copilot interfaces        |
| **Local**   | VS Code's built-in harness in the extension host                      | Tied to the editor window; closing it stops the work; not available in the Agents window |
| **Claude**  | Anthropic Claude Agent SDK integrated into VS Code                    | Claude project config; current workspace or an isolated worktree                         |
| **Codex**   | OpenAI Codex via its extension or experimental Agent Host integration | Interactive or background coding, depending on integration                               |
| **Cloud**   | Copilot harness on managed cloud compute                              | An *execution target*, not a harness; experimental; separate workspace                   |

Two distinctions matter for our setup:

1. **Harness ≠ model.** Selecting a Claude model inside the Copilot harness
   still uses the Copilot harness. Our bridge exposes *models*, not harnesses.
2. **Local is a harness name, not "runs on my machine."** Copilot, Claude and
   Codex can all run on this machine too.

Handoffs only go one way: a Local session can hand off to Copilot, Claude or
Codex and carries its conversation; those harnesses cannot hand off onward.

## Where a loopback model provider works

- **Local sessions** can use a BYOK model provider such as our Custom Endpoint.
  This is the default, supported path. The bridge's agent mode uses the
  Claude/OpenCode logins that already exist on the machine, so no API key is
  involved at all.
- **Copilot harness sessions** need the experimental
  `chat.agentHost.byokModels.enabled` setting before BYOK models appear. It is
  now enabled on this machine.
- **Claude and Codex harnesses** authenticate through their own provider
  accounts; a Custom Endpoint model provider is not their auth path.
- **Cloud sessions** run on managed compute, so `127.0.0.1:3010` there is not
  this machine. The bridge cannot serve a cloud session without exposing it.

The security page adds a related warning: agent sandboxing and its network
policy are Copilot-harness features. Local-harness sessions do not enforce the
same runtime sandbox and permission rules. That is the same gap the
[Tetragon review](tetragon-runtime-security.md) describes, from the other side.

## Dev tunnels

`code tunnel` (or **Remote Tunnels: Turn on Remote Tunnel Access**) installs the
VS Code Server on this machine and exposes it through Microsoft dev tunnels.
The browser Agents window at `insiders.vscode.dev/agents` can then connect to
this machine's sessions.

What it is **not**: a way to publish port 3010. In a remote session the agent
host stays on this machine and the client only carries chat and control
traffic, so a loopback bridge is still reachable to the agent host. Tunnels
carry the client connection, not the model request.

Security rules from the docs:

- Require tunnel authentication. Anonymous tunnels are explicitly called out as
  dangerous, especially with auto-approval, because anyone with the URL can
  drive an agent with your credentials.
- Tunnels are authenticated with the same GitHub or Microsoft account on both
  ends; the connection is end-to-end encrypted over SSH inside the tunnel.
- A tunnel only stays reachable while VS Code or the tunnel service runs on the
  host.

## GitHub Environments (Preview)

Registering this machine with a GitHub account makes its agent sessions
discoverable from other supported Copilot clients (VS Code, Copilot app,
Copilot CLI, GitHub.com, GitHub Mobile). It does **not** provision a machine or
copy the workspace.

What to weigh before using it:

- Connected clients get **trusted-owner access** to the host's sessions, tools
  and workspace.
- Session actions are mirrored to GitHub for catalog and history storage.
- Conversation content is **not end-to-end encrypted**.
- The host must stay awake, online, and running its agent host.
- Both ends must use the same GitHub account.

For a single-user workstation this is the cleanest way to reach *this machine's*
bridge from another device without exposing the bridge to the internet: the
agent host, and therefore the loopback call, stays here. It is still a Preview
feature with a data-handling trade-off, so it is a deliberate choice, not a
default.

## SSH and remote delegation

- **SSH** connects the Agents window to a remote host; the agent runs there.
- **Dev Container** sessions can run over SSH, tunnel or WSL.
- **Remote delegation** (experimental, `chat.remoteSessions.tools.enabled`) lets
  an agent list hosts and create/message sessions on them. It does not clone the
  coordinating workspace.

None of these replace the hub. The hub drives CLI agents over ACP; VS Code
drives its own harnesses. They can share a machine, a bridge and an audit
discipline, but they are separate orchestration paths.

## Decisions this suggests

1. **Keep the bridge Local-only until there is a reason not to.** Local sessions
   support BYOK without an experimental flag. Enabling
   `chat.agentHost.byokModels.enabled` is a separate, reversible choice.
2. **Do not expose port 3010 through a tunnel.** It is unnecessary for remote
   and tunnel sessions, and it turns a local proxy with an API key into a
   reachable service.
3. **Treat GitHub Environments as the cross-device option**, only if you want
   this machine's sessions on another client. Accept that it is Preview, shares
   session actions with GitHub, and is not end-to-end encrypted.
4. **Do not assume VS Code's sandbox covers the hub.** Copilot-harness
   sandboxing is not applied to Local-harness sessions, and the hub's ACP path
   has no sandbox at all. Worktrees isolate files, not network access.

## Open questions

- Does a remote client's Copilot-harness session execute model calls on the
  host, or route them through the service? The docs say the agent host and
  tools stay on the host, which implies the former; verify before relying on a
  loopback bridge from another device.
- Whether the experimental BYOK-in-Copilot-harness path will keep the same
  `chatLanguageModels.json` shape. It is experimental; expect movement.
