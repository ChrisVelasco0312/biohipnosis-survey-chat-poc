# Seguridad — POC de entrevista inicial

> Documento de ingeniería para una prueba de concepto local. No sustituye una
> evaluación de cumplimiento, un análisis de riesgos legal ni una auditoría
> independiente.

## 1. Activos a proteger

| Activo | Dónde vive | Sensibilidad |
|---|---|---|
| Respuestas de salud y familia | `data/sessions/*.enc` | Muy alta |
| Nombre, celular, correo | blobs cifrados + outbox | Alta |
| Transcripciones de voz simulada | blobs cifrados | Alta |
| Adjuntos clínicos | `data/media/<sesión>/` | Muy alta |
| Token de sesión | localStorage del navegador | Alta |
| Token de administración | variable de entorno / localStorage | Crítico |
| Clave maestra | `data/.key` o `POC_MASTER_KEY` | Crítico |
| Auditoría | `data/audit.jsonl` | Media (sin PII) |
| Métricas y costos | `data/metrics.json`, índice | Baja |

## 2. Actores y amenazas

| Actor | Objetivo | Ejemplos |
|---|---|---|
| Usuario malicioso | Manipular el bot, obtener datos, agotar cuota | Inyección de prompt, spam, duplicados, adjuntos maliciosos, acceso a otra sesión |
| Usuario en crisis | Expresar riesgo actual o histórico | Ideación suicida, violencia, emergencia médica |
| Curioso local | Leer archivos o la consola | Path traversal, token débil, PII en logs |
| Proveedor LLM | Fallar, responder lento, devolver JSON inválido o intentar cambiar el flujo | 429, timeout, salida no JSON, acciones inventadas |
| Administrador comprometido | Acceder a PII | Robo de token, lectura de archivos, exportaciones |
| Error de operación | Pérdida o exposición | Borrado accidental, backup sin cifrar, `POC_RATE_LIMIT=off` en producción |

## 3. Principios de diseño

1. **El motor determinista es la autoridad.** El LLM no elige la siguiente
   pregunta, no decide el estado, no envía mensajes directamente y no puede
   saltarse el consentimiento ni el presupuesto.
2. **Todo lo que entra es hostil.** El texto del usuario se sanea, se limita y se
   analiza con reglas deterministas antes de llamar al modelo.
3. **Mínima exposición.** Solo el profesional autenticado ve PII; por defecto la
   consola enmascara. La auditoría no guarda texto libre.
4. **Degradación segura.** Si el modelo falla, se usa heurística; si el
   presupuesto se agota, se deja de llamar al LLM; si el proveedor no está, la
   entrevista continúa.
5. **Trazabilidad.** Las decisiones importantes generan eventos y entradas de
   auditoría con cadena de hashes.

## 4. Controles implementados

### 4.1 Entrada y flujo

| Control | Implementación | Verificación |
|---|---|---|
| Límite de entrada | 2.000 caracteres (`config.limits.maxInputChars`) | `tests/unit/validators.test.js`, API 413 |
| Límite de body | 12 MB (`POC_BODY_LIMIT_BYTES`) | API 413 |
| Una pregunta por mensaje | `engine.askQuestion` usa el `prompt` del catálogo | flujo completo |
| Pregunta exacta | El motor ignora preguntas del modelo y añade la del catálogo | `prompts/interviewer.txt`, motor |
| 18+ | Estado `AGE_PENDING`; menor → `erased` sin guardar | test de integración |
| Consentimiento | Estado `CONSENT_PENDING`; sin aceptar no se guardan respuestas | test de integración |
| Idempotencia | `waMessageId` en `session.meta.idempotency` | test API |
| Duplicados | Ventana de 30 s, 3 idénticos → cooldown 60 s | `ratelimit.test.js` |
| Rate limit | Token bucket IP y sesión, topes horario/diario | `ratelimit.test.js` |
| Concurrencia LLM | Cola de 4 con timeout de espera | `llmQueueDepth` |
| Turnos máximos | 400 por sesión | flujo completo |

