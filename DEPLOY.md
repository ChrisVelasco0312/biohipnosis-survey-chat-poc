# Guía rápida de despliegue

Esta es la guía para **desplegar cambios del día a día**. El montaje inicial,
permisos, OAuth y provisión de recursos ya están hechos y se documentan en
[`docs/DEPLOY.md`](docs/DEPLOY.md).

- **Proyecto:** `biohipnosis-poc-2026`
- **Hosting:** https://biohipnosis-poc-2026.web.app
- **API (Cloud Run):** `biohipnosis-api`, región `us-central1`
- **URL directa de la API:** https://biohipnosis-api-318941383848.us-central1.run.app

## 1. ¿Qué cambiaste? → qué desplegar

| Cambio | Comando |
| --- | --- |
| `public/**` (HTML, CSS, JS, textos) | `firebase deploy --only hosting` |
| `server/**`, `prompts/**` o `Dockerfile` | `gcloud run deploy biohipnosis-api --source .` |
| `functions/**` | `firebase deploy --only functions` |
| Variables de entorno | `gcloud run services update ... --update-env-vars ...` |
| Secretos (API keys) | Secret Manager + `--update-secrets` |
| Lista de correos autorizados | `npm run allowlist -- correo1@gmail.com ...` (sin deploy) |
| Rotar la clave de OpenCode | Consola → pestaña **Clave** (sin deploy) |

> El frontend y el backend se despliegan por separado. Cambiar el backend **no**
> requiere volver a desplegar Hosting: el rewrite `/api/**` ya apunta al
> servicio de Cloud Run.

## 2. Requisitos (una sola vez por máquina)

```bash
gcloud auth login
gcloud config set project biohipnosis-poc-2026
gcloud auth application-default login   # solo para scripts con Firestore
firebase login
```

Comprueba que estás en el proyecto correcto:

```bash
gcloud config get-value project
# biohipnosis-poc-2026
```

## 3. Antes de desplegar

```bash
npm test          # 47 pruebas
npm run smoke     # arranque + health + sesión
git diff --check  # espacios/errores tontos
```

Si tocaste el frontend, prueba en local:

```bash
POC_AUTH=off npm start
# http://127.0.0.1:3210
```

## 4. Desplegar el frontend

```bash
firebase deploy --only hosting --project biohipnosis-poc-2026
```

Solo sube `public/`. No hay build ni paso de compilación. `firebase.json` ya
fuerza `Cache-Control: no-cache`, así que los usuarios reciben la versión nueva
al recargar.

## 5. Desplegar el backend

Desde la raíz del repo (Cloud Build usa el `Dockerfile`):

```bash
gcloud run deploy biohipnosis-api \
  --source . \
  --project biohipnosis-poc-2026 \
  --region us-central1 \
  --quiet
```

La primera vez tarda unos minutos. Las variables de entorno, secretos, memoria,
timeouts y `--max-instances 1` **se conservan**; no hace falta repetirlos en
cada deploy.

Verifica la revisión nueva:

```bash
gcloud run services describe biohipnosis-api \
  --project biohipnosis-poc-2026 \
  --region us-central1 \
  --format='value(status.latestReadyRevisionName)'
```

> **No cambies `--max-instances 1`.** El almacenamiento mantiene el índice y la
> cadena de auditoría en memoria; escalar a varias instancias puede corromper
> la consistencia.

## 6. Desplegar funciones

```bash
firebase deploy --only functions --project biohipnosis-poc-2026
```

La función `beforeUserSignedIn` bloquea el login de correos no autorizados. Su
**registro** en Identity Platform es un paso único de consola/REST (ver
`docs/DEPLOY.md`); volver a desplegar la función no lo borra.

Si cambias Hosting y funciones a la vez:

```bash
firebase deploy --only hosting,functions --project biohipnosis-poc-2026
```

## 7. Cambiar variables de entorno

Usa `--update-env-vars` para **agregar o modificar** sin borrar las demás:

```bash
gcloud run services update biohipnosis-api \
  --project biohipnosis-poc-2026 \
  --region us-central1 \
  --update-env-vars POC_ALLOWED_EMAILS=persona1@gmail.com,persona2@gmail.com
```

Para reemplazar **todas** las variables, usa `--set-env-vars` con la lista
completa. Variables actuales:

```text
POC_STORE=cloud
POC_HOST=0.0.0.0
POC_PORT=8080
POC_AUTH=on
POC_PUBLIC_ORIGIN=https://biohipnosis-poc-2026.web.app
POC_GCP_PROJECT=biohipnosis-poc-2026
POC_GCS_BUCKET=biohipnosis-poc-2026-data
POC_ADMIN_EMAILS=cristianvelasco0312@gmail.com
POC_OWNER_EMAIL=cristianvelasco0312@gmail.com
POC_ALLOWED_EMAILS=cristianvelasco0312@gmail.com
```

