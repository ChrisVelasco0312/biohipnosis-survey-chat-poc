# e2e visuales · Biohipnosis POC

Pruebas end-to-end con **Playwright** pensadas para **mirar** cómo se usa la
aplicación: abren una ventana real de Chromium, escriben a ritmo humano y hacen
pausas deliberadas entre pasos. No son pruebas de CI a máxima velocidad (para
eso existe `pnpm test:headless`).

Se basan en la configuración de NixOS de
`Atix/caem/caem-embargos-react/playwright-web-scan`: shell de Nix con Node,
pnpm y Chromium *patchelf'd*, y `workers: 1` porque el recorrido es stateful.

---

## Arranque en NixOS

```bash
cd biohipnosis-survey-chat-poc/e2e
nix develop                 # exporta CHROMIUM_EXECUTABLE_PATH y salta la descarga de browsers
pnpm install
pnpm test                   # ventana visible, recorrido completo
```

La primera vez Nix descarga/compila el shell y pnpm instala
`@playwright/test`. No se descargan navegadores de Playwright: se usa el
Chromium del shell de Nix.

### Solo una parte de la demo

```bash
pnpm test:entrevista        # entrevista: edad, consentimiento, sección A, pausa y reanudación
pnpm test:consola           # inspector: PII, respuestas, eventos, suite, costos, exportar
pnpm test:laboratorio       # laboratorio: inyección, diagnóstico, voz, crisis, suite, auditoría, costos
pnpm test:borde             # casos borde: spam, mensajes sin sentido, pedidos de claridad
```

### Ajustar el ritmo

| Variable | Default | Efecto |
|---|---|---|
| `E2E_HEADLESS=1` | ventana visible | Ejecuta sin ventana (CI) |
| `E2E_SLOWMO` | `180` | ms que Playwright espera tras cada acción de bajo nivel |
| `E2E_TYPE_DELAY` | `45` | ms entre teclas al escribir |
| `E2E_PACE=fast` | ritmo normal | Multiplica por 0.3 todas las pausas deliberadas |
| `E2E_LLM=opencode` | `off` | Usa el modelo real en vez del motor heurístico |
| `E2E_PORT` | `3310` | Puerto del servidor de pruebas |
| `E2E_DATA_DIR` | `.data/` | Datos cifrados de la corrida |

Ejemplos:

```bash
E2E_LLM=opencode pnpm test          # respuestas del modelo real (más lentas)
E2E_PACE=fast pnpm test             # misma demo, en menos tiempo
E2E_HEADLESS=1 pnpm test            # sin ventana
```

---

## Qué hace el suite

Cada corrida empieza con datos limpios (`scripts/reset-data.mjs` borra
`.data/`), levanta el servidor en `127.0.0.1:3310` con `POC_LLM=off` y
`POC_RATE_LIMIT=off`, y guarda capturas en `artifacts/`.

1. **`01-entrevista.spec.ts`** — inicio, tema claro/oscuro, creación de la
   conversación, verificación 18+, consentimiento, las 10 preguntas de la
   sección A (incluidas las confirmaciones de ítems críticos), resumen de
   sección, motivo de consulta, pausa desde el menú y reanudación.
2. **`02-consola-profesional.spec.ts`** — token `poc-admin`, revelado de PII
   auditado, cuadrícula de respuestas, eventos, suite de seguridad (22
   controles), costos y exportación con correo simulado.
3. **`03-laboratorio.spec.ts`** — inyección de prompt, solicitud de
   diagnóstico, voz con confianza baja, crisis, suite, auditoría y costos.
4. **`04-casos-borde.spec.ts`** — comportamiento del bot ante tres borde, ya con la inteligencia anti-ruido del motor:
   - **Spam**: ráfagas de 'hola'. El bot saluda en contexto (smalltalk no consume intentos), luego advierte "el mismo mensaje varias veces seguidas" y re-pregunta, y al exceder `POC_MAX_SPAM_BURST` pausa la entrevista para revisión profesional (banner amarillo). Con "Continuar" retoma el ítem intacto: una respuesta válida entra limpia y avanza (nada queda como parcial).
   - **Mensajes sin sentido**: aclaraciones específicas ("Ese mensaje no logro interpretarlo…"), registro parcial avisado al agotar los 2 intentos del ítem, detección de teclado/eco/símbolos (`detectNonsense`), y al acumular `POC_MAX_NONSENSE` mensajes sin sentido la entrevista también se pausa para revisión profesional y se reanuda sin perder el ítem.
   - **Pedidos de claridad**: repetir, explicar y ejemplificar sin penalización ni consumo de intentos.
   No busca veredictos: documenta con capturas cómo reacciona el bot en cada caso y que la conversación puede recuperarse después.

Las capturas quedan en `e2e/artifacts/` con nombres como
`08-motivo-de-consulta.png` o `lab-05-crisis.png`, útiles como evidencia
después de la demo.

---

## Estructura

```
e2e/
├── flake.nix               # Node 24 + pnpm + Chromium para NixOS
├── flake.lock
├── playwright.config.ts    # ventana visible, slowMo, webServer, 1 worker
├── scripts/reset-data.mjs  # datos y capturas limpias por corrida
├── tests/
│   ├── helpers.ts          # escritura humana, esperas, login, capturas
│   ├── 01-entrevista.spec.ts
│   ├── 02-consola-profesional.spec.ts
│   ├── 03-laboratorio.spec.ts
│   └── 04-casos-borde.spec.ts
├── .data/                  # efímero (gitignored)
└── artifacts/              # capturas (gitignored)
```

## Notas

- El servidor de pruebas es independiente del `npm start` normal: usa su propio
  puerto y su propio `POC_DATA_DIR`, así que no toca `data/`.
- Si `3310` está ocupado, define `E2E_PORT` con otro puerto.
- No se descargan browsers: en NixOS usa el Chromium del shell vía
  `CHROMIUM_EXECUTABLE_PATH`.
- `pnpm test` abre la ventana; no la cierres durante la corrida o el test
  fallará. Al terminar, Playwright cierra la ventana y el servidor.
