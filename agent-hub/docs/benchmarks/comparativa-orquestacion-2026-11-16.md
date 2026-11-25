# Comparativa provisional de plataformas de agentes

Fecha: 2026-11-16. Entorno: Windows, OpenCode v2.3.0 y Agent Hub `8a770dd`.
Prioridades: OpenAI/Codex, Anthropic/Claude, OpenCode, GitHub y OpenRouter.

## Objetivo

Una interfaz para conversar con un coordinador que pueda elegir modelos,
delegar a agentes, mostrar actividad y resultados, conservar el contexto
necesario y controlar permisos, consumo y escrituras concurrentes. Mantener
las suscripciones cuando la integración y sus términos lo permitan.

## Conclusión provisional

**Aviso de seguridad (prueba real): `allow-reads` de Agent Hub no impidió que
Claude Code, Codex y OpenCode escribieran archivos.** Ahora el hub rechaza de
forma preventiva ejecuciones restringidas de todos los adaptadores antes de
arrancarlos. No ofrece todavía una ejecución que garantice solo lectura.

OpenCode cubre selección de modelos y subagentes nativos; Agent Hub añade una
ruta probada a Claude Code y Codex independientes, con su puerta de consentimiento
y auditoría. T3 Code y Hermes son candidatos relevantes según documentación,
pero no se han comparado en vivo. **No hay evidencia suficiente para eliminar
Agent Hub ni para declarar una opción ganadora.**

## Evidencia disponible

| Capacidad                               | OpenCode solo                                                           | OpenCode + Agent Hub                                                           | T3 Code                                    | Hermes                                   |
|-----------------------------------------|-------------------------------------------------------------------------|--------------------------------------------------------------------------------|--------------------------------------------|------------------------------------------|
| Cambio de proveedor en una conversación | Probado: OpenAI a OpenCode Go, conserva código y restricción sencillos  | No es su prueba principal                                                      | Anunciado; no probado                      | No probado                               |
| Delegación y seguimiento                | Subagentes nativos probados en tareas breves                            | Claude, Codex y OpenCode probados con seguimiento                              | Documentado; no probado                    | Documentado; no probado                  |
| Agentes externos completos              | No verificado para Claude Code/Codex                                    | Claude Code y Codex probados                                                   | Anunciados; no probado localmente          | Documenta delegación CLI; no probado     |
| Lectura de archivo y resultado          | Subagente `explore` identificó un fallo en fixture                      | Claude identificó el mismo fallo; respuesta enumeró herramienta Read           | No probado                                 | No probado                               |
| Permisos                                | Editar y shell denegados en prueba; no se observó intento bloqueado     | Consentimiento y denegación cubiertos por pruebas simuladas                    | Políticas de privilegio documentadas       | No probado                               |
| Cancelación                             | Sin prueba real comparable                                              | OpenCode cancelado; auditoría `cancelAck: true`, sin escritura                 | Documentada; no probada                    | No probada                               |
| Concurrencia                            | Worktrees disponibles; comparación pendiente                            | Locks cubiertos con agentes simulados                                          | Worktrees documentados; no probados        | No probado                               |
| Trazas                                  | Resultados de subagente visibles; interfaz no evaluada sistemáticamente | Nombre de herramienta y estado visibles; interfaz no evaluada sistemáticamente | Trazas documentadas; UI no probada         | No probado                               |
| Suscripciones                           | ChatGPT soportado documentalmente; financiación de prueba no verificada | Agentes conectados respondieron; financiación exacta no verificada             | Anunciadas; no comprobadas con las cuentas | Depende de cada proveedor; no comprobado |

Las pruebas reales son breves, sin proyectos de producción, y no permiten
comparar calidad general, velocidad, coste real ni eficiencia del contexto.
Un subagente nativo también generó pruebas de frontera correctas a partir del
hallazgo de Claude que el coordinador le transmitió explícitamente. Eso no
demuestra transferencia automática de transcripciones.
Una cancelación sin escritura no demuestra que una edición en curso se detenga.
Los permisos de herramientas no son un sandbox del sistema.

Prueba real de permisos Claude: un job con `permission: allow-reads`, en un
directorio temporal autorizado, recibió una instrucción de crear un archivo.
El archivo se creó y se verificó su contenido. El registro muestra una llamada
`Write` completada de tipo `edit` y `permissions: []`: no se registró ninguna
solicitud de autorización. El handler del hub solo responde a solicitudes ACP;
estos datos no demuestran por qué el adaptador no solicitó permiso. Las pruebas
unitarias simuladas del handler pasan, pero no cubren esta situación real.
Hasta investigar y verificar una corrección, no usar las políticas del hub como
garantía de solo lectura y no lanzar Claude en árboles sensibles con esa premisa.
Las pruebas reales también demostraron escrituras de Codex y OpenCode con
`allow-reads`. La mitigación actual rechaza `deny` y `allow-reads` para todos
los agentes antes de iniciarlos; no habilita un modo realmente de solo lectura.

