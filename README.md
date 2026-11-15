# Biohipnosis Sistémica — entrevista inicial (POC)

Prueba de concepto de la entrevista inicial de 39 ítems descrita en
`docs/04_system_specification_en.md`, con una interfaz de chat inspirada en
WhatsApp Web, una consola para el profesional y un laboratorio de pruebas de
seguridad. Corre en local o desplegada en **Firebase Hosting + Cloud Run** con
acceso restringido por cuenta de Google.

> Esta POC no es un producto clínico. No diagnostica, no trata y no sustituye
> atención médica. Usa datos ficticios.

---

## 1. Qué incluye

- Chat de entrevista con **39 ítems en 8 secciones** (A–H), una pregunta por
  mensaje y texto de pregunta controlado por el motor determinista.
- Verificación de **18+** y **consentimiento informado** antes de guardar
  respuestas.
- Texto, **nota de voz simulada** (grabación real en el navegador, transcripción
  editable y confianza) y adjuntos validados.
- Rúbrica de calidad con pesos: relevancia .30, completitud .25, especificidad
  .20, coherencia .15, seguridad .10.
- Aceptar ≥ .75 · aclarar .45–.74 · parcial tras 2 aclaraciones · anulación por
  seguridad.
- Pausa/reanudación, recordatorio simulado de 24 h (máximo uno), derivación
  humana y cierre con resumen.
- Detección determinista de crisis, inyección de prompt, solicitud de
  diagnóstico y acceso a datos de terceros.
- Presupuesto de sombra por sesión (USD 0.15) y tope diario, con degradación a
  heurística.
- Persistencia **cifrada en reposo** (AES-256-GCM), índice sin PII, auditoría con
  cadena de hashes y máscara de PII.
- Consola del profesional: sesión, cuadrícula de 39 ítems, eventos, seguridad,
  costos y exportación JSON/HTML/imprimible.
- Laboratorio de pruebas con escenarios de abuso, errores, spam, duplicados,
  adjuntos maliciosos, crisis, suite de seguridad y auditoría.
- **Prueba libre por pregunta o sección**: salta directo a cualquier ítem,
  repite el intento con otras respuestas y no deja sesiones, auditoría ni
  métricas (vive solo en memoria durante 2 h).
- Exportación a HTML imprimible (PDF con el diálogo de impresión) y correo
  **simulado** en una bandeja local.

---

## 2. Arranque rápido

Requisitos: **Node.js 24+** (probado con v24.21) y, para el modelo real,
**OpenCode** autenticado.

```bash
cd biohipnosis-survey-chat-poc
npm start
```

Abrir <http://127.0.0.1:3210>. El servidor escucha solo en `127.0.0.1`.

Si el proveedor no está disponible o no hay cuota, la POC sigue funcionando con
el motor heurístico:

```bash
POC_LLM=off npm start
```

Para usar el modelo real en local hace falta una clave de OpenCode (la misma que
se rota desde la consola del profesional):

```bash
OPENCODE_API_KEY='sk-...' POC_LLM=opencode npm start
```

En local la autenticación con Google está desactivada (`POC_AUTH=off`) y la
consola usa el token de administración. En producción se activa con
`POC_AUTH=on`; ver la guía rápida [`DEPLOY.md`](DEPLOY.md) y el runbook
detallado [`docs/DEPLOY.md`](docs/DEPLOY.md).

El token de administración de demo es `poc-admin`. Cámbialo:

```bash
POC_ADMIN_TOKEN='un-token-largo-y-aleatorio' npm start
```

La clave de cifrado se genera en `data/.key` con permisos `0600`. Para usar una
clave externa:

```bash
export POC_MASTER_KEY="$(openssl rand -base64 32)"
```

> Los datos de `data/` están excluidos de git. No los compartas.

---

## 3. Recorrido de demostración

