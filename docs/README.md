# Documentation

All commands in these pages run from the repository root unless stated otherwise.
Start with setup, then use the reference for the component you are changing.

| Page | Purpose |
|---|---|
| [Getting started](getting-started.md) | Requirements, first call and chat-client registration |
| [Architecture](architecture.md) | Execution flow, component boundaries and runtime state |
| [Operations](operations.md) | Monitoring, troubleshooting, cancellation and cleanup |
| [Routing](routing.md) | Agent/model selection and quota failover |
| [Chat surfaces](harness.md) | OpenCode and Claude Code integration choices |
| [Dispatch playbook](dispatch-playbook.md) | Delegate or recover a stalled turn |
| [Reference index](reference/README.md) | ACP, MCP, CLI, configuration and agent integration |
| [Benchmarks](benchmarks/README.md) | Offline checks, measured workflow and collaboration reports |
| [Decisions](decisions.md) | Architectural choices and reasons |
| [Runtime audit requirements](tetragon-runtime-security.md) | Constraints on audit changes |

## Maintenance

Each subject has one authoritative page. Setup belongs in Getting started;
command and tool details belong in the references; operations explains how to
use them together. The root README and AGENTS.md are short entry points.

Put benchmark scripts, fixtures and JSON data in `bench/`; put written reports in
`docs/benchmarks/`. Keep runtime output and personal notes outside tracked docs.
Older versions remain in Git history. Date measured results and distinguish them
from current behavior. Prefer upstream documentation for third-party CLI manuals.

`npm run docs:check` validates relative file links in README.md, AGENTS.md and
`docs/` without requiring a configured agent. Templates are checked after they
are rendered by the workspace setup tests. External sites and heading anchors
are not checked. Update links in the same change that moves a document.
