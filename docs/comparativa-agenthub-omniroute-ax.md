# AgentHub frente a OmniRoute y AX — comparativa honesta

Fecha: 2026-11-08
Estado: documento de decisión; AgentHub queda **apartado**, no retirado.

Este documento existe para evitar dos errores:

1. convertir AgentHub en un gateway de modelos peor que OmniRoute;
2. convertirlo en un runtime de agentes peor que AX.

No vende ninguna de las tres herramientas. Dice qué hace cada una, qué no hace,
y qué conviene usar para cada problema.

## Resumen en una frase

- **AgentHub** es un plano de control **local** de agentes: consentimiento,
  auditoría, locks y handoff entre harnesses.
- **OmniRoute** es un gateway **local** de modelos: proveedores, cuotas,
  fallback, compresión y coste.
- **AX (Agent Executor)** es un runtime **de clúster** para ejecutar agentes
  aislados, durables y a escala.

No compiten en la misma capa. Se solapan lo justo para confundirse.

## Qué es cada uno

### AgentHub

Infraestructura local en `D:\Workspaces\AgentHub`:

- `consent.json` con `enabled`, `overseerAck`, expiración y `limits`
  (`maxPermission`, `writeTrees`, `maxBudgetUsd`, `maxDailyUsd`).
- `logs/runs.jsonl`: una línea por intento, con agente, modelo, estado, coste y
  `cwd` desde 2026-11-08.
- `tree-lock`: un escritor por árbol.
- Worktrees por agente (`--worktree`).
- `ask_agent`, `fanout`, `route`, `resume`, `attach`.
- `hubctl live`, `report`, `spend`, `doctor`.
- Adaptadores ACP para OpenCode, Claude Code y Codex.

Lo que **no** tiene: sandbox de sistema, aislamiento de red, ejecución durable,
suspend/resume, escala multi-nodo, catálogo de cientos de modelos.

### OmniRoute

Gateway MIT autoalojado:

- ~381 proveedores, ~1.500 modelos, 150+ free (según su README).
- Endpoint OpenAI-compatible (`/v1`) y Anthropic (raíz) para Claude Code.
- Combos y `auto/*`: `auto`, `auto/coding`, `auto/cheap`, `auto/fast`,
  `auto/subscription`, `auto/thrifty`, `auto/offline`, `auto/smart`, `auto/lkgp`,
  `auto/chaos`.
- Fallback por cuota, coste, latencia, salud, reset de ventana, contexto y cache.
- Compresión RTK/Caveman (15–95% de tokens, según el proyecto).
- Dashboard, telemetría de coste/tokens, MCP con 87 herramientas, A2A, ACP,
  MITM opcional.
- Comandos `setup-claude`, `setup-codex`, `setup-opencode`, `launch`,
  `launch-codex`, `run`.

Lo que **no** tiene: consentimiento por agente, locks de árbol, worktrees de
agente, auditoría de “quién editó este repo” con la semántica de AgentHub.

### AX / AgentExecutor

Runtime de Google para Kubernetes:

- **Task**: sandbox aislado con CPU/memoria, suspend/resume.
- **Workspace**: repos Git, MCP servers y skills preparados antes de arrancar.
- **Gateway**: políticas de red y allowlist de hosts.
- **Model**: configuración de modelos y credenciales.
- Ejecución durable, checkpoints, branching de trayectoria, recuperación de
  conexión.
- Escala a muchos tasks; corre sobre **Agent Substrate** y Kubernetes.
- Apache 2.0, pero **alpha** y con breaking changes anunciados.

Lo que **no** tiene: un gateway de 381 proveedores, un dashboard de coste por
request como OmniRoute, ni el modelo de consentimiento por agente de AgentHub.

## Comparativa por dimensión

| Dimensión | AgentHub | OmniRoute | AX |
|---|---|---|---|
| Alcance | Una máquina | Una máquina/servidor | Clúster |
| Enrutar modelos | Básico | **Excelente** | Configuración, no gateway |
| Proveedores | 2–3 agentes | **381** | Bring your own |
| Cuotas/fallback | Básico | **Excelente** | No es su trabajo |
| Compresión | No | **Sí** | No |
| Coste/tokens | Parcial | **Completo** | Métricas de infraestructura |
| Sandbox | No | No | **Fuerte** |
| Workspaces declarativos | Worktrees locales | No | **Sí** |
| Consentimiento por agente | **Sí** | No | Políticas, no grants |
| Auditoría de runs | **Sí** | Logs/cost de requests | Eventos de infraestructura |
| Un escritor por árbol | **Sí** | No | Aislamiento por sandbox |
| Handoff/fan-out | **Sí** | A2A/MCP, sin locks | Tasks/workspaces |
| Suspend/resume durable | No | No | **Sí** |
| Escala | 1 máquina | 1 servidor | **Clúster** |
| UI | CLI | **Dashboard** | `kubectl`-like |
| Madurez | Casero, pequeño | Enorme y activo | Google, alpha |
| Complejidad | Baja/media | Alta | Muy alta |
| Mejor para | Gobierno local | Cuota/proveedores | Producción a escala |

