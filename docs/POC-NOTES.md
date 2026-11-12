# Notas de la POC

## 1. Decisiones de diseño

| Decisión | Motivo | Consecuencia |
|---|---|---|
| Node 24 sin dependencias | Arranque inmediato, superficie mínima, fácil de auditar | No hay framework ni ORM; se implementa HTTP y crypto a mano |
| Frontend vanilla, sin build | La POC debe correr con `npm start` | Más JS explícito, sin bundler |
| Motor determinista dueño del flujo | Evita que el LLM cambie preguntas, omita consentimiento o gaste tokens | Más código de estado, pero comportamiento reproducible |
| LLM solo como asesor | Modelo gratuito, no confiable, con cuota y latencia variable | Si falla, heurística; la calidad baja pero el flujo no se rompe |
| Persistencia cifrada por sesión | Datos de salud muy sensibles | El índice no se puede leer sin descifrar cada blob |
| Sin base de datos | Inspección local, cero dependencias | No escala a miles de sesiones; no hay consultas |
| Voz simulada | No hay Whisper instalado; el usuario pidió POC | Se graba audio real, pero la transcripción es editable y la confianza es un control de demo |
| Correo simulado | No hay proveedor ni credenciales | El “envío” queda en `data/outbox/` y se puede abrir con token admin |
| Token admin de demo | Facilita la revisión | Debe cambiarse; se advierte en UI y logs |
| Rate limit en memoria | Demostración simple | Se reinicia con el proceso; no es distribuido |

## 2. Desviaciones conscientes del documento

1. **WhatsApp real:** no hay webhook, plantillas aprobadas ni ventana de 24 h.
   La UI imita WhatsApp Web y la API usa un `waMessageId` simulado.
2. **STT:** la transcripción es editable; no se envía audio a ningún STT.
3. **Correo:** no sale del equipo; se genera HTML y metadatos.
4. **Dashboard:** es una consola lateral, no una aplicación separada.
5. **PDF:** se genera HTML imprimible; el PDF se obtiene con “Imprimir → Guardar
   como PDF” del navegador.
6. **Recordatorio:** es un mensaje simulado en la conversación, no una plantilla
   de WhatsApp aprobada.
7. **Precios:** son de sombra; los modelos usados son gratuitos. El objetivo es
   demostrar el control, no facturar.
8. **Purga:** hay borrado real y reporte de retención, pero no un job
   automático.

## 3. Estado del proveedor LLM

En este entorno, los modelos gratuitos de OpenCode devolvieron
`HTTP 429 provider.free-limit` con una ventana de espera de varias horas, y el
modelo pagado devolvió `HTTP 402 insufficient funds`. Por eso:

- La POC se probó con `POC_LLM=off`, usando el motor heurístico.
- El adaptador de OpenCode está implementado y probado en su parsing, timeouts,
  fallback y cooldown.
- La UI muestra “Modo heurístico local” y el health check informa el estado.
- Cuando la cuota se restablezca, `POC_LLM=opencode npm start` usa el modelo
  real sin cambios de código.

Esto es intencional: una POC de seguridad no debe depender de que el proveedor
gratuito esté disponible.

## 4. Resultados observados

- Flujo completo de 39 ítems hasta `COMPLETED` en 74 turnos con heurística.
- 39/39 registrados (M04 queda como “no aplica” si no hay diagnóstico); 3 parciales (D11, D12, Q22) por respuestas concisas.
- Resumen final confirmado y correo simulado generado.
- Suite de seguridad 22/22.
- `npm test`: 43/43.
- Interfaz probada con Chrome headless a 1440×900: creación, edad,
  consentimiento, D01, confirmación, inspector, respuestas, seguridad, test lab,
  inyección, crisis y suite.
- Sin errores de consola tras corregir el favicon y el subtítulo de “escribiendo”.

## 5. Costos

Con los precios de sombra de `config.modelPrices`:

| Concepto | Valor |
|---|---|
| Presupuesto por sesión | USD 0.15 |
| Tope diario | USD 5.00 |
| Aviso | 80 % |
| Corte | 100 % → heurística |
| Modelo primario | GLM 5.3 Flash Free (sombra 0.05/0.15 por 1M) |
| Fallback | DeepSeek V4.1 Flash Free (sombra 0.15/0.60 por 1M) |

El costo real de la POC es 0 porque los modelos son gratuitos. En producción se
debe medir con tokens reales, no estimados por longitud.

## 6. Qué revisar primero

1. `server/engine.js`: máquina de estados y límites.
2. `server/validators.js`: crisis, inyección, rúbrica y sanitización.
3. `server/llm.js`: aislamiento del modelo, timeouts y fallback.
4. `server/securitySuite.js`: 22 controles.
5. `docs/SECURITY.md`: riesgos residuales y checklist.
6. `docs/TEST-MATRIX.md`: cobertura y casos manuales.

## 7. Siguientes pasos sugeridos

### Producto
- Webhook real de WhatsApp Cloud API con verificación de firma.
- STT real con consentimiento explícito y retención de audio.
- Envío de correo real con proveedor transaccional y plantilla aprobada.
- Dashboard separado con RBAC, no un token compartido.
- Flujo de tutor para menores de edad.
- Firma de consentimiento y versionado legal.

### Seguridad
- Rate limiting distribuido (Redis) y protección DDoS.
- KMS/HSM para claves; rotación y separación por tenant.
- Cifrado de campo además del cifrado de archivo.
- Job de retención y borrado verificable.
- Backups cifrados y restauración probada.
- Pruebas de penetración y revisión de dependencias.
- Aislamiento del estado de la suite de seguridad para no limpiar cooldowns
  reales.

### Clínico
- Validar el protocolo de crisis con profesionales y líneas locales.
- Definir qué hace el profesional cuando recibe una alerta.
- Medir acuerdo entre la rúbrica heurística y evaluadores humanos.
- Revisar sesgos y lenguaje en las preguntas.
- Añadir consentimiento para uso secundario de datos, si aplica.

### Operación
- Métricas y alertas (latencia, 429, fallback, costo, crisis).
- Runbook de incidentes y contacto de guardia.
- Pruebas de carga con concurrencia real.
- Monitoreo de la cadena de auditoría y del cifrado.
- Documento de retención y privacidad revisado por legal.

## 8. Limitaciones para la decisión

Esta POC demuestra que el flujo, los controles y la experiencia son viables,
pero **no** demuestra cumplimiento normativo, seguridad de producción ni
efectividad clínica. Antes de usar datos reales se necesita una revisión legal,
de seguridad y clínica independiente.
