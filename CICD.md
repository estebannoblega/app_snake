# CI/CD de Snake (SPEC-004)

Cada `push` a `main` ejecuta tests en GitHub Actions y, si pasan, despliega
automáticamente en la VPS por SSH con el usuario `deploy`.

```text
git push origin main
        │
        ▼
GitHub Actions ─ job "Tests y validación"
        │          ├── tests unitarios (node:test)
        │          ├── shellcheck de scripts/deploy.sh
        │          ├── docker compose config + build
        │          └── smoke test: contenedor healthy en proxy-net, sin puertos
        │
        │  (solo si todo pasó y el commit es de main)
        ▼
job "Deploy a VPS" ── SSH (clave exclusiva de CI) ──► deploy@VPS
                                                       │ forced command
                                                       ▼
                                   /opt/apps/app_snake/scripts/deploy.sh <sha>
                                       ├── git fetch + checkout del commit exacto
                                       ├── docker compose build
                                       ├── docker compose up -d
                                       └── verifica: running, healthy, proxy-net,
                                           sin puertos, HTTP y versión servida
        │
        ▼
Verificación de https://snake.enoblega.com.ar (versión servida = versión del commit)
```

El pipeline **no** toca el reverse proxy, `/opt/webserver`, Nginx del host,
certificados, DNS ni la red `proxy-net`.

---

## 1. Archivos

| Archivo                       | Función                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `.github/workflows/ci-cd.yml` | Workflow: tests → deploy → verificación pública                  |
| `scripts/deploy.sh`           | Se ejecuta en la VPS: actualiza código, build, up y healthcheck  |
| `docker-compose.yml`          | Sin cambios de comportamiento: `snake`, `snake-cicd:latest`, `proxy-net`, sin puertos |

### Cuándo corre cada job

| Evento                               | Tests | Deploy |
| ------------------------------------ | :---: | :----: |
| `push` a `main`                      |  ✅   |   ✅   |
| Pull request hacia `main`            |  ✅   |   ❌   |
| Push a otras ramas                   |  ❌   |   ❌   |
| Ejecución manual (Run workflow) en `main` |  ✅   |   ✅   |

Los deploys no corren en paralelo (`concurrency: deploy-production`): si llegan
varios pushes seguidos, se ejecutan en orden y los pendientes intermedios se
descartan en favor del más reciente.

---

## 2. Credenciales: resumen

| # | Credencial | Estado | Dónde se crea | Dónde se guarda |
|---|------------|--------|---------------|-----------------|
| 1 | **Clave SSH de CI → VPS** (`VPS_SSH_KEY`) | 🆕 Crear | En tu PC | Privada: secret de GitHub. Pública: `~deploy/.ssh/authorized_keys` en la VPS, restringida |
| 2 | **Huella del servidor SSH** (`VPS_KNOWN_HOSTS`) | 🆕 Crear | `ssh-keyscan` desde tu PC, verificada en la VPS | Secret de GitHub |
| 3 | **Host de la VPS** (`VPS_HOST`) | 🆕 Crear | IP o hostname de la VPS | Secret de GitHub |
| 4 | Puerto SSH (`VPS_PORT`) | Opcional | Solo si no es `22` | Variable de GitHub |
| 5 | URL pública (`PUBLIC_URL`) | Opcional | Solo si no es `https://snake.enoblega.com.ar` | Variable de GitHub |
| 6 | Deploy key VPS → GitHub (SPEC-003) | ✅ Ya existe | — | `~deploy/.ssh/github_snake_deploy` en la VPS + Deploy keys del repo |

Todo va en el **environment `production`** del repositorio
(Settings → Environments → production), no en secrets globales del repo.

**No se necesitan**: tokens personales de GitHub (PAT), contraseñas, acceso
`root`, reglas `sudo`, ni tu clave SSH personal. El workflow usa solo el
`GITHUB_TOKEN` automático con permiso de lectura.

> Son **dos claves SSH distintas** y no deben mezclarse:
> - **#6 (VPS → GitHub)**: la VPS la usa para `git fetch`. Solo lectura del repo. Ya configurada en SPEC-003.
> - **#1 (GitHub Actions → VPS)**: Actions la usa para entrar a la VPS. Solo puede ejecutar `deploy.sh`.

---

## 3. Configuración paso a paso

### 3.1 Verificar el usuario `deploy` en la VPS

```bash
id deploy                    # debe existir y pertenecer al grupo docker
sudo passwd -S deploy        # segundo campo "L" o "NP": sin contraseña utilizable
sudo -l -U deploy            # debe indicar que no puede ejecutar sudo
```

Si `deploy` tuviera contraseña, bloquearla: `sudo passwd -l deploy`.
El acceso por SSH queda solo con clave.

El usuario **no necesita `sudo`**: administra Docker por pertenecer al grupo
`docker`. Ver la sección 5 sobre lo que implica.

### 3.2 Verificar el repositorio en la VPS

Como `deploy`:

