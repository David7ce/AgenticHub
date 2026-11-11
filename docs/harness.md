# Qué interfaz de chat usar (decisión 2026-11-11)

STATUS: decidido para dos opciones; una tercera queda a prueba con criterio de paso.

## Decisión

Centralizar **el gobierno y la orquestación** (el hub: consentimiento, auditoría, topes,
enrutado), no meter todos los modelos en una sola interfaz. Quedan **dos interfaces top**, cada
una por lo que la otra no puede dar:

| | Interfaz | Para qué | Por qué es la única que lo da |
|---|---|---|---|
| **A** | **Claude Code** (extensión de VS Code; CLI en terminal) | Trabajo difícil, revisión, orquestar. Llama a los demás con las herramientas MCP del hub (`ask_agent`, `fanout`, `route`) | Es el único sitio donde Claude va con tu suscripción y con su arnés completo (skills, hooks, plugins, subagentes). Anthropic no da soporte a usar Claude Code con modelos que no sean Claude, así que los demás son *herramientas* de Claude Code, no su modelo |
| **B** | **OpenCode** (terminal y escritorio) | Trabajo diario barato y mecánico, con los tests como juez; los modelos del plan plano `opencode-go` | Es el único con DeepSeek V4.1, GPT-6 Luna (1,05M), MiMo y MiniMax en tu plan, y también llama al hub para escalar a Claude/Codex |

Claude Code, Codex, OpenCode y Hermes siguen siendo **motores** alcanzables por el hub; Codex y
Hermes no necesitan una interfaz propia que mantener.

**A prueba, con criterio de paso: la ventana de Agents de VS Code sobre AHP** (host
`ahp-acp-gateway` detrás del proxy de consentimiento, ver `ahp/README.md`). Si pasa, sustituye a
B *dentro del IDE* (una sola ventana para los cuatro agentes, con herramientas, diffs y sesiones
persistentes); si no, se queda en dos y no se invierte más.

## Lo medido (2026-11-11) frente a lo que falta

| Dato | Valor | Estado |
|---|---|---|
| Ventana de contexto | Claude 1M, OpenCode 1M, GPT-6 Luna 1,05M, Codex 828K efectivos (techo propio de 872K) | medido por el propio agente (`usage_update`) |
| Arranque por turno | Claude 13,7K por el bridge (modo ligero) / **45K por AHP** (carga ajustes, plugins y MCP); OpenCode 13-16K; Codex 18-20K | medido |
| Coste de un turno trivial de Claude | 0,01-0,06 USD (bridge) / 0,17 USD (AHP, por el arranque) | medido |
| Permisos por AHP | AHP no añade puerta: los tres agentes escribieron sin preguntar en su modo por defecto. El proxy aplica `writeTrees` (modo restringido fuera de ellos) | medido y corregido |
| Claude por la ventana de Agents de VS Code (harness nativo) | Necesita Copilot con Claude o una API key; con solo suscripción no hay modelos | verificado en la documentación y en tu pantalla |
| Cómo se ve una sesión AHP dentro de VS Code | — | **sin verificar** |
| Que el esfuerzo y los modelos salgan en los selectores nativos de la ventana de Agents | — | **sin verificar** |

## Reglas de uso

1. **Empieza en B** si la tarea es mecánica, cabe en un árbol y tiene tests. Si falla dos veces
   o pide juicio, escala a A (o `route`).
2. **Usa A** para diseño, revisión, trabajo que toca varios repos, y siempre que quieras el arnés
   de Claude. Desde A, delega lo barato a B con `ask_agent` en un worktree, en segundo plano si
   pasa de unos minutos.
3. **Un escritor por árbol.** El hub ya lo impone; no abras A y B escribiendo en el mismo árbol.
4. **Nada de claves por la puerta de atrás.** No se enruta Claude Code por un gateway con
   credencial: dejaría de usar la suscripción y se facturaría por token.

## Prueba de la ventana de Agents (criterio de paso)

Hecha por quien tiene VS Code delante, con el host AgentHub y la carpeta de un proyecto que esté
en `writeTrees` del agente:

