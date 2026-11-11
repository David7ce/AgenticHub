# Operaciones — lanzar, hablar, observar y arreglar

STATUS: actual (2026-11-08)

## Dónde correr

- **Hub y hubctl**: Windows. Ahí están Claude, los servicios loopback y las
  credenciales.
- **OpenCode**: Windows, nativo (`opencode.cmd acp`). El hub lo lanza
  directamente; WSL ya no interviene (cambio del 2026-11-09).
- **MCP de OpenCode**: `opencode.json` del repo usa `cmd.exe /c node`, que
  funciona tanto desde WSL como desde Windows. Si `opencode mcp list` no dice
  `agent-hub connected`, esa es la primera cosa a revisar.

## La combinación recomendada

**Windows Terminal con dos paneles**:

1. izquierda: PowerShell → `opencode` (hablar y lanzar);
2. derecha: PowerShell → `node ...\hubctl\hubctl.mjs live` (ver).

No hay una app única que lance, converse y observe respetando consentimiento,
auditoría y locks. OpenCode es la superficie de chat; `hubctl live` es el visor.
`opencode serve` levanta la web v2 si quieres navegador; la config del repo
aplica igual.

## Cola de tareas

`hubctl tasks` es la cola fina: un SQLite local (`projects/logs/hub.db`), sin daemon y sin
grafo de dependencias. No lanza agentes por su cuenta: cada tarea pasa por
`hub-acp`, así que consentimiento, `writeTrees`, presupuesto y auditoría siguen
en el mismo sitio. Cada tarea corre en su propio worktree; el árbol vivo no se
toca.

```powershell
node agent-hub/hubctl/hubctl.mjs tasks add --repo D:\repo --agent opencode --prompt-file tarea.txt
node agent-hub/hubctl/hubctl.mjs tasks run --parallel 2
node agent-hub/hubctl/hubctl.mjs tasks list
node agent-hub/hubctl/hubctl.mjs tasks done <id> --evidence diff.patch
```

Estados: `queued → running → review → done`; `blocked` y `cancelled` se
recuperan con `retry`. `review` no es `done`: cerrar exige `--evidence`. Cada
línea de auditoría de una tarea lleva `taskId`, y el resultado completo queda en
`projects/logs/tasks/<id>.json`. El claim es una transacción `BEGIN IMMEDIATE`, así que dos
terminales no cogen la misma fila.

## Si se acaba la cuota de Claude

Claude Code no puede cambiar su modelo: si la cuota de Anthropic está agotada,
la sesión deja de responder y sus subagentes tampoco ayudan (gastan la misma
cuota). El hub sigue disponible; cambia de superficie:

1. **OpenCode** (fallback principal): desde cualquier repo,
   `opencode` con `opencode-go/deepseek-v4.1-flash`. El MCP global ya apunta al
   hub de Windows y funciona fuera de AgentHub.
2. **Codex CLI** (segunda cuota): `codex exec --approve-for-me ...`. Tiene
   `agent-hub` como MCP global; `--approve-for-me` es necesario para que Codex
   acepte las llamadas MCP en modo no interactivo.
3. **`hubctl run`** para scripts: `hubctl run opencode --prompt "..."` o
   `hubctl run codex --prompt "..."`.

El consentimiento, la auditoría y los locks son los mismos. Cuando vuelva la
cuota de Claude, Claude Code puede seguir usando el hub como hasta ahora.

## Lanzar

```powershell
# un agente, por el hub
node agent-hub/hubctl/hubctl.mjs run opencode --worktree --prompt "..."

# escalado
node agent-hub/hubctl/hubctl.mjs run claude --model sonnet --prompt "..."

# revisión read-only
node agent-hub/hubctl/hubctl.mjs run claude --model sonnet --permission deny --prompt "Revisa este diff"

# Codex: probe (initialize + session/new, sin prompt) y prueba mínima
node agent-hub/acp/hub-acp.mjs --agent codex --probe --cwd D:\Workspaces\AgentHub
node agent-hub/acp/hub-acp.mjs --agent codex --prompt "Reply with exactly: CODEX_OK" --cwd D:\Workspaces\AgentHub --permission deny --json
node agent-hub/hubctl/hubctl.mjs models --codex   # última versión por familia vs models.json

# varios agentes, cada uno en su worktree
node agent-hub/acp/fanout-acp.mjs --agents opencode,claude --worktree --prompt "..."
```

Desde el chat, las herramientas MCP `ask_agent`, `fanout`, `route`, `agents` y
`status` hacen lo mismo con consentimiento y auditoría.

## Observar

```powershell
node agent-hub/hubctl/hubctl.mjs status          # salud y consentimientos
node agent-hub/hubctl/hubctl.mjs live            # quién trabaja ahora
node agent-hub/hubctl/hubctl.mjs live --once --json
node agent-hub/hubctl/hubctl.mjs report --days 7 # histórico por agente/modelo
node agent-hub/hubctl/hubctl.mjs spend --days 7   # tokens por proyecto y día
node agent-hub/hubctl/hubctl.mjs doctor          # coherencia de config; empieza aquí
```