### 4.2 Seguridad clínica

| Control | Implementación |
|---|---|
| Crisis actual | `detectCrisis` determinista + override del modelo; recursos 123/106/155/141; pausa y alerta |
| Crisis histórica | Ítems Q19/Q21/Q22 distinguen terceras personas y pasado; no escalan por mención histórica |
| Diagnóstico/tratamiento | `detectDiagnosisRequest` bloquea sin llamar al LLM; respuesta de límite de alcance |
| Consejo médico en salida | `screenOutbound` + `safeMessage`; si aparece, se reemplaza |
| Derivación | Botón/acción `handoff`; estado `HANDOFF` |
| Opt-out | Estado `OPTED_OUT`; no se envían más preguntas |
| Supresión | Estado `ERASED`; el endpoint borra el blob y los medios, deja tombstone de auditoría |
| Resumen | Generado por el motor, no por el LLM; revisión y corrección |

### 4.3 Prompt injection y abuso del modelo

- El prompt del sistema prohíbe obedecer instrucciones del usuario y cambiar el
  esquema.
- El agente `interviewer` tiene **todas las herramientas denegadas**, `steps: 1`
  y temperatura 0.
- El mensaje del usuario se envía por **stdin**, no como argumento visible en
  `ps`.
- El LLM solo puede devolver: `ack`, `extracted`, `coverage`, `validation`,
  `risk`, `off_topic`, `language`, `notes`.
- El backend filtra `extracted` a las claves de subcampos permitidas, acota
  puntuaciones a 0–1, valida el enum de riesgo y recorta el `ack`.
- Cualquier acción, pregunta o texto de flujo que invente el modelo se descarta.
- Si la respuesta no es JSON válido, se reintenta una vez con el fallback y luego
  se usa heurística.

### 4.4 Salida

- Máximo 700 caracteres (`config.limits.maxOutboundChars`).
- Se eliminan HTML, markdown, URLs, backticks, emojis y bloques de código.
- Se bloquean frases de diagnóstico, receta o tratamiento.
- El texto se escapa en el DOM con `textContent`/`esc()`.
- No se muestran enlaces externos; la política de privacidad es local.

### 4.5 Persistencia y acceso

| Control | Implementación |
|---|---|
| Cifrado en reposo | AES-256-GCM por sesión; formato `POC1.iv.tag.cipher` |
| Clave | `data/.key` 0600 o `POC_MASTER_KEY`; nunca en git |
| Índice sin PII | Solo nombre/teléfono enmascarados, estado, progreso, riesgo, costo |
| Archivos | Directorios `0700`, archivos `0600`, escritura atómica |
| Adjuntos | Validación de tamaño, MIME y magic bytes; nombres saneados |
| Sesión | `x-session-token` aleatorio; sin token no se lee/escribe |
| Admin | `x-admin-token` o `?token=`; comparación timing-safe; bloqueo tras 5 fallos/5 min |
| PII en consola | Enmascarada por defecto; “Revelar PII” genera auditoría |
| Exportación | Requiere admin; HTML imprimible sin recursos externos |
| Outbox | Solo se sirve con admin; archivos `0600` |
| Borrado | Elimina blob, índice y medios; auditoría de tombstone |

### 4.6 Cabeceras y red

