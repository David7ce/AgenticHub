# Qué interfaz de chat usar (decisión 2026-11-11, revisada 2026-11-15)

STATUS: decidido. Dos interfaces; la ventana de Agents de VS Code se retiró el 2026-11-15.

## Decisión

Centralizar **el gobierno y la orquestación** (el hub: consentimiento, auditoría, topes,
enrutado), no meter todos los modelos en una sola interfaz. Quedan **dos interfaces**, cada
una por lo que la otra no puede dar:

| | Interfaz | Para qué | Por qué es la única que lo da |
|---|---|---|---|
| **A** | **OpenCode** (terminal y escritorio) | El sitio de trabajo diario: se habla con el modelo y él llama a Claude y a Codex con las herramientas MCP del hub (`ask_agent`, `fanout`, `route`) | Es el único con los modelos del plan plano `opencode-go` (DeepSeek V4.1, GPT-6 Luna de 1,05M, MiMo, MiniMax), y desde ahí se llega a todo lo demás |
| **B** | **Claude Code** (CLI o extensión) | Trabajo difícil, revisión, orquestar | Es el único sitio donde Claude va con tu suscripción y con su arnés completo (skills, hooks, plugins, subagentes). Tiene las mismas herramientas del hub |

Claude Code, Codex, OpenCode y Hermes siguen siendo **motores** alcanzables por el hub; Codex y
Hermes no necesitan una interfaz propia que mantener.

**Cómo se usa: hablando, no lanzando comandos.** En OpenCode se le pide al modelo en lenguaje
natural («empecemos con el roadmap; consulta a Claude y a Codex»). Las instrucciones del servidor
MCP del hub le dicen qué herramienta usar en cada caso; nadie tiene que escribir un comando. La
terminal (`hub status`, `hub live`, `hub doctor`) es solo para mirar.

## Retirado el 2026-11-15: la ventana de Agents de VS Code sobre AHP

Pasó su prueba (6/6 el 2026-11-11) y funcionaba, pero era el camino más largo y más frágil del
repositorio: VS Code → WebSocket → un gateway de terceros en versión preliminar y con parches
propios → un proxy → el agente, y el único proceso en segundo plano. El dueño trabaja en OpenCode,
que llega a los mismos agentes por tuberías locales y sin nada que mantener vivo. `ahp/`, los
lanzadores del gateway y `tools/ui-automation/` salieron del árbol; siguen en el historial de git
(último commit que los tiene: `04d3bf6`). Detalle en [`decisions.md`](decisions.md).

## Lo medido (2026-11-11)

| Dato | Valor |
|---|---|
| Ventana de contexto | Claude 1M, OpenCode 1M, GPT-6 Luna 1,05M, Codex 828K efectivos (techo propio de 872K); medido por el propio agente (`usage_update`) |
| Arranque por turno | Claude 13,7K-45K tokens según lo que cargue; OpenCode 13-16K; Codex 18-20K |
| Coste de un turno trivial de Claude | 0,01-0,17 USD, casi todo por el arranque |

## Reglas de uso

1. **Empieza en A.** Si la tarea es mecánica, cabe en un árbol y tiene tests, la hace el modelo
   barato. Si falla dos veces o pide juicio, que escale a Claude o a Codex (`ask_agent`, o `route`
   para que elija el hub).
2. **Usa B** para diseño, revisión, trabajo que toca varios repos, y siempre que quieras el arnés
   de Claude. Desde B se delega lo barato con `ask_agent` en un worktree, en segundo plano si
   pasa de unos minutos.
3. **Un escritor por árbol.** El hub ya lo impone; no abras A y B escribiendo en el mismo árbol.
4. **Nada de claves por la puerta de atrás.** No se enruta Claude Code por una pasarela con
   credencial: dejaría de usar la suscripción y se facturaría por token.

## Acceso y ejecución: lo medido (2026-11-11)

Los agentes corren con **tus derechos de Windows, sin contenedor**: el acceso ya es total. Lo que es
fino es la *ejecución controlada*:

| Agente | Cómo actúa hoy | Control que hay |
|---|---|---|
| Claude Code (nativo) | Modo por defecto: **pregunta** antes de editar y de ejecutar | 3 reglas deny globales (Raindrop) y 7 de proyecto (`.env`) |
| Claude por el adaptador ACP (hub) | Arranca en modo `auto`, más abierto que el nativo | `writeTrees` |
| Codex | `approval_policy = "never"` (tu decisión del 2026-11-09) y sandbox de Windows `unelevated` | `writeTrees` y topes del hub; **sin** regla `.env` |
| OpenCode | Modo `build`: edita y ejecuta sin preguntar | Reglas `.env` globales y `writeTrees` del hub |
| Hub (ejecuciones desatendidas) | `writeTrees`, presupuesto, tiempo, auditoría, worktrees | La puerta de `consent.json` |

Red: salida permitida por política aceptada (`tools/egress-posture.mjs`: sin avisos).

**Distinción que manda:** en ejecución *desatendida* (el hub) no se puede preguntar a nadie, así que el
control es el confinamiento (árbol, worktree, presupuesto, auditoría); en ejecución *atendida*
(OpenCode, Claude Code) sí se puede preguntar por lo arriesgado. Cambiar `approval_policy` de Codex o
añadir reglas `ask` globales a OpenCode haría que las ejecuciones del hub se queden esperando una
respuesta: por eso la política atendida va en la configuración de cada interfaz, no en la global de
los agentes.

## Riesgos y revisión

- `writeTrees` es una regla que el hub aplica por protocolo; el sistema operativo no la impone. Un
  agente con permiso de escritura corre con tus derechos.
- Si Anthropic cambiara el soporte de modelos no Claude en Claude Code, se reevalúa la regla 4.
- Revisión de esta decisión: febrero de 2027.