## 8. Secretos

Los valores **nunca** se guardan en el repo ni se pasan en texto plano por la
línea de comandos del deploy. Se crean en Secret Manager y Cloud Run los monta.

Crear un secreto nuevo:

```bash
printf '%s' 'VALOR' | gcloud secrets create NOMBRE \
  --project biohipnosis-poc-2026 \
  --replication-policy=automatic \
  --data-file=-
```

Agregar una versión nueva a uno existente:

```bash
printf '%s' 'VALOR' | gcloud secrets versions add NOMBRE \
  --project biohipnosis-poc-2026 \
  --data-file=-
```

Montar/actualizar secretos en Cloud Run (conserva los demás):

```bash
gcloud run services update biohipnosis-api \
  --project biohipnosis-poc-2026 \
  --region us-central1 \
  --update-secrets POC_MASTER_KEY=POC_MASTER_KEY:latest,RESEND_API_KEY=RESEND_API_KEY:latest
```

Secretos del proyecto:

| Secreto | Uso | ¿Montado como env? |
| --- | --- | --- |
| `POC_MASTER_KEY` | Cifra las sesiones | Sí |
| `OPENCODE_API_KEY` | Clave del modelo | No; se lee desde Secret Manager |
| `RESEND_API_KEY` | Correo de renovación | Sí |

- **`POC_MASTER_KEY` no se rota a la ligera:** si cambia, las sesiones viejas
  dejan de poder descifrarse.
- `OPENCODE_API_KEY` se lee siempre en su versión `latest` (caché de 60 s).
  Rotarla no requiere redeploy; basta con crear una versión nueva o usar la
  pestaña **Clave** de la consola.
- Después de actualizar `RESEND_API_KEY`, crea una revisión nueva (comando de
  arriba) para que el contenedor reciba el valor.

## 9. Autorizar o quitar testers

La fuente de verdad incluye Firestore `system/allowlist`:

```bash
npm run allowlist -- persona1@gmail.com persona2@gmail.com
```

El script **reemplaza** el contenido de `system/allowlist` por exactamente los
correos que pases. Incluye siempre a todos los testers que deban seguir
entrando. Los administradores de `POC_ADMIN_EMAILS` siguen permitidos aunque no
estén en esa lista. No requiere deploy. Para que el **login** quede bloqueado
desde Google, la función `beforeUserSignedIn` también debe estar registrada.

## 10. Verificación después del deploy

```bash
curl -s https://biohipnosis-poc-2026.web.app/api/health
```

Debe responder `"ok": true`. Para el modelo:

```json
"llm": { "mode": "opencode", "available": true, "keyState": "valid" }
```

Si `available` es `false`, revisa `lastError`:

- `key_invalid` / `key_expired` → rotar la clave en la pestaña **Clave**.
- `provider.quota` / `free-limit` → cuota de OpenCode; el motor sigue con
  heurística.

Prueba funcional mínima:

1. Abre https://biohipnosis-poc-2026.web.app con `Ctrl+Shift+R`.
2. Inicia sesión con un correo autorizado.
3. Crea una entrevista y responde una pregunta de **contenido** (edad y
   consentimiento son deterministas a propósito).
4. Confirma que la línea del modelo diga `glm-5.3-flash · listo`.

Logs del backend:

```bash
gcloud run services logs read biohipnosis-api \
  --project biohipnosis-poc-2026 \
  --region us-central1 \
  --limit 50
```

## 11. Rollback

Backend (volver a una revisión anterior):

```bash
gcloud run revisions list --service biohipnosis-api \
  --project biohipnosis-poc-2026 --region us-central1

gcloud run services update-traffic biohipnosis-api \
  --project biohipnosis-poc-2026 --region us-central1 \
  --to-revisions biohipnosis-api-00002-xf7=100
```

Frontend (dos opciones):

1. **Consola de Firebase** → Hosting → historial de versiones → *Rollback*.
2. **Volver a desplegar el commit anterior:**

```bash
git checkout <commit-anterior>
firebase deploy --only hosting --project biohipnosis-poc-2026
git checkout -
```

## 12. Reglas de oro

- No subas `.env`, `data/`, `.key`, credenciales ni service accounts al repo
  (ya están en `.gitignore`).
- `public/firebase-config.js` **sí** se commitea: la configuración web de
  Firebase es pública por diseño.
- No cambies `POC_MASTER_KEY` si ya hay sesiones reales.
- Mantén `--max-instances 1`.
- Despliega solo después de `npm test`.
- Para el detalle de la provisión inicial (OAuth, Firestore, bucket, IAM,
  función bloqueante), consulta [`docs/DEPLOY.md`](docs/DEPLOY.md).