- Escucha en `127.0.0.1` por defecto.
- CSP: `default-src 'self'`, `script-src 'self'`, `img-src 'self' data:`,
  `style-src 'self' 'unsafe-inline'`, `object-src 'none'`,
  `frame-ancestors 'none'`.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy` restrictiva.
- Comprobación same-origin para métodos mutantes.
- Path traversal bloqueado en estáticos, medios y outbox.
- Logs de request sin query string ni cuerpo.

### 4.7 Costos

- Presupuesto de sombra por sesión: USD 0.15.
- Tope diario: USD 5.
- Aviso al 80 %; al 100 % se deja de llamar al LLM y se usa heurística.
- Tokens estimados por longitud; precios de referencia en `config.modelPrices`.
- La UI muestra costo, tokens, modelo y fallback.

## 5. Verificación

La suite determinista `server/securitySuite.js` ejecuta 22 comprobaciones:

| ID | Comprobación |
|---|---|
| SEC-01 | Inyección de prompt detectada |
| SEC-02 | Solicitud de diagnóstico detectada |
| SEC-03 | Solicitud de datos de terceros bloqueada |
| SEC-04 | Crisis actual crítica |
| SEC-05 | Suicidio histórico familiar no escala |
| SEC-06 | Correo malicioso rechazado |
| SEC-07 | Celular colombiano normalizado |
| SEC-08 | Menor de 18 bloqueado |
| SEC-09 | Fecha inválida/futura rechazada |
| SEC-10 | Salida limitada a 700 |
| SEC-11 | HTML eliminado |
| SEC-12 | Consejo médico de salida bloqueado |
| SEC-13 | Spam duplicado en cooldown |
| SEC-14 | Rate limit por IP |
| SEC-15 | Bloqueo de admin por fuerza bruta |
| SEC-16 | AES-GCM detecta manipulación |
| SEC-17 | Cadena de auditoría válida |
| SEC-18 | Path traversal rechazado |
| SEC-19 | Ejecutable disfrazado rechazado |
| SEC-20 | PII enmascarada |
| SEC-21 | Cambio de hash detectable |
| SEC-22 | Matemática de presupuesto |

Además, `npm test` cubre flujo completo, idempotencia, auth, crisis, pausa,
borrado y exportación.

## 6. Riesgos residuales

1. **Sin WhatsApp real:** no hay firma `X-Hub-Signature-256`, ventana de 24 h,
   plantillas aprobadas ni webhook. La simulación no prueba esos controles.
2. **Sin identidad fuerte:** el token de sesión demuestra posesión, no identidad
   verificada. En producción se necesita auth del prestador y del paciente.
3. **Admin local:** un administrador con acceso al equipo y a la clave puede leer
   todo. El cifrado en reposo no protege contra root comprometido.
4. **Modelo de terceros:** el texto puede salir del equipo si `POC_LLM=opencode`.
   La política de privacidad lo advierte; en producción se requiere DPA,
   minimización y evaluación de transferencia.
5. **Voz simulada:** no hay STT real ni verificación de audio; la transcripción
   es editable.
6. **Rate limit en memoria:** se reinicia con el proceso. En producción usar
   Redis/limiter distribuido.
7. **Suite de seguridad:** `runSecuritySuite` llama a `rate.reset()` y puede
   limpiar cooldowns activos. Es aceptable en demo; en producción aislar el
   estado de pruebas.
8. **Retención:** se reporta, pero no hay job de purga automática.
9. **Sin backups:** no hay estrategia de respaldo cifrado ni restauración.
10. **Sin pruebas de carga:** la cola LLM es básica; no se midió concurrencia
    real.

## 7. Checklist antes de producción

- [ ] Webhook oficial con verificación de firma y ventana de 24 h.
- [ ] Auth fuerte de pacientes y profesionales; RBAC.
- [ ] DPA con proveedor LLM; minimización; opción sin transferencia.
- [ ] Cifrado de extremo a extremo o cifrado de campo con KMS.
- [ ] Rate limiting distribuido y protección DDoS.
- [ ] Job de retención y borrado verificable.
- [ ] Backups cifrados y pruebas de restauración.
- [ ] Monitoreo, alertas y on-call.
- [ ] Revisión legal de consentimiento, privacidad y datos sensibles.
- [ ] Pruebas de penetración y revisión de accesibilidad.
- [ ] Protocolo clínico de crisis y derivación validado por profesionales.
- [ ] Matriz de riesgos y plan de respuesta a incidentes.
