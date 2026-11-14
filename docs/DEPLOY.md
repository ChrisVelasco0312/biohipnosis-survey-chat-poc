# Despliegue en Firebase + Cloud Run

Runbook de la POC de Biohipnosis Sistémica. La aplicación sigue siendo el mismo
servidor Node; solo cambia dónde corre y dónde guarda los datos.

## Arquitectura

```
Navegador (public/, Firebase SDK)
   │  Google Sign-In (Identity Platform)
   │  Authorization: Bearer <ID token>
   ▼
Firebase Hosting  ──/api/**──▶  Cloud Run: biohipnosis-api
                                   │  verifica token + allowlist
                                   ├─ Firestore: índice, auditoría, métricas, allowlist, estado de la clave
                                   ├─ GCS: sesiones cifradas, adjuntos, outbox
                                   ├─ Secret Manager: POC_MASTER_KEY, OPENCODE_API_KEY, RESEND_API_KEY
                                   └─ OpenCode Inference API (HTTPS)
```

**Una sola instancia.** Cloud Run corre con `--max-instances 1` a propósito: el
driver de almacenamiento mantiene el índice y la cadena de auditoría en memoria y
hace escritura diferida a Firestore/GCS. No lo escales horizontalmente sin mover
esa lógica a transacciones.

## Estado ya provisionado

| Recurso | Valor |
| --- | --- |
| Proyecto | `biohipnosis-poc-2026` (número `318941383848`) |
| Facturación | vinculada y activa |
| Firestore | nativo, `us-central1` |
| Bucket | `gs://biohipnosis-poc-2026-data` |
| Secretos | `POC_MASTER_KEY` v1, `OPENCODE_API_KEY` v1 |
| Service account | `318941383848-compute@developer.gserviceaccount.com` con `datastore.user`, `storage.objectAdmin`, `secretmanager.secretAccessor`, `secretmanager.secretVersionManager` |
| Web app | `1:318941383848:web:2232162b39bec7347e069d` |

APIs habilitadas: `run`, `cloudbuild`, `artifactregistry`, `firestore`,
`storage`, `secretmanager`, `identitytoolkit`, `cloudscheduler`,
`cloudfunctions`, `eventarc`, `pubsub`.

## 1. Configurar el acceso con Google

En la consola de Firebase del proyecto:

1. **Authentication → Sign-in method → Google**: habilitar.
2. **Authentication → Settings → Authorized domains**: deben estar
   `biohipnosis-poc-2026.web.app`, `biohipnosis-poc-2026.firebaseapp.com` y
   `localhost` (este último solo para desarrollo).
3. **Google Cloud Console → APIs & Services → OAuth consent screen**:
   - Tipo: External.
   - Scopes: `email`, `profile`, `openid`.
   - **Publicar la app** (Publishing status: In production). Con la app en
     "Testing", los tokens de usuarios de prueba externos caducan a los 7 días.
   - Completar nombre, correo de soporte y política de privacidad.

Sin publicar el consentimiento, los testers tendrán que renovar sesión cada
semana. Publicarlo no requiere verificación para scopes básicos.

### Allowlist

La fuente de verdad es el servidor. Hay dos capas:

1. `POC_ALLOWED_EMAILS` / `POC_ADMIN_EMAILS` (variables de entorno).
2. Firestore `system/allowlist` → campo `emails` (array).

Sembrar o actualizar la lista:

```bash
gcloud auth application-default login
npm run allowlist -- persona1@gmail.com persona2@gmail.com
```

La función bloqueante `functions/beforeSignIn` (opcional, defensa en
profundidad) lee la misma lista y rechaza el inicio de sesión antes de emitir el
token. Sin ella, la API igualmente responde `403 not_allowed`.

## 2. Crear el secreto de correo (Resend)

Solo necesario para el botón **Solicitar renovación** de la clave.

```bash
# Crea la cuenta en resend.com, verifica el correo del dueño y genera una API key.
printf '%s' 're_...' | gcloud secrets create RESEND_API_KEY \
  --project biohipnosis-poc-2026 \
  --replication-policy automatic \
  --data-file=-

gcloud secrets add-iam-policy-binding RESEND_API_KEY \
  --project biohipnosis-poc-2026 \
  --member serviceAccount:318941383848-compute@developer.gserviceaccount.com \
  --role roles/secretmanager.secretAccessor
```

Sin `RESEND_API_KEY`, el botón responde `not_configured` y la aplicación sigue
funcionando. Si el dominio aún no está verificado en Resend, el remitente
`onboarding@resend.dev` solo puede enviar al correo dueño de la cuenta Resend;
ese es justamente el destinatario de las solicitudes.

## 3. Desplegar la API en Cloud Run

```bash
gcloud run deploy biohipnosis-api \
  --project biohipnosis-poc-2026 \
  --region us-central1 \
  --source . \
  --allow-unauthenticated \
  --max-instances 1 \
  --min-instances 0 \
  --cpu 1 \
  --memory 512Mi \
  --timeout 60 \
  --set-secrets POC_MASTER_KEY=POC_MASTER_KEY:latest,RESEND_API_KEY=RESEND_API_KEY:latest \
  --set-env-vars POC_STORE=cloud,POC_HOST=0.0.0.0,POC_PORT=8080,POC_AUTH=on,POC_PUBLIC_ORIGIN=https://biohipnosis-poc-2026.web.app,POC_GCP_PROJECT=biohipnosis-poc-2026,POC_GCS_BUCKET=biohipnosis-poc-2026-data,POC_ADMIN_EMAILS=cristianvelasco0312@gmail.com,POC_OWNER_EMAIL=cristianvelasco0312@gmail.com,POC_ALLOWED_EMAILS=persona1@gmail.com,persona2@gmail.com
```

Notas:

- `OPENCODE_API_KEY` **no** se monta como variable: `keyManager` lee siempre la
  última versión del secreto, para que una rotación surta efecto sin redeploy.
- `POC_MASTER_KEY` sí debe llegar como variable de entorno porque `crypto.js` la
  lee al arrancar.
- `--allow-unauthenticated` es necesario para que Hosting pueda invocar el
  servicio; la autenticación real la hace la aplicación con el ID token.
- Si `RESEND_API_KEY` aún no existe, quita `,RESEND_API_KEY=...` del flag.

## 4. Desplegar Hosting y la función bloqueante

```bash
firebase deploy --only hosting,functions --project biohipnosis-poc-2026
```

Si solo cambió el frontend: `firebase deploy --only hosting`.
Si solo cambió el servidor: repetir el `gcloud run deploy` (Cloud Build hace la
imagen desde el `Dockerfile`).

### Registrar la función bloqueante (opcional)

El despliegue crea la función, pero Identity Platform debe conocerla:

**Firebase Console → Authentication → Settings → Blocking functions →
Before sign-in** y seleccionar `beforeSignIn`.

Si la consola no ofrece el selector, se puede registrar por REST:

```bash
TOKEN=$(gcloud auth print-access-token)
curl -sS -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/biohipnosis-poc-2026/config?updateMask=blockingFunctions" \
  -d '{"blockingFunctions":{"triggers":{"beforeSignIn":{"functionUri":"https://us-central1-biohipnosis-poc-2026.cloudfunctions.net/beforeSignIn"}}}}'
```

Y dar permiso al service agent de Identity Toolkit para invocarla:

```bash
gcloud run services add-iam-policy-binding beforesignin \
  --project biohipnosis-poc-2026 \
  --region us-central1 \
  --member serviceAccount:service-318941383848@gcp-sa-identitytoolkit.iam.gserviceaccount.com \
  --role roles/run.invoker
```

El nombre exacto del servicio de Cloud Run puede variar; verifícalo con
`gcloud run services list`. Si algo falla, desactivar la función bloqueante no
abre la API: la allowlist del servidor sigue vigente.

## 5. Verificación posterior

```bash
curl -s https://biohipnosis-poc-2026.web.app/api/health | head
# authMode debe ser "on"

curl -s -o /dev/null -w '%{http_code}\n' https://biohipnosis-poc-2026.web.app/api/admin/sessions
# 401 sin token
```

En el navegador:

1. Abrir `https://biohipnosis-poc-2026.web.app`.
2. Entrar con una cuenta de la allowlist.
3. Crear una entrevista y enviar un mensaje; recargar y comprobar que persiste.
4. Cerrar sesión y entrar con una cuenta NO autorizada: debe quedar bloqueada.
5. Con la cuenta dueña, abrir **Consola → Clave** y probar la clave actual.
6. Como tester, pulsar **Solicitar renovación** cuando la clave falle.

## 6. Rotación de la clave de OpenCode

La clave actual fue copiada de la sesión local y **debe rotarse** antes de
entregar la POC.

1. En [OpenCode Console](https://opencode.ai/auth) crear una clave nueva con
   expiración (7/30 días o la necesaria). La clave se muestra una sola vez.
2. Entrar a la POC con la cuenta dueña.
3. **Consola → Clave** → pegar la clave → opcionalmente fecha de expiración →
   **Validar y guardar**.
4. El servidor valida la clave contra `GET /inference/v1/models`, agrega una
   versión nueva a `OPENCODE_API_KEY`, deshabilita la anterior y registra
   `key.rotated` en la auditoría.
5. Revocar la clave anterior en OpenCode Console.

La rotación automática por service account no está soportada oficialmente por
OpenCode (solo Claves de servicio con permiso sobre sus propias claves y un
endpoint no documentado), por eso el flujo es manual y auditado. El aviso por
correo al dueño se dispara desde la UI y tiene límites de 1 solicitud por
usuario cada 6 h y 1 global por hora.

## 7. Agregar o quitar testers

```bash
npm run allowlist -- persona3@gmail.com
# y actualizar POC_ALLOWED_EMAILS si se usa esa vía:
gcloud run services update biohipnosis-api \
  --project biohipnosis-poc-2026 --region us-central1 \
  --update-env-vars POC_ALLOWED_EMAILS=persona1@gmail.com,persona3@gmail.com
```

`POC_ADMIN_EMAILS` nunca debe incluir a los testers.

## 8. Solución de problemas

| Síntoma | Causa probable |
| --- | --- |
| `auth/unauthorized-domain` | Dominio no listado en Authentication → Settings |
| La web carga pero `/api/*` da 404 | Falta el rewrite en `firebase.json` o el servicio no se llama `biohipnosis-api` en `us-central1` |
| `503 key_missing` | El secreto `OPENCODE_API_KEY` no existe o la SA no tiene acceso |
| `401 key_invalid` | Clave revocada/expirada; rotar desde la consola |
| Datos que no persisten tras reiniciar | Revisar logs de Cloud Run; `POC_STORE` debe ser `cloud` |
| Dos usuarios ven lo mismo | Se desplegó con más de una instancia o `POC_STORE=fs` |
| El correo de renovación no llega | Falta `RESEND_API_KEY`, dominio no verificado o cooldown activo |

Logs:

```bash
gcloud run services logs read biohipnosis-api --project biohipnosis-poc-2026 --region us-central1 --limit 100
```

## 9. Costos esperados

Con dos testers y tráfico bajo: Cloud Run escala a cero, Firestore y GCS quedan
en el nivel gratuito o céntimos, Secret Manager cobra por versión activa y
Resend tiene nivel gratuito. Rango realista: **USD 0–5/mes**, más el plan Go de
OpenCode. Requiere plan Blaze en Firebase.
