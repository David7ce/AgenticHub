# Pila de agentes — decisión y comparativa (2026-11-09)

STATUS: active

Qué superficie usar para cada tipo de trabajo, tras montar agentes nativos en
Windows y OpenRig en WSL2. No sustituye a
[`comparativa-agenthub-omniroute-ax.md`](comparativa-agenthub-omniroute-ax.md):
aquella decide entre gobierno local, gateway de modelos y runtime de clúster;
esta decide entre **agente suelto**, **AgentHub** y **OpenRig**, y con qué
modelo.

## Decisión en una línea

| Trabajo | Superficie | Por qué |
|---|---|---|
| Repo que depende de un toolchain Windows-only (venv, SDK nativo) | **Agente suelto en Windows** (OpenCode o Codex) | El toolchain y los tests solo existen en Windows; `/mnt/d` es lento desde Linux |
| Delegar o auditar desde una sesión de Windows | **AgentHub** (`ask_agent`, `fanout`, MCP) | Procesos Windows nativos, consentimiento y auditoría JSONL |
| Equipo con roles, cola y revisión cruzada en un repo Linux | **OpenRig en WSL2** | Seats con identidad, cola persistente, `rig send`/`capture` |
| Repo Windows que aun así quieras en equipo | Copia/clon en `~/` **solo si** deja de depender del toolchain Windows | Sigue siendo un segundo mundo |

**OpenRig no soporta Windows nativo.** Su paquete npm se instala en Windows
(no declara `os`), pero `rig setup` y los seats necesitan `tmux`, que no existe
en Windows. Por eso vive en WSL2.

## Evidencia verificada (2026-11-09)

| Comprobación | Resultado |
|---|---|
| `opencode --version` (Windows, nativo) | `2.2.6` |
| `opencode auth list` (Windows) | integración `OpenCode Console` con cuenta `Default` |
| `opencode models` (Windows) | 32 modelos `opencode-go/*`, incluido `deepseek-v4.1-flash` |
| Llamada real al MCP `agent-hub` en Windows | `status` y `agents` correctos |
| `opencode mcp list` (Windows) | `agent-hub` y `playwright` conectados |
| Codex Windows | sesión de ChatGPT activa |
| Codex Linux (WSL) | `auth.json` copiado de Windows; mismo login |
| OpenRig (WSL2) | `0.7.10`, daemon y kernel `ready` |
| Equipo `starter` Codex-only en un repo de prueba | builder + reviewer, revisión `PASS` |

## Modelos × superficie

| Modelo | Agente suelto | AgentHub | OpenRig |
|---|---|---|---|
| **DeepSeek v4.1 Flash** (`opencode-go`) | Diario, barato, rápido | Worker por defecto | Solo como terminal node, sin identidad de seat |
| **Codex Terra** | Coding duro | Escalado por ACP | Seat nativo |
| **Codex Sol** | Terminal y código complejo | Con `model` explícito | Seat nativo (usado por el kernel y el `starter`) |
| **Codex Luna** | Volumen | Lote | Seat nativo |
| **Claude (Opus/Sonnet)** | Contexto largo, revisión | Escalado con `consent.json` y límites | Seat nativo |
| **`opencode/*-free`** | Pruebas sin coste | Fallback | No soportado como runtime |

## Enfoques

| | Agente suelto | AgentHub | OpenRig |
|---|---|---|---|
| Quién coordina | Tú | Tú (o un MCP) | El operador |
| Agentes se hablan entre sí | No | No: hub-and-spoke | Sí: cola, mensajes, seats |
| Paralelismo | Manual | `fanout` | Equipos con roles |
| Aislamiento | El del harness | Locks por árbol | tmux + workspace por rig |
| Permisos | Los del harness | `consent.json` + límites | `floor`/políticas por seat |
| Auditoría | No | `logs/runs.jsonl` | Cola, transcripts y pruebas en `missions/` |
| Windows nativo | Sí | Sí | No (WSL2) |
| Coste de adopción | Ninguno | Ya instalado | WSL2, configs y segundo login |
| Ideal para | Edición diaria | Delegar y auditar | Equipos en repos Linux |

## Qué aporta cada uno

- **Agente suelto**: velocidad y control, cero capas. Lo correcto para trabajo
  de edición normal y para repos con toolchain de plataforma.
- **AgentHub**: delegas a otro agente desde dentro de tu sesión, con
  consentimiento y auditoría. No tiene buzón persistente ni agentes con
  dirección propia.
- **OpenRig**: equipo real con roles, cola que sobrevive, tareas con ownership
  y revisión cruzada. Cuesta un segundo mundo Linux y no sirve para proyectos
  que dependen de un toolchain que solo existe en Windows.

## Cómo lanzar

**OpenCode en Windows** (modelo por defecto `opencode-go/deepseek-v4.1-flash`,
con `agent-hub` y `playwright`):

```powershell
cd <repo>
opencode
```

**Codex en Windows**:

```powershell
cd <repo>
codex
```

**Delegar al hub desde OpenCode**: pedir `ask_agent` con `codex` o `claude`.
Desde Codex el MCP `agent-hub` ya está en la config global.

**OpenRig (WSL2)**, cuando el repo sea Linux:

```bash
wsl.exe -d Ubuntu -- env -u TMUX /usr/bin/tmux attach -t operator-agent@kernel
```

## Workflow recomendado

1. Abrir **OpenCode Windows** en el repo y hacer el cambio con DeepSeek.
2. Si el cambio es delicado, **Codex Sol** en otra terminal, sin escribir a la
   vez sobre el mismo árbol.
3. Revisión con otro agente en modo lectura (el subagente `reviewer`).
4. Tests siempre con el toolchain de la plataforma del repo. Nunca desde WSL
   si el repo depende de un venv o SDK de Windows.
5. Commits pequeños; no mezclar documentación de continuidad de otra sesión.

## Límites conocidos

- El kernel y el operador de OpenRig funcionan en WSL2 pero están fuera de sus
  tests automatizados.
- `~/.gitconfig` de WSL puede traer `core.autocrlf=true`; para repos Linux
  conviene `input`.
- El inventario de `repos/` y sus páginas se generan por máquina y no se
  versionan.