1. Salen los agentes concedidos y el selector de modelo del agente.
2. Un turno de texto responde y deja su línea en `logs/runs.jsonl` (`transport: "ahp"`).
3. Una edición dentro de `writeTrees` se aplica y se ve el diff.
4. La misma petición en una carpeta fuera de `writeTrees` **no** escribe (modo restringido).
5. El selector de esfuerzo (o la opción de modo) aparece y cambia el comportamiento.
6. Cerrar la sesión no deja procesos del agente vivos.

Pasa con 6/6, o con 5/6 si el que falla es cosmético. Si pasa: se retira `bridge/` y se registra
el arranque del gateway como parte de la tarea del lanzador (ya lo hace `run-bridge.ps1`). Si no:
se mantiene el bridge como único chat de texto en VS Code y se vuelve a mirar cuando salga una
versión nueva del gateway.

## Qué se deja de mantener

- **Copilot Chat como interfaz de trabajo**: no aporta modelos con tu plan; el Custom Endpoint solo
  sirve como chat de texto, y esa vía es el bridge.
- **El harness de Codex en VS Code** (desactivado): se llega a Codex por el hub o por AHP.
- **Hermes como interfaz**: se llega por el hub o AHP, con su permiso desactivado y fuera de árboles
  con credenciales (su retención puede entrenar).

## Acceso y ejecución: lo medido (2026-11-11)

Los agentes corren con **tus derechos de Windows, sin contenedor**: el acceso ya es total. Lo que es
fino es la *ejecución controlada*:

| Agente | Cómo actúa hoy | Control que hay |
|---|---|---|
| Claude Code (nativo) | Modo por defecto: **pregunta** antes de editar y de ejecutar | 3 reglas deny globales (Raindrop) y 7 de proyecto (`.env`) |
| Claude por el adaptador ACP (hub, bridge) | Arranca en modo `auto`, más abierto que el nativo | `writeTrees` |
| Claude por AHP | `acceptEdits` en las carpetas concedidas (edita libre, pregunta comandos); `plan` fuera | `attendedWriteTrees` + clamp |
| Codex | `approval_policy = "never"` (tu decisión del 2026-11-09) y sandbox de Windows `unelevated` | `writeTrees` y topes del hub; sandbox `workspace-write` por AHP (fuera de la carpeta bloquea y pide permiso); **sin** regla `.env` |
| OpenCode | Modo `build`: edita y ejecuta sin preguntar | Reglas `.env` globales y `writeTrees` del hub; **por AHP** pregunta antes de cada comando (`attendedEnv`) |
| Hub (ejecuciones desatendidas) | `writeTrees`, presupuesto, tiempo, auditoría, worktrees | La puerta de `consent.json` |

Red: salida permitida por política aceptada; los agentes ACP del hub no están cubiertos por el sandbox
de terminal de VS Code (`tools/egress-posture.mjs`: sin avisos).

**Distinción que manda:** en ejecución *desatendida* (el hub) no se puede preguntar a nadie, así que el
control es el confinamiento (árbol, worktree, presupuesto, auditoría); en ejecución *atendida* (VS Code,
Claude Code) sí se puede preguntar por lo arriesgado. Cambiar `approval_policy` de Codex o añadir reglas
`ask` globales a OpenCode haría que las ejecuciones del hub se queden esperando una respuesta: por eso
la política atendida se aplica donde hay una persona (el proxy de AHP y la configuración del propio
Claude Code), no en la configuración global de los agentes.

## Riesgos y revisión

- El gateway de AHP es de terceros y va por la 0.2.x; está fijado a `0.2.2`. Revisar al subir de
  versión (los nombres de modos de los agentes también cambian: ver `ahp/README.md`).
- El harness Local de VS Code se elimina en febrero de 2027; nada de lo decidido aquí depende de él.
- Si Anthropic cambiara el soporte de modelos no Claude en Claude Code, se reevalúa la regla 4.
- Revisión de esta decisión: tras la prueba de la ventana de Agents, y en cualquier caso en febrero
  de 2027.