```bash
cd /opt/apps/app_snake
git remote -v                          # git@github-snake:estebannoblega/app_snake.git
git status                             # sin cambios locales
docker network inspect proxy-net >/dev/null && echo "proxy-net OK"
```

> Si el proyecto todavía está en `/opt/apps/snake-cicd` (SPEC-003), moverlo:
> ```bash
> cd /opt/apps/snake-cicd && docker compose down
> sudo mv /opt/apps/snake-cicd /opt/apps/app_snake
> cd /opt/apps/app_snake && docker compose up -d
> ```
> El nombre del contenedor no cambia (`snake-cicd-snake-1`) porque el proyecto
> Compose tiene nombre fijo.

### 3.3 Traer `scripts/deploy.sh` a la VPS (una sola vez)

El forced command apunta a `/opt/apps/app_snake/scripts/deploy.sh`, así que el
script tiene que existir en la VPS antes del primer deploy automático. Después
de hacer push de este cambio, en la VPS como `deploy`:

```bash
cd /opt/apps/app_snake
git pull --ff-only
./scripts/deploy.sh "$(git rev-parse HEAD)"
```

Debe terminar con `DEPLOYMENT OK`. A partir de acá el script se actualiza solo
con cada deploy.

### 3.4 Crear la clave SSH de CI (credencial #1)

**En tu PC** (no en la VPS), en un directorio temporal:

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions-snake-ci" -f ./snake_ci_deploy
```

Genera `snake_ci_deploy` (privada) y `snake_ci_deploy.pub` (pública).

### 3.5 Instalar la clave pública en la VPS

Como `deploy` en la VPS, agregar **una línea** a `~/.ssh/authorized_keys`
(reemplazar `AAAA...` por el contenido de `snake_ci_deploy.pub`):

```text
restrict,command="/opt/apps/app_snake/scripts/deploy.sh" ssh-ed25519 AAAA... github-actions-snake-ci
```

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

- `command="..."`: la clave **solo** puede ejecutar `deploy.sh`, sin importar
  qué comando pida el cliente. El SHA enviado se valida (40 caracteres
  hexadecimales) y nunca se ejecuta.
- `restrict`: desactiva shell interactiva, TTY y reenvío de puertos, agente y X11.

Si la clave se filtra, lo único que permite es redesplegar un commit que ya
está en `main`.

### 3.6 Obtener la huella del servidor (credencial #2)

**En tu PC**, usando exactamente el mismo host (y puerto) que irá en `VPS_HOST`:

```bash
ssh-keyscan -t ed25519 -p 22 <VPS_HOST> 2>/dev/null | tee snake_known_hosts
ssh-keygen -lf snake_known_hosts
```

**En la VPS**, comparar con la huella real del servidor:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Las dos huellas `SHA256:...` **deben coincidir**. Si no coinciden, no continuar.
El contenido de `snake_known_hosts` (una línea) es el valor del secret.

> El workflow usa `StrictHostKeyChecking=yes`: si la VPS cambia su clave de host
> (por ejemplo, al reinstalarla), el deploy fallará hasta actualizar este secret.

### 3.7 Probar la clave desde tu PC (opcional, recomendado)

```bash
ssh -i ./snake_ci_deploy -o IdentitiesOnly=yes -p 22 deploy@<VPS_HOST> \
  "/opt/apps/app_snake/scripts/deploy.sh $(git rev-parse origin/main)"
```

Debe mostrar el log del deploy y terminar con `DEPLOYMENT OK`. Probar también
que no da shell: `ssh -i ./snake_ci_deploy deploy@<VPS_HOST> id` debe fallar
con el error de SHA inválido del script.

### 3.8 Cargar secrets y variables en GitHub

En **GitHub → repositorio → Settings → Environments → New environment →
`production`**:

1. **Deployment branches and tags** → *Selected branches and tags* → agregar `main`.
2. **Environment secrets** → *Add environment secret*:

   | Nombre            | Valor                                                  |
   | ----------------- | ------------------------------------------------------ |
   | `VPS_SSH_KEY`     | Contenido completo de `snake_ci_deploy` (privada), incluyendo las líneas `-----BEGIN/END OPENSSH PRIVATE KEY-----` |
   | `VPS_KNOWN_HOSTS` | Contenido de `snake_known_hosts`                       |
   | `VPS_HOST`        | IP o hostname de la VPS (el mismo usado en `ssh-keyscan`) |

3. **Environment variables** (solo si hace falta):

   | Nombre       | Valor por defecto                  |
   | ------------ | ---------------------------------- |
   | `VPS_PORT`   | `22`                               |
   | `PUBLIC_URL` | `https://snake.enoblega.com.ar`    |

4. Opcional: *Required reviewers* si querés aprobar cada deploy manualmente.

Con la CLI `gh` (alternativa):

```bash
gh secret set VPS_SSH_KEY     --env production < snake_ci_deploy
gh secret set VPS_KNOWN_HOSTS --env production < snake_known_hosts
gh secret set VPS_HOST        --env production --body "<VPS_HOST>"
```

### 3.9 Borrar la clave privada de tu PC

