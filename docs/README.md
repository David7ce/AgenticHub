# Documentación del hub — qué leer

Este índice separa lo que describe el hub **hoy** de lo que solo conserva el
razonamiento que llevó hasta aquí. Si algo contradice el código, manda el
código; si contradice `AGENTS.md`, manda `AGENTS.md`.

## Actual

| Documento                                                | Cuándo leerlo                                                                         |
|----------------------------------------------------------|---------------------------------------------------------------------------------------|
| [`architecture.md`](architecture.md)                     | Entender el hub: hosts, MCP, ACP, consentimiento, auditoría, locks y estado en vuelo. |
| [`routing.md`](routing.md)                               | Elegir agente/modelo/topología y conocer el catálogo y sus límites.                   |
| [`operations.md`](operations.md)                         | Arrancar, lanzar, hablar, observar, depurar y limpiar.                                |
| [`decisions.md`](decisions.md)                           | Qué se decidió y qué se descartó (OpenRig, gateway de modelos, canales retirados).    |
| [`harness.md`](harness.md)                               | Qué interfaz de chat usar para qué (Claude Code, OpenCode) y la prueba de la ventana de Agents. |
| [`dispatch-playbook.md`](dispatch-playbook.md)           | Delegar trabajo a otro agente o recuperar un turno atascado.                          |
| [`../bench/WORKFLOW.md`](../bench/WORKFLOW.md)           | Recomendación medida: qué agente lanzar y con qué workflow.                           |
| [`../bench/COLLABORATION.md`](../bench/COLLABORATION.md) | Evidencia de cooperación: fan-out, handoff, conflicto, stall.                         |

## Restricciones que siguen vigentes

| Documento                                                          | Cuándo leerlo                                     |
|--------------------------------------------------------------------|---------------------------------------------------|
| [`tetragon-runtime-security.md`](tetragon-runtime-security.md)     | Cambiar lo que registra la auditoría.             |

## Histórico

Las decisiones antiguas (alternativas evaluadas, comparativas, el centro de
control original) se borraron del árbol; siguen en el historial de git.

## Regla de mantenimiento

- Un documento actual no repite el contenido de otro: enlaza.
- Lo histórico no se guarda en el árbol: vive en el historial de git.
- Los resultados de bench viven en `bench/`; los `results/` crudos no son
  documentación.
