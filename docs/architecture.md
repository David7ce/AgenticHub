# Arquitectura del hub

STATUS: actual (2026-11-08)

El hub es una capa de gobierno y orquestación entre un cliente (OpenCode,
Claude Code, VS Code…) y varios agentes ACP. No es un modelo ni un proxy de
modelos: decide **quién** trabaja, **dónde**, con **qué permiso** y deja una
línea de auditoría por cada intento.

## Frontera Windows / WSL

```
Windows
  OpenCode Desktop/Web? ─┐
  Claude Code ───────────┤
  VS Code/Copilot ───────┤        ┌───────────────┐   (Agents window: ahp/, aparte)
                         ├──────▶ │  hub-mcp      │  stdio JSON-RPC
  PowerShell / hubctl ───┘        │  (server.mjs) │
                                  └──────┬────────┘
                                         │ consent.json + projects/logs/runs.jsonl
                                  ┌──────▼────────┐
                                  │  hub-acp      │  ACP Client
                                  └──┬───────┬────┘
                    cmd.exe / exe    │       │  npx.cmd / exe
                         ┌───────────▼─┐   ┌─▼──────────────┐
                         │ OpenCode    │   │ Claude, etc.   │
                         │ (Windows)   │   │ (Windows)      │
                         └─────────────┘   └────────────────┘
```

El hub canónico corre en **Windows** porque ahí viven las credenciales de
Claude/Codex y los servicios loopback. OpenCode corre nativo en Windows desde
2026-11-09 (antes se lanzaba con `wsl.exe`); su MCP se arranca desde
[`../../opencode.json`](../../opencode.json) con `cmd.exe /c node
D:\...\server.mjs`.

Un proceso no puede ver los PIDs del otro lado. Los **runs del hub** sí se ven
desde ambos lados porque `results/inflight/` es un fichero; los **agentes
externos** solo se ven desde el host donde corre `hubctl live`.

Codex entra por `@agentclientprotocol/codex-acp@2.6.0` (`npx.cmd` en Windows),
un adaptador mantenido que habla ACP v1 y v2 y arranca Codex App Server. El hub
negocia v1. No hay shim propio.

## Piezas

| Pieza | Qué hace |
|---|---|
| `mcp/server.mjs` | Servidor MCP (stdio). Expone `ask_agent`, `fanout`, `route`, `agents`, `status`, jobs. |
| `acp/hub-acp.mjs` | Cliente ACP: consentimiento, spawn, sesión, prompt, cancelación, presupuesto, auditoría. |
| `ahp/gateway-run.mjs` | Arranca el gateway AHP (host de la ventana de Agents de VS Code) con dos parches propios; cada agente pasa por `ahp/consent-proxy.mjs` (consentimiento, auditoría, topes y modo restringido). |
| `acp/fanout-acp.mjs` | Varios agentes en paralelo, resultado fusionado y síntesis opcional. |
| `acp/router.mjs` | Elige agente/modelo/topología. Hoy es advisory; no lanza por su cuenta. |
| `acp/consent.mjs` + `consent.json` | Puerta: `enabled`, `overseerAck`, expiración. |
| `acp/tree-lock.mjs` | Un escritor por árbol en runs `allow-all`. |
| `acp/paths.mjs` | Única traducción Windows ↔ WSL. |
| `hubctl/` | `status`, `live`, `report`, `run`, `attach`, `worktree`, `bench`, `usage`. |
| `bench/` | Regresión del harness y bench de colaboración. |
| `projects/logs/runs.jsonl` | Auditoría append-only; una línea por intento terminado. |

## Ciclo de una llamada

1. El cliente llama a una herramienta MCP o a `hub-acp`.
2. Se lee `consent.json`: sin grant válido no hay spawn, ni siquiera `--probe`.
3. `router` propone agente y modelo (o el caller los fija).
4. `hub-acp` arranca el agente ACP y crea una sesión con el `cwd` traducido.
5. Mientras trabaja, escribe `results/inflight/<pid>.json` con agente, árbol,
   modelo, herramientas, `updated` y último tool. `hubctl live` lo lee.
6. Si el permiso es `allow-all`, reclama el lock del árbol antes de escribir.
7. Al terminar, escribe una línea en `projects/logs/runs.jsonl` y borra el inflight.
8. Si hay timeout, envía `session/cancel` y espera; `cancelAck: false` significa
   que el árbol puede seguir vivo.

## Memoria y estado

- **Consentimiento**: `consent.json`, por agente.
- **Auditoría**: `projects/logs/runs.jsonl`; rota a los 10 MB.
- **En vuelo**: `results/inflight/<pid>.json`; se borra al salir.
- **Locks**: `results/locks/*.lock`.
- **Worktrees**: `.git/agent-worktrees/`; solo se conservan si hay cambios.
- **Sesiones**: el id va en la respuesta y en la auditoría; `attach` lo reanuda.

## Seguridad

- Los secretos no entran en documentos, logs ni prompts. `.env*` está denegado
  en los harnesses.
- `--permission deny` es el defecto; `allow-all` solo dentro de un worktree.
- Los proveedores gratuitos pueden retener datos: el catálogo marca
  `retention` y el router no manda material sensible a `unknown`/`may-train`.
- El presupuesto por llamada no limita una suscripción; el límite diario y la
  cuota real se controlan aparte.

## Lo que no es

- No es un enrutador OpenAI-compatible.
- No es un daemon: `hubctl` lee ficheros y procesos.
- No es un sustituto de OpenCode: es la capa que lo hace auditable y
  coordinable.
