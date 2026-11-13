# Las superficies de VS Code: harness, host y modelo

STATUS: actual (2026-11-13)

Antes de tocar `settings.json`, `chatLanguageModels.json`, `acp/agents.json` o `ahp/`, lee esto.
La idea en una línea: **el harness decide *cómo* se trabaja; el host decide *quién puede* y deja
constancia; el modelo solo pone los tokens.**

## Qué es qué

| Término | Qué es | Ejemplo aquí |
|---|---|---|
| **Harness** | el programa con el bucle del agente: lee, decide, llama herramientas, edita | Copilot Chat, Claude Code, Codex, OpenCode |
| **Host** | el servidor que aloja sesiones de agentes y las sirve a un cliente | AgentHub (AHP), y los `agentHost` locales de VS Code |
| **Cliente** | la UI que dibuja la sesión y manda los mensajes | la ventana de Agents, el panel Chat |
| **Bridge** | traductor que convierte un harness en un **modelo** para una UI (HTTP, OpenAI-compatible): sin herramientas, sin sesiones, sin permisos | el `bridge/` retirado el 2026-11-11 |
| **Modelo** | de dónde salen los tokens y con qué contexto | DeepSeek V4.1 Flash (1M), Sonnet 5.5 |
| **Adaptador ACP** | proceso que envuelve un harness para hablar ACP (JSON-RPC por stdio) | `opencode acp`, el adaptador de Claude, `codex-acp` |

Bridge y host se confunden todo el tiempo: el bridge **es** un endpoint de modelo; el host **aloja**
agentes. Por eso el bridge no podía dar diffs ni permisos y el host sí.

## Las capas

```
 Ventana normal (chat)                      Ventana de Agents
 ─────────────────────                      ─────────────────
 Copilot Chat  (harness)                    cliente AHP
      │  Language Model API                      │  AHP (WebSocket, 8765/ahp)
      ├── Copilot (plan)                         ▼
      ├── OpenRouter        (BYOK)          AgentHub = host remoto + consent-proxy
      └── OpenCode Go       (BYOK)               │  ACP (stdio, JSON-RPC)
                                                 ├── opencode acp
                                                 ├── claude (adapter)
                                                 └── codex  (adapter)
```

- En el **chat** siempre corre el harness de Copilot. Elegir OpenRouter u OpenCode Go cambia el
  endpoint, no el agente: el bucle, las herramientas y los permisos siguen siendo de Copilot.
- En **agent-view** eliges harness. AgentHub es *una* puerta por la que entran tres agentes; no es
  un quinto harness ni tiene bucle propio: arranca el adaptador, reparte la sesión, aplica la
  puerta de consentimiento y escribe la auditoría.

## Los cuatro harnesses

| Harness | Dónde aparece | Modelos que trae | Contexto | Permisos | Auditoría del hub |
|---|---|---|---|---|---|
| **Copilot** | `This Computer` y también como tipo de sesión | plan Copilot (Fusion; Sonnet/GPT en *Upgrade*) **+ BYOK: OpenRouter** (21 modelos: los gratis y los de mejor relación calidad/precio) | el del modelo BYOK (DeepSeek 1M, salida 384K) | su propio modo (Assisted / Autopilot) | **no** |
| **Claude Code** | `AgentHub` | solo Claude (Sonnet/Opus/Haiku) | ~1M en esta config | `acceptEdits` en árboles concedidos; `plan` fuera | sí |
| **Codex** | `AgentHub` | solo GPT | 872K (828K efectivos) | `workspace-write` en su árbol; comandos preguntan; `.git` protegido (no commitea) | sí |
| **OpenCode** | `AgentHub` | los 30 de `opencode-go/*` | 1M | `build`, y **todo** comando shell pregunta | sí |

Medido el 2026-11-11/12; los números de arranque, coste y tiempo están en
[`harness.md`](harness.md) y en [`../bench/WORKFLOW.md`](../bench/WORKFLOW.md).

## Modelos ≠ harnesses

- El **único** sitio donde puedes elegir «cualquier LLM de cualquier proveedor» es el harness de
  Copilot con BYOK: **OpenRouter**, acotado a 21 modelos (los gratis con herramientas y los de mejor
  relación calidad/precio: DeepSeek V4.1 Flash y V4 Pro, GPT-6 Luna, GLM-5.3 Flash, MiMo V2.6 Flash,
  Qwen3.8 Flash, MiniMax M3.1 Flash).
- **OpenCode Go no va por BYOK**: su consola no da una clave de API para este plan (es suscripción), y
  el token OAuth que guarda OpenCode da 401 en ese endpoint. Su plan se usa donde sí funciona:
  `AgentHub → OpenCode`, con login propio y auditoría. Un grupo BYOK sin clave aparece igual en el
  selector y no responde: por eso se retiró.