## Qué estamos construyendo de verdad

AgentHub empezó como orquestador local y derivó en dos productos:

1. **Un gateway de modelos casero**: `models.json`, router de modelos,
   fallbacks, spend. Eso es OmniRoute, pero peor.
2. **Un plano de control de agentes**: consentimiento, auditoría, locks,
   handoff. Eso sí es único.

La conclusión honesta: **dejar de construir (1) y conservar (2).**

## Qué no hacer

- No reconstruir 381 proveedores, combos, compresión o telemetría de coste.
- No construir un scheduler de sandboxes, suspend/resume o ejecución durable.
- No forzar Claude Code con modelos no Anthropic y llamarlo “optimizado”;
  OmniRoute lo permite, pero Claude Code está afinado para Anthropic.
- No retirar AgentHub: su valor es el gobierno local.
- No mezclar OmniRoute y AgentHub en el mismo camino de decisión sin decir
  quién manda en cada capa.

## Arquitectura recomendada

```
Claude Code / OpenCode / Codex     ← harness/UI
              │
          OmniRoute                ← modelos, cuotas, proveedores
              │
          AgentHub                 ← consentimiento, auditoría, locks, handoff
```

- **OmniRoute** decide modelo/proveedor y evita quedarse sin cuota.
- **AgentHub** decide qué agente trabaja, dónde y con qué permiso.
- `models.json` de AgentHub se reduce a capacidades/tiers de agentes.
- `spend` puede leer el informe de coste de OmniRoute en vez de parsear cuatro
  fuentes.
- `router.mjs` solo elige agente y topología; el modelo lo elige OmniRoute.

## Claude Code con modelos no Anthropic

Funciona cambiando `ANTHROPIC_BASE_URL` y `ANTHROPIC_AUTH_TOKEN`, y OmniRoute
lo automatiza (`omniroute launch`, `setup-claude`). Pero Claude Code está
optimizado para modelos Anthropic: system prompt, tool calling, caching y
compaction están afinados para Claude.

Conclusión: OmniRoute sirve para **disponibilidad/fallback** de Claude Code; no
convierte GPT/DeepSeek en modelos óptimos para Claude Code. Para modelos no
Anthropic, OpenCode o Codex nativos siguen siendo mejores.

## Riesgos de OmniRoute

- **“Free” no es gratis en términos**: agrega free tiers de terceros; cada
  proveedor impone límites y condiciones. Los ~1.62B tokens/mes son una
  estimación agregada, no una garantía.
- **Superficie enorme**: 381 proveedores, dashboard, MITM, MCP, A2A,
  compresión. Más piezas y más riesgo.
- **Retención de datos**: los free tiers pueden entrenar o retener. No enviar
  secretos.
- **Compresión**: el ahorro puede degradar calidad; medir.
- **Dashboard**: cambiar la contraseña por defecto (`CHANGEME`) y no exponerlo
  a Internet.
- **No es un plano de agentes**: no sustituye consentimiento ni locks.

## Riesgos de AX

- **Alpha**: cambios incompatibles anunciados.
- **Kubernetes + Agent Substrate**: infraestructura pesada para un portátil.
- **No es local-first**: no sustituye `hubctl live` ni el trabajo diario en
  Windows/WSL.
- **Modelo de permisos distinto**: no tiene grants por agente como AgentHub.

## Veredicto

- **¿AX es lo que estamos construyendo?** No. AgentHub no es un runtime de
  clúster.
- **¿OmniRoute es lo que estamos construyendo?** En la parte de modelos, sí; por
  eso deberíamos dejar de duplicarlo.
- **¿Qué es AgentHub?** Un plano de control local de agentes. Útil, pequeño y
  prescindible si no se usan varios harnesses.
- **¿Qué hacer?** Dejar AgentHub apartado como capa de gobierno; adoptar
  OmniRoute si la cuota es el dolor; evaluar AX solo si se necesita sandbox y
  escala.

## Decisión

AgentHub **no se retira**. Queda en pausa como capa de gobierno local. No se
invierte más en catálogo/router de modelos ni en parsers de spend. Si se
necesita cuota, se prueba OmniRoute; si se necesita ejecución aislada a escala,
se evalúa AX.