Una vez cargada en GitHub no se necesita más (si hay que cambiarla, se genera otra):

```bash
shred -u snake_ci_deploy 2>/dev/null || rm -f snake_ci_deploy
rm -f snake_ci_deploy.pub snake_known_hosts
```

### 3.10 Proteger `main` (recomendado)

Como todo lo que llega a `main` se despliega, en **Settings → Branches →
Add branch ruleset** para `main`:

- Requerir pull request antes de mergear.
- Requerir que pase el check **Tests y validación**.
- Bloquear force pushes.

### 3.11 Primer deploy automático

Hacer un cambio visible (por ejemplo `APP_VERSION` en `src/game.js`), commit y
`git push origin main`. En la pestaña **Actions** del repositorio:

- Job **Tests y validación** en verde.
- Job **Deploy a VPS** termina con `DEPLOYMENT OK: <commit>` y el paso
  *Verificar URL pública* muestra la nueva versión.

---

## 4. Operación

### Leer el resultado

En **Actions → CI/CD → ejecución**:

- `======== DEPLOYMENT OK: <sha> <mensaje> ========` → desplegado y verificado.
- `======== DEPLOYMENT FALLIDO ========` → la línea `[deploy] ERROR:` anterior
  indica la causa. Si falló el health check, a continuación se muestran
  `docker compose ps` y las últimas 50 líneas de log del contenedor.

### Redesplegar

*Actions → CI/CD → Run workflow* (rama `main`), o *Re-run jobs* en una ejecución.

### Rollback

- **Desde GitHub**: abrir una ejecución **anterior y exitosa** → *Re-run jobs*.
  Vuelve a desplegar exactamente ese commit (el script acepta cualquier commit
  que pertenezca a `main`).
- **Desde la VPS** (como `deploy`):
  ```bash
  cd /opt/apps/app_snake
  git log --oneline -n 10 origin/main
  ./scripts/deploy.sh <sha_completo_del_commit_estable>
  ```

El siguiente `push` a `main` vuelve a desplegar la última versión, así que la
corrección definitiva se hace en `main` (por ejemplo con `git revert`).

### Errores frecuentes

| Mensaje | Causa / acción |
| ------- | -------------- |
| `Falta el secret ... en el environment 'production'` | Cargar el secret (3.8). |
| `Host key verification failed` | `VPS_KNOWN_HOSTS` no coincide con `VPS_HOST` o la clave del servidor cambió (3.6). |
| `Permission denied (publickey)` | La clave pública no está en `~deploy/.ssh/authorized_keys` o los permisos de `~/.ssh` son incorrectos (3.5). |
| `bash: /opt/apps/app_snake/scripts/deploy.sh: No such file or directory` | Falta el pull inicial en la VPS (3.3). |
| `la red 'proxy-net' no existe` | La infraestructura del reverse proxy no está levantada. El pipeline no la crea. |
| `hay cambios locales en /opt/apps/app_snake` | Alguien editó archivos en la VPS. Revisar con `git status`; el script no descarta cambios. |
| `el commit ... no pertenece a origin/main` | Se intentó desplegar un commit fuera de `main`. |
| `health check: unhealthy` | La nueva versión no responde. Ver logs del job; hacer rollback. |
| `docker compose no está disponible para el usuario deploy` | `deploy` no está en el grupo `docker` o falta Compose v2. |
| Falla solo *Verificar URL pública* | El contenedor quedó bien, pero el dominio no sirve la versión nueva: revisar reverse proxy/DNS (fuera del pipeline). |

### Rotar o revocar la clave de CI

1. Generar una nueva clave (3.4).
2. Reemplazar la línea en `~deploy/.ssh/authorized_keys` (3.5).
3. Actualizar el secret `VPS_SSH_KEY` (3.8).
4. Borrar la privada local (3.9).

Para **revocar** de inmediato: borrar la línea de `authorized_keys` en la VPS.

---

## 5. Seguridad y mínimo privilegio

- `deploy` no usa `sudo` y no tiene contraseña. Accede solo con claves.
- La clave de CI está restringida a un único comando (`deploy.sh`) con `restrict`.
- El host de la VPS se verifica con `known_hosts` fijo (sin `StrictHostKeyChecking=no`).
- La clave privada vive solo en el secret del environment `production`, que
  está limitado a la rama `main`. Se escribe en el runner con permisos `600`
  y se borra al final del job.
- El workflow corre con `permissions: contents: read` y no usa actions de
  terceros para SSH.
- El script solo despliega commits que pertenecen a `origin/main`, no descarta
  cambios locales y no crea ni modifica `proxy-net`.
- **Limitación conocida:** pertenecer al grupo `docker` equivale en la práctica
  a privilegios de administrador sobre el host. El forced command limita lo que
  puede hacer la clave de CI, pero quien pueda escribir en `main` puede
  desplegar cualquier configuración de Docker. Por eso se recomienda proteger
  `main` (3.10). Una alternativa más estricta (Docker rootless o un usuario
  dedicado sin grupo `docker` con un wrapper root-owned) queda para una SPEC
  futura.