1. **Nueva entrevista** → nombre ficticio → el bot saluda y pide confirmar 18+.
2. **Acepto** → consentimiento → sección A, ítem D01.
3. Responder D01; al ser un dato crítico, el bot pide confirmación.
4. Abrir el **laboratorio** (matraz) y probar:
   - Inyección de prompt.
   - Solicitud de diagnóstico.
   - Datos de otra persona.
   - Crisis actual (escala, da recursos 123/106/155/141 y pausa).
   - Ráfaga de spam (con rate limit activo).
   - Duplicado por `waMessageId`.
   - Adjunto `.exe` disfrazado de PDF.
   - Voz con confianza baja (pide confirmación).
   - Suite de seguridad 22/22.
   - **Prueba libre por pregunta**: elegir una pregunta o sección y saltar
     directo a ella; «Repetir» limpia el intento para probar otra respuesta.
     Estas pruebas viven solo en memoria y no se guardan como sesiones reales.
5. Abrir la **consola** (icono de panel) → token `poc-admin`:
   - Ver respuestas, eventos, costos y auditoría.
   - Revelar PII (queda auditado).
   - Exportar JSON/HTML, imprimir o “enviar” el correo simulado.
6. Completar la entrevista o usar “Avanzar 25 h” para ver el recordatorio.

---

## 4. Arquitectura

```
Navegador (HTML/CSS/JS, sin build)
  │  fetch JSON
  ▼
server/index.js  ── auth de sesión/admin, rate limit, estáticos, headers
  │
  ├─ engine.js       máquina de estados determinista (dueña del flujo)
  ├─ catalog.js      39 ítems, secciones, subcampos, criterios
  ├─ validators.js   formatos, rúbrica, crisis, inyección, PII, sanitización
  ├─ safety.js       respuestas fijas y pantallas de salida
  ├─ llm.js          OpenCode Inference (HTTPS) + fallback heurístico
  ├─ auth.js         Firebase ID token + allowlist (Google Sign-In)
  ├─ keyManager.js   rotación de la clave en Secret Manager + Firestore
  ├─ notify.js       avisos de renovación por correo (Resend)
  ├─ store.js        fachada de sesiones cifradas, índice, auditoría, métricas
  ├─ store-fs.js     driver local (data/)
  ├─ store-cloud.js  driver Firestore + GCS (Cloud Run)
  ├─ crypto.js       AES-256-GCM, hashes, comparación segura
  ├─ media.js        adjuntos y voz simulada
  ├─ sandbox.js      pruebas libres efímeras (solo memoria, TTL 2 h)
  ├─ export.js       resumen, HTML imprimible, correo simulado
  └─ securitySuite.js 22 controles deterministas
```

**Principio central:** el LLM es un asesor no confiable. El motor decide la
siguiente pregunta, los umbrales, las pausas, el presupuesto y las acciones. Si
el modelo falla, responde lento, devuelve JSON inválido o intenta cambiar el
flujo, el motor usa heurística y continúa.

El prompt del sistema vive en `prompts/interviewer.txt`: sin herramientas, un
solo paso, temperatura 0.2 y salida JSON estricta. El servidor lo envía como
mensaje `system` a la API compatible con OpenAI de OpenCode y valida la
respuesta antes de usarla.

---

## 5. Variables de entorno

| Variable | Default | Uso |
|---|---|---|
| `POC_HOST` | `127.0.0.1` | Interfaz de escucha. En Cloud Run: `0.0.0.0`. |
| `POC_PORT` | `3210` | Puerto (`PORT` también se acepta). |
| `POC_DATA_DIR` | `./data` | Datos locales cuando `POC_STORE=fs`. |
| `POC_STORE` | `fs` | `fs` (local) o `cloud` (Firestore + GCS). |
| `POC_GCS_BUCKET` | `biohipnosis-poc-2026-data` | Bucket de sesiones, medios y outbox. |
| `POC_AUTH` | `off` | `on` exige Google Sign-In + allowlist en `/api/*`. |
| `POC_ALLOWED_EMAILS` | vacío | Correos con acceso, separados por coma. |
| `POC_ADMIN_EMAILS` | `cristianvelasco0312@gmail.com` | Correos con consola de profesional. |
| `POC_OWNER_EMAIL` | `cristianvelasco0312@gmail.com` | Destinatario de solicitudes de renovación. |
| `POC_PUBLIC_ORIGIN` | vacío | Origen público, p. ej. `https://…web.app`, para validar same-origin detrás de Hosting. |
| `POC_LLM` | `opencode` | `opencode`, `off` o `heuristic`. |
| `POC_MODEL` | `opencode-go/glm-5.3-flash` | Modelo primario. |
| `POC_FALLBACK_MODEL` | `opencode-go/deepseek-v4.1-flash` | Fallback. |
| `OPENCODE_API_KEY` | vacío | Clave de OpenCode en desarrollo. En la nube se lee de Secret Manager. |
| `POC_OPENCODE_SECRET` | `OPENCODE_API_KEY` | Nombre del secreto en Secret Manager. |
| `POC_ADMIN_TOKEN` | `poc-admin` | Token de la consola cuando `POC_AUTH=off`. Cámbialo. |
| `POC_MASTER_KEY` | generada | Clave base64 de 32 bytes para cifrar sesiones. |
| `RESEND_API_KEY` | vacío | Habilita los correos de renovación. |
| `POC_EMAIL_FROM` | `onboarding@resend.dev` | Remitente verificado en Resend. |
| `POC_SESSION_BUDGET_USD` | `0.15` | Presupuesto de sombra por sesión. |
| `POC_DAILY_BUDGET_USD` | `5` | Tope diario de sombra. |
| `POC_RATE_LIMIT` | `on` | `off` solo para pruebas automatizadas. |
| `POC_LLM_TIMEOUT_MS` | `9000` | Timeout primario. |
| `POC_LLM_RETRY_TIMEOUT_MS` | `7000` | Timeout del fallback. |

