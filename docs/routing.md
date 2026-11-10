# Routing — qué agente, qué modelo, qué topología

STATUS: actual (2026-11-08)

Principio: **menos es más**. El hub no reparte trabajo entre todos los agentes
disponibles; elige el conjunto mínimo que resuelve la tarea. Por defecto, uno.

## Workers

| Worker                | Estado                                      | Rol                                           | Evidencia                                                                                                |
|-----------------------|---------------------------------------------|-----------------------------------------------|----------------------------------------------------------------------------------------------------------|
| **OpenCode**          | activo, consentido                          | defecto: código, tools, revisión barata       | 2/2 fixes, 1/1 construct, revisión 8 s, $0                                                               |
| **Claude** (`sonnet`) | activo, consentido                          | escalado: multi-módulo, alto riesgo, revisión | 2/2 fixes, 1/1 construct en 68 s, $0,25                                                                  |
| **Codex**             | registrado, consentido; probado 2026-11-09  | Terra defecto, Sol escalado, Luna lote        | `@agentclientprotocol/codex-acp@2.6.0`; el viejo `@zed-industries/codex-acp@0.16.0` fallaba con `-32603` |

Detalle medido en [`../bench/WORKFLOW.md`](../bench/WORKFLOW.md).

## Catálogo

[`../models.json`](../models.json) es la fuente de verdad de proveedores y
modelos. Campos que importan al router:

- `tier`: `default`, `strong`, `review`, `light`, `fallback`, `capacity`,
  `free-text` y `frontier`. **`frontier` nunca se elige automáticamente**
  (el router lo filtra aunque esté `enabled`); solo con `--model` explícito.
- `capabilities`: `code`, `review`, `text`, `tools` (1–5).
- `context` y `costPerMillion`.
- `retention`: `zero`, `unknown` o `may-train`.
- `enabled`: un modelo documentado pero no usable no se enruta.

No se importan rankings de benchmarks online: cambian, no miden herramientas y
no conocen este hub. Los tiers son una decisión local; la latencia, los fallos
y el coste salen de `hubctl report`.

## Codex: modelos y adaptador

Capacidad: **Astra > Sol > Terra > Luna**. Política (2026-11-08):

| Modelo                    | Versión | Uso                                                  | Automático                      |
|---------------------------|---------|------------------------------------------------------|---------------------------------|
| **Terra** `gpt-6.1-terra` | 6.1     | defecto de Codex: día a día, revisión, texto, visión | sí                              |
| **Sol** `gpt-6.1-sol`     | 6.1     | coding duro, terminal, tareas largas                 | sí, como escalado               |
| **Luna** `gpt-6-luna`     | 6.0     | volumen, extracción, resúmenes                       | sí, como último recurso         |
| **Astra** `gpt-6-astra`   | 6.0     | trabajos excepcionales                               | **solo explícito** (`frontier`) |
| **Opus 5.5** (Claude)     | —       | trabajos excepcionales                               | **solo explícito** (`frontier`) |

"Última versión" sale de `~/.codex/models_cache.json`: la más alta de cada
familia. `hubctl models --codex` la muestra y `doctor` avisa si `models.json` se
queda atrás; ninguno reescribe el fichero.

Adaptador: `@agentclientprotocol/codex-acp@2.6.0`, con la versión fijada. Está
mantenido, habla ACP v1 y v2 y arranca Codex App Server con `@openai/codex ^0.166.0`.
El anterior, `@zed-industries/codex-acp@0.16.0`, está congelado, embebe Codex 0.137
y falla con `-32603` en modelos 6.x. `doctor` falla si vuelve a aparecer.
**No hay shim propio**: un puente casero sería otro adaptador que mantener y
auditar, justo lo que el paquete mantenido ya hace. Si 2.6.0 no negocia ACP v1,
se para y se reporta.

Consentimiento: `allow-all` solo bajo `D:/Workspaces/AgentHub` o el temp del
bench, con 0,50 USD por llamada. Retención: `unknown`.

## Entrada y salida del router