- `doctor`: registro vs consent, `limits`, expiraciones, presupuesto escrito vs
  aplicado, enlaces rotos en docs actuales, inflight/locks huérfanos y
  `opencode mcp list`. Sale con 1 si hay algún `FAIL`.

- `live`: inflight, locks, cambios por `fs.watch`, procesos externos y últimos
  runs. `stalled` = 15 min sin updates, salvo tool `running`; en modo
  interactivo suena una campana una vez por run que se queda atascado.
- `report`: OK/fallos/timeouts, p50/p95, coste y último run, más los fallos por
  causa (`quota`, `auth`, `network`, `config`, `spawn`, `agent-error`,
  `timeout`, `budget`), porque cada una se arregla distinto.
- `spend`: tokens por proyecto y día. OpenCode es exacto leyendo su DB local;
  si en Windows no está, se la pide a la copia de WSL automáticamente.
  `OPENCODE_DB`/`--db` la sobrescriben. Claude es cost-only; los runs desde 2026-11-08 llevan `cwd` y
  salen con proyecto, los anteriores quedan `unknown`. Codex queda para la
  siguiente fase.
- `projects/logs/runs.jsonl`: auditoría completa; no se edita.

## Bench

```powershell
node agent-hub/bench/run.mjs --dry-run
node agent-hub/bench/run.mjs --agent opencode --model opencode-go/deepseek-v4.1-flash --tasks paths-to-wsl,router-decide --reps 1 --keep
node agent-hub/bench/collab.mjs --real --write
```

- `bench/run.mjs`: capacidad de reconstruir una función desde sus tests.
- `bench/collab.mjs`: comunicación y trabajo en grupo (fan-out, handoff,
  conflicto, stall, live).
- Informes durables: `bench/WORKFLOW.md` y `bench/COLLABORATION.md`.
- Crudos: `results/bench/` (ignorado).

## Worktrees

```powershell
node agent-hub/hubctl/hubctl.mjs worktree
node agent-hub/hubctl/hubctl.mjs worktree --prune
```

Se conservan si tienen cambios. `--force` descarta trabajo: pide permiso antes.

## Problemas típicos

| Síntoma | Causa / arreglo |
|---|---|
| `agent-hub` no conecta en OpenCode | `cmd.exe`/`node` no resuelven o ruta mala; `opencode mcp list`. |
| Claude falla con “Authentication required” | El hub está corriendo en WSL; debe correr en Windows. |
| Codex `-32603` | Se está lanzando el viejo `@zed-industries/codex-acp`; `doctor` lo marca como FAIL. Usar `@agentclientprotocol/codex-acp@2.6.0`. |
| Codex `denied: allow-all is not granted` | `cwd` fuera de `D:/Workspaces/AgentHub` y del temp del bench; es el límite del grant. |
| Codex sin Terra/Luna en `session/new` | No inventarlos: usar Sol y documentarlo; `hubctl models --codex` muestra lo que conoce el Codex local. |
| Hermes falla en `set_config_option` | Modelo sin prefijo `nous:`; además ya no es worker. |
| Timeout largo | `hubctl live` muestra `silent`; cancelar no esperar 40 min. |
| `cancelAck: false` | El árbol puede seguir vivo; no escribir hasta confirmar. |
| Lock ocupado | Otro run `allow-all` en el mismo árbol; usar worktree o esperar. |

## Consentimiento y coste

- `consent.json`: `enabled`, `overseerAck`, `expires` (2027-01-08).
- Sin grant válido no se ejecuta ni `--probe`.
- `limits` (opcional, aplicado por `acp/consent.mjs` en hub-acp, y por tanto
  también en MCP y fanout): `maxPermission`, `writeTrees` (dónde puede correr
  `allow-all`; el temp del sistema siempre vale para el bench; los worktrees de
  fanout viven dentro del repo y pasan), `maxBudgetUsd` (recorta el
  presupuesto pedido) y `maxDailyUsd` (coste reportado hoy por ese agente: en el
  tope deniega, por debajo recorta el presupuesto a lo que queda). Claude: `allow-all` solo en temp. OpenCode: los tres
  proyectos autorizados.
- Claude y OpenCode: 2 USD por llamada y 5 USD/día por agente, aplicados por
  `limits` (decisión del propietario, 2026-11-08). El `--daily-ceiling` del router sigue
  siendo solo consultivo.
- OpenRouter deshabilitado; clave solo en `OPENROUTER_API_KEY`.

## Limpieza

- `results/fake-*` y `results/codex-*` no son evidencia útil.
- `results/bench/` se puede vaciar; los informes están en `bench/`.
- No borrar líneas de `projects/logs/runs.jsonl` ni worktrees con cambios sin permiso.