En una prueba real de trazas en segundo plano, el hub mostró agente, estado,
tiempo y después modelo; al terminar mostró la última herramienta, y el
resultado enumeró las dos llamadas realizadas. No observamos la herramienta
durante esa ejecución. En otra prueba con OpenCode, `job_status` sí mostró
`shell (pending)` mientras estaba en curso. Es visibilidad puntual mediante
consulta; no se ha demostrado una traza continua en la UI.

También se ejecutaron en paralelo Claude y OpenCode en dos directorios
temporales, ambos de solo lectura. Un mismo estado del hub mostró los dos
agentes activos con identificadores distintos y una herramienta pendiente de
Claude; ambos resultados y sus llamadas quedaron separados. Esto no prueba
ediciones simultáneas ni una planificación compartida automática.

Una prueba posterior sí ejercitó escrituras simultáneas aisladas: Claude y
OpenCode crearon cada uno un archivo distinto en su propio worktree de un
repositorio temporal. Se revisaron ambos archivos y el coordinador los integró
manualmente en la rama principal desechable, que quedó limpia. No hubo prueba
de conflictos ni integración automática en un proyecto real.

Prueba adicional con escritura real aislada: un worker OpenCode del hub creó
un archivo temporal con `ANTES`, inició una espera de 40 segundos y debía
después reemplazarlo con `DESPUES`. Fue cancelado durante la espera: la
auditoría registra `cancelAck: true`, patch completado y espera fallida; al
superar el tiempo de espera previsto, el archivo seguía con `ANTES`. Esto
verifica que no se hizo la segunda edición en este caso, no que una escritura
ya en curso pueda interrumpirse atómicamente ni que ningún proceso hijo quede
vivo en todos los proveedores.

## Integraciones prioritarias: Hermes según documentación

- **OpenAI/Codex:** OAuth de ChatGPT/Codex, runtime Codex opcional y delegación
  al CLI documentados. El runtime opcional tiene limitaciones para herramientas
  de Hermes; comprobar compatibilidad antes de elegirlo.
- **Anthropic/Claude:** API y delegación al Claude Code original documentadas.
  Hermes describe su OAuth directo con Claude Max y créditos de uso adicionales,
  no la cuota incluida. Comprobar términos y facturación; no trasladar tokens
  para esquivar restricciones.
- **OpenCode:** proveedores Go/Zen documentados con claves. No se ha demostrado
  que la suscripción actual del usuario entregue una clave utilizable en Hermes
  ni que esto equivalga a controlar el agente OpenCode completo.
- **GitHub:** repositorios mediante `gh` o MCP; modelos Copilot mediante plugin
  Labs no soportado oficialmente. Distinguir estas dos necesidades.
- **OpenRouter:** clave u OAuth documentados, sujetos a la cuenta y facturación.

Hermes está instalado; su consentimiento de agente en Agent Hub está
deshabilitado. No se lanzó ni se accedió a sus credenciales. Cualquier prueba
mediante el hub necesita una decisión explícita del propietario, sin modificar
o sortear unilateralmente el consentimiento.

## Pendientes para una decisión

1. Misma tarea y revisión en la misma revisión Git, con trazas completas,
   tiempo, tokens y financiación real de cada alternativa.
2. Prueba directa de denegación de una operación concreta y cancelación de una
   edición en un entorno aislado; verificar que el proceso realmente se detiene.
3. Trabajo concurrente con cambios más realistas y conflictos. Ya pasó una
   prueba mínima con worktrees distintos e integración manual revisada.
4. Continuidad automática con evidencia de herramientas al cambiar de modelo y
   seguimiento de un agente externo; el traspaso explícito sencillo ya pasó.
5. Verificar autenticación y condiciones para las cinco integraciones prioritarias
   sin copiar credenciales ni activar una facturación alternativa silenciosa.
6. Evaluar la UI real y el coste de mantenimiento. T3 no está probado; no se
   encontró su CLI en PATH, lo que no descarta una aplicación instalada.
7. Si el usuario lo autoriza, incorporar pruebas de Hermes y después T3; no
   instalar nada antes de completar las comprobaciones posibles con lo existente.

## Fuentes y detalle

- [Evidencia de pruebas](opencode-vs-hub-2026-11-16.md).
- [Agentes OpenCode](https://opencode.ai/docs/agents/),
  [proveedores](https://opencode.ai/docs/providers/) y
  [permisos](https://opencode.ai/docs/permissions/).
- [T3 Code](https://t3.codes/) y su
  [diseño de orquestación](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md).
- [Proveedores Hermes](https://hermes-agent.nousresearch.com/docs/integrations/providers)
  y [runtime Codex](https://hermes-agent.nousresearch.com/docs/user-guide/features/codex-app-server-runtime).
- [Condiciones de autenticación de Anthropic](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).