```
route({ tarea, riesgo, presupuesto, sensibilidad })
  -> { agente, modelo, topología, motivo, fallbacks }
```

Reglas, en orden:

1. **Filtrar** por capacidad, contexto, retención y `enabled`.
2. **Riesgo**: alcance o consecuencia → `strong`.
3. **Coste**: si el modelo fuerte supera el límite diario, no escalar.
4. **Salud**: un agente con fallos/timeouts recientes pierde prioridad.
5. **Empate**: gana el más barato y rápido.
6. **Fallbacks**: cadena de modelos del agente, luego el otro agente si hay
   cuota agotada.

La primera versión es **advisory**: `route --explain` explica la elección; no
lanza fan-out ni gasta. El `run` sigue siendo explícito.

## Topologías

| Nivel  | Topología                                    | Cuándo                                           |
|--------|----------------------------------------------|--------------------------------------------------|
| **L0** | OpenCode solo                                | defecto; la mayoría del trabajo                  |
| **L1** | Claude `sonnet` solo                         | multi-módulo, alto riesgo, o L0 falló            |
| **L2** | OpenCode implementa + Claude revisa          | el fallo es caro; revisión read-only             |
| **L3** | OpenCode + Hermes (texto) + Claude sintetiza | ideas/resúmenes ambiguos; nunca código en Hermes |

La revisión L2 no se usa por defecto: en la prueba sembrada OpenCode ya encontró
el bug en 8 s. Se paga cuando el cambio toca permisos, dinero, secretos o varios
módulos.

## Esfuerzo de razonamiento (`effort`)

`hub-acp --effort`, y el parámetro `effort` de `ask_agent`/`fanout` en MCP, se
traducen a la opción propia de cada agente: `effort` en OpenCode y
`reasoning_effort` en Codex (ver `"effort"` en `acp/agents.json`). Claude no
declara ninguna opción y el hub avisa e ignora el parámetro.

| Tarea | `effort` |
|---|---|
| Texto, documentación, resúmenes, revisión de un diff pequeño, ediciones mecánicas | `low` |
| Código normal | sin indicar (el defecto del agente) |
| Depurar algo difícil o un cambio entre varios módulos | `high` |

Medido el 2026-11-08 en OpenCode (DeepSeek V4.1 Flash): reescribir el ROADMAP con
el esfuerzo por defecto tardó 314 s, de los que 296 s fueron de razonamiento
(21 000 tokens de razonamiento para 4 300 de texto). Con la misma tarea corta, `low`
bajó el razonamiento de 319 a 16 tokens. Para lo que es solo texto, `low` es el
defecto razonable.

## Límites

- Aplicados por `consent.json` `limits`: Claude y OpenCode a 2 USD por llamada
  y 5 USD/día por agente; Codex a 0,50 USD por llamada y 5 USD/día. Recortan el presupuesto
  que pida el caller, incluido el defecto de 3 USD del MCP.
- El `--daily-ceiling` del router (3 USD) es solo consultivo: deja de escalar,
  pero no bloquea nada.
- OpenRouter: proveedor y modelo `openrouter/auto` documentados, `enabled:false`.
  La clave va en `OPENROUTER_API_KEY`; no se hacen llamadas sin saldo.
- Los modelos `:free` no reciben secretos ni `.env`.

## Ejemplos de decisión

| Pregunta                                      | Decisión                            |
|-----------------------------------------------|-------------------------------------|
| “Arregla este test que falla en un módulo”    | L0 OpenCode                         |
| “Renombra esta API en 6 paquetes”             | L1 Claude                           |
| “Revisa este diff antes de publicar”          | L2 OpenCode + Claude                |
| “Resume estas notas y propone nombres”        | L0 OpenCode o Hermes manual (texto) |
| “Necesito otro proveedor porque no hay cuota” | OpenRouter, solo con saldo          |

## Lo que no hace

- No elige cuatro agentes porque existan.
- No manda fan-out automático.
- No sustituye un `--model` explícito.
- No usa un modelo `enabled:false`.