Los precios de `server/config.js` son **de sombra**: los modelos usados son
gratuitos, pero se contabilizan para demostrar el control de costo.

---

## 6. Datos y seguridad

- Cada sesión se guarda como un blob cifrado
  `data/sessions/<id>.enc`; el índice `data/index.json` solo tiene nombre
  enmascarado, teléfono enmascarado, estado, progreso, riesgo y costo.
- La auditoría `data/audit.jsonl` no guarda texto libre ni PII; usa una cadena de
  hashes verificable.
- Los adjuntos van a `data/media/<sesión>/` con permisos `0600`; se validan por
  tamaño, MIME y magic bytes.
- El correo es simulado: se escribe HTML en `data/outbox/` y se sirve solo con
  token de administración.
- La PII se enmascara en la consola hasta pulsar “Revelar PII”; ese acceso se
  audita.
- El servidor aplica CSP, `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`, comprobación same-origin, límite de body y protección
  contra path traversal.

Ver [`docs/SECURITY.md`](docs/SECURITY.md) para el modelo de amenaza y
[`docs/TEST-MATRIX.md`](docs/TEST-MATRIX.md) para la matriz de pruebas.

---

## 7. Pruebas

```bash
npm test          # 47 pruebas unitarias + integración
npm run security  # suite determinista 22/22
npm run smoke     # smoke test HTTP (servidor debe estar arriba)
```

La prueba de integración recorre los **39 ítems** hasta `COMPLETED`, confirma
campos críticos, revisa secciones, acepta el resumen y verifica el correo
simulado. Usa `POC_LLM=off` para no depender de la red.

Resultado de referencia en este entorno:

```
npm test          -> 47 pass, 0 fail
npm run security  -> 1 pass (22/22 checks)
```

---

## 8. Limitaciones conocidas

- No hay webhook real de WhatsApp ni verificación de firma de Meta; el chat es
  una simulación local.
- La voz es **simulada**: se graba audio en el navegador, pero no se transcribe
  con Whisper. La transcripción se escribe/edita y la confianza es un control
  de la demo.
- El correo de **exportación** sigue siendo simulado: se guarda en
  `data/outbox/` (o GCS). Solo los avisos de renovación de la clave salen por
  Resend.
- El cifrado protege en reposo, no contra un administrador con acceso a las
  claves del proyecto.
- El modelo puede estar limitado por cuota; la POC degrada a heurística y lo
  muestra en la interfaz.
- La rotación de la clave de OpenCode es manual y auditada: OpenCode no ofrece
  rotación programática soportada para claves personales.
- Cloud Run está limitado a **una instancia** porque el índice y la cadena de
  auditoría usan caché en memoria con escritura diferida.
- La retención se reporta y se simula; el borrado real está disponible, pero no
  hay un planificador de purga.
- No usar con datos reales de pacientes sin revisar cumplimiento, contratos,
  DPA, cifrado de extremo a extremo, alojamiento y auditoría legal.

Más decisiones y siguientes pasos en [`docs/POC-NOTES.md`](docs/POC-NOTES.md).