- **Los modelos BYOK solo existen en el harness de Copilot.** Claude Code, Codex y OpenCode no
  aceptan una lista externa: traen los suyos. Ni Anthropic soporta Claude Code con modelos que no
  sean Claude, ni el adaptador de Codex acepta otro proveedor.
- Lo que en el chat se llama «Sonnet 5.5» o «GPT-6 Luna» son **modelos de Copilot**, no los agentes
  Claude y Codex. El agente de verdad solo está en `AgentHub`.
- Un mismo modelo rinde distinto en cada harness: en el chat lo conduce el prompt y las herramientas
  de Copilot, no el agente nativo.

## Dónde vive cada cosa

| Fichero | Qué decide |
|---|---|
| `%APPDATA%\Code\User\settings.json` | `chat.remoteAgentHosts` (AgentHub), `chat.agentHost.claudeAgent.enabled` / `.codexAgent.enabled` (hosts locales apagados), `chat.agentHost.byokModels.enabled` |
| `%APPDATA%\Code\User\chatLanguageModels.json` | los grupos BYOK: `Copilot` y `OpenRouter` (21 modelos en su `models`, que es lo que acota el selector). **La clave no va aquí**: el grupo guarda `${input:chat.lm.secret.…}` y el valor vive en el almacén de secretos del sistema. La lista curada está en `tools/vscode-models.json`; `node agent-hub/tools/vscode-models.mjs --apply` la escribe y `doctor` avisa si se separan |
| `acp/agents.json` | cada agente: comando, modelo por defecto, cadena de relevos, `permissionModes`, `attendedEnv`, `modelPolicy` |
| `consent.json` | la puerta: `enabled`, `overseerAck`, caducidad, `maxPermission`, `writeTrees` / `attendedWriteTrees`, topes |
| `ahp/` | el gateway AHP y el proxy de consentimiento (ver [`../ahp/README.md`](../ahp/README.md)) |

## Regla de uso

| Para qué | Superficie | Con qué |
|---|---|---|
| Preguntar, leer, planear, dudas | chat normal | Copilot + **OpenRouter** o **OpenCode Go** |
| Tocar un repo, ejecutar comandos | `AgentHub` | **OpenCode** en `build` (consentimiento + auditoría + `writeTrees`) |
| Razonamiento difícil | `AgentHub` | **Claude** |
| Edición mecánica masiva | `AgentHub` | **Codex** |

**La frontera:** si va a escribir en un repo, va por `AgentHub`. El chat no deja auditoría.

## Añadir un proveedor o un agente

- **Proveedor BYOK**: se añade un grupo en `chatLanguageModels.json` (`vendor`, `apiType`, `models`)
  y la clave como `${input:…}`. Un endpoint muerto se ve igual que uno vivo hasta que lo usas: el
  bridge dejó cuatro modelos apuntando a un puerto cerrado y nadie notó nada hasta mirar. Y un grupo
  sin clave aparece en el selector y falla al enviar; si el proveedor no da clave (OpenCode Go), no se
  pone: se usa por `AgentHub`, que sí tiene su login.
- **Agente**: entrada en `acp/agents.json` + grant en `consent.json` + reiniciar el gateway (que
  regenera su config desde esos dos ficheros con `ahp/gen-config.mjs`).

## Trampas ya pagadas

- **Campo desconocido en `session/configChanged`**: VS Code manda `sensitiveEditLocations` junto al
  modo y el gateway rechazaba *toda* la actualización, así que la sesión se quedaba en `plan` y el
  agente no podía editar. Parcheado en `ahp/gateway-patch.mjs`: se descarta la clave desconocida y se
  aplica el resto.
- **Primer arranque tras cambiar de proveedor**: puede fallar (`ACP provider OpenCode failed`, sin
  línea en `runs.jsonl`) y el borrador se queda sin modelos ni modos; cambiar de tipo y volver crea
  una sesión nueva. Causa sin confirmar.
- **Un agente, dos puertas**: si el harness local y el de `AgentHub` están los dos activos, el mismo
  agente sale dos veces y solo una vía pasa por consentimiento. Se apagó el nativo de Claude y el de
  Codex ya estaba apagado.
- **`cwd` vacío**: una sesión sin carpeta pasaba como abierta; ahora cuenta como restringida.
- **Un grupo BYOK borrado sigue vivo en el selector** hasta que se reinicia VS Code entero: el host de
  agentes cachea la lista y llega a anunciar un proveedor que ya no existe (`Wired N BYOK model(s) across 2
  provider(s)`). Si quitas un grupo, recarga todas las ventanas antes de creerte el selector. Y como los
  ids de un proveedor se retiran sin avisar, la lista vive en `tools/vscode-models.json` y `doctor` la
  contrasta (con `--online`, además, contra el catálogo del proveedor).

## Lo que no está verificado

- El contexto efectivo de Fusion y si el harness de Copilot recorta el contexto del modelo BYOK.
- La latencia comparable por modelo en tu máquina: es lo que mide `bench/run.mjs --agent … --model …`.
