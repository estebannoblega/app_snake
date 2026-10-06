# CI/CD de Snake (SPEC-004)

Cada `push` a `main` ejecuta tests en un runner hospedado por GitHub y, si
pasan, despliega automáticamente con un **runner self-hosted instalado en el
propio VPS** (`vps-production`). No hay conexiones entrantes desde GitHub hacia
el VPS: el runner mantiene su propia conexión saliente con GitHub Actions y
recibe el job por ese canal.

```text
Developer ── git push origin main ──► GitHub
                                         │
                       ┌─────────────────┴──────────────────┐
                       ▼                                    ▼
        job "Tests y validación"               job "Deploy a VPS"
        runs-on: ubuntu-latest                 runs-on: [self-hosted, production]
        (GitHub-hosted)                        (solo main, nunca pull requests)
          ├── tests unitarios (node:test)                   │
          ├── shellcheck de scripts/deploy.sh               ▼
          ├── docker compose config + build      runner vps-production (en el VPS)
          └── smoke test: healthy en proxy-net,  usuario github-runner, /opt/github-runner
              sin puertos publicados                        │
                                                            │ ejecución local:
                                                            │ sudo -n -H -u deploy
                                                            │ (regla sudoers limitada
                                                            │ a deploy.sh)
                                                            ▼
                                     /opt/apps/app_snake/scripts/deploy.sh <sha>
                                        ├── git fetch + checkout del commit exacto
                                        ├── docker compose build
                                        ├── docker compose up -d
                                        └── verifica: running, healthy, proxy-net,
                                            alias snake-cicd, sin puertos, HTTP y versión
                                                            │
                                                            ▼
                                     contenedor snake-cicd-snake-1 ── proxy-net ──►
                                     reverse-proxy-prod ──► https://snake.enoblega.com.ar/
                                                            │
                                                            ▼
                                     Verificación de la URL pública (versión servida =
                                     versión del commit)
```

El job de deploy se ejecuta **localmente en el VPS**, sin SSH. Para separar
usuarios, el runner (`github-runner`) no ejecuta Docker ni escribe en el
repositorio: invoca `deploy.sh` como usuario `deploy` con `sudo`, mediante una
regla sudoers que solo le permite ejecutar ese script como `deploy` (nunca root).

> **Diseño descartado:** la primera versión de SPEC-004 conectaba un runner
> hospedado por GitHub (`ubuntu-latest`) por SSH entrante hacia el VPS. No pudo
> usarse por el firewall del VPS (IPs dinámicas de GitHub) y fue reemplazado
> por el runner self-hosted. Una versión intermedia ejecutaba el job en el runner
> self-hosted pero seguía haciendo SSH hacia el propio VPS; también fue eliminada.

El pipeline **no** toca el reverse proxy, `/opt/webserver`, Nginx del host,
certificados, DNS ni la red `proxy-net`.

---

## 1. Archivos

| Archivo                       | Función                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `.github/workflows/ci-cd.yml` | Workflow: tests (GitHub-hosted) → deploy (self-hosted) → verificación pública |
| `scripts/deploy.sh`           | Se ejecuta en el VPS como `deploy`: actualiza código, build, up y healthcheck |
| `docker-compose.yml`          | Sin cambios de comportamiento: `snake`, `snake-cicd:latest`, `proxy-net`, sin puertos |

### Cuándo corre cada job

| Evento                                    | Tests (`ubuntu-latest`) | Deploy (`vps-production`) |
| ----------------------------------------- | :---: | :----: |
| `push` a `main`                           |  ✅   |   ✅   |
| Pull request hacia `main`                 |  ✅   |   ❌   |
| Push a otras ramas                        |  ❌   |   ❌   |
| Ejecución manual (Run workflow) en `main` |  ✅   |   ✅   |

El código de un pull request **nunca** se ejecuta en el runner del VPS: el job
de tests corre en infraestructura de GitHub y el de deploy está condicionado a
`github.ref == 'refs/heads/main' && github.event_name != 'pull_request'`.

Los deploys no corren en paralelo (`concurrency: deploy-production`): si llegan
varios pushes seguidos, se ejecutan en orden y los pendientes intermedios se
descartan en favor del más reciente.

### Runner self-hosted

| Elemento          | Valor                                                              |
| ----------------- | ------------------------------------------------------------------ |
| Nombre            | `vps-production`                                                   |
| Labels            | `self-hosted`, `Linux`, `X64`, `production`                        |
| Usuario           | `github-runner` (no root)                                          |
| Directorio        | `/opt/github-runner`                                               |
| Servicio systemd  | `actions.runner.estebannoblega-app_snake.vps-production.service` (enabled) |

Estado esperado: servicio `active (running)` en el VPS y runner `Idle`
(online) en *GitHub → Settings → Actions → Runners* cuando no ejecuta un job.

```bash
systemctl status actions.runner.estebannoblega-app_snake.vps-production.service
```

---

## 2. Credenciales y permisos: resumen

El deploy no usa claves SSH ni secrets: el runner ya está en el VPS.

| # | Elemento | Dónde se configura |
|---|----------|--------------------|
| 1 | Regla sudoers `github-runner` → `deploy` (solo `deploy.sh`) | VPS: `/etc/sudoers.d/github-runner-snake` |
| 2 | Registro del runner `vps-production` en el repositorio | VPS: `/opt/github-runner` (servicio systemd) |
| 3 | Environment `production` limitado a la rama `main` | GitHub → Settings → Environments |
| 4 | URL pública (`PUBLIC_URL`), opcional | Variable del environment, solo si no es `https://snake.enoblega.com.ar` |
| 5 | Acceso del VPS a GitHub | El repositorio del VPS usa el remote HTTPS `https://github.com/estebannoblega/app_snake.git` |

**No se necesitan**: secrets de GitHub, claves SSH, tokens personales (PAT),
contraseñas ni acceso `root`. El workflow usa solo el `GITHUB_TOKEN` automático
con permiso de lectura.

> **#5**: con un remote HTTPS sin credenciales, `git fetch` requiere que el
> repositorio sea accesible públicamente. Si el repositorio pasa a ser privado,
> usar la deploy key de solo lectura descripta en [DEPLOY.md](DEPLOY.md) §3.

---

## 3. Configuración paso a paso

### 3.1 Verificar el usuario `deploy` en la VPS

```bash
id deploy                    # debe existir y pertenecer al grupo docker
sudo passwd -S deploy        # segundo campo "L" o "NP": sin contraseña utilizable
sudo -l -U deploy            # debe indicar que no puede ejecutar sudo
```

Si `deploy` tuviera contraseña, bloquearla: `sudo passwd -l deploy`.

El usuario `deploy` **no necesita `sudo`**: administra Docker por pertenecer al
grupo `docker`. Ver la sección 5 sobre lo que implica.

### 3.2 Verificar el repositorio en la VPS

Como `deploy`:

```bash
cd /opt/apps/app_snake
git remote -v                          # https://github.com/estebannoblega/app_snake.git
git status                             # sin cambios locales
stat -c '%U:%G' /opt/apps/app_snake    # deploy:deploy
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

El workflow ejecuta `/opt/apps/app_snake/scripts/deploy.sh`, así que el script
tiene que existir en la VPS antes del primer deploy automático. En la VPS como
`deploy`:

```bash
cd /opt/apps/app_snake
git pull --ff-only
./scripts/deploy.sh "$(git rev-parse HEAD)"
```

Debe terminar con `DEPLOYMENT OK`. A partir de acá el script se actualiza solo
con cada deploy.

### 3.4 Regla sudoers para el runner (credencial #1)

En la VPS, como administrador:

```bash
sudo tee /etc/sudoers.d/github-runner-snake >/dev/null <<'SUDOERS'
# Permite al runner de GitHub Actions ejecutar solo el deploy de Snake como deploy
github-runner ALL=(deploy) NOPASSWD: /opt/apps/app_snake/scripts/deploy.sh
SUDOERS
sudo chmod 440 /etc/sudoers.d/github-runner-snake
sudo visudo -cf /etc/sudoers.d/github-runner-snake    # debe responder "parsed OK"
```

La regla permite a `github-runner` ejecutar **únicamente** ese script, **solo**
como `deploy` y sin contraseña. No otorga shell como `deploy` ni acceso a `root`.

`github-runner` **no** necesita pertenecer al grupo `docker` ni tener permisos
de escritura sobre `/opt/apps/app_snake`.

### 3.5 Verificar la regla

```bash
sudo -l -U github-runner
# Debe listar: (deploy) NOPASSWD: /opt/apps/app_snake/scripts/deploy.sh

SHA="$(sudo -u deploy git -C /opt/apps/app_snake rev-parse HEAD)"
sudo -u github-runner bash -c "cd / && sudo -n -H -u deploy /opt/apps/app_snake/scripts/deploy.sh $SHA"
# Debe terminar con DEPLOYMENT OK

sudo -u github-runner sudo -n -u deploy /bin/bash -c id
# Debe fallar con "sudo: a password is required"
```

Si el último comando funciona, la regla es demasiado amplia: revisarla antes de continuar.

### 3.6 Configurar el environment en GitHub

En **GitHub → repositorio → Settings → Environments → `production`**:

1. **Deployment branches and tags** → *Selected branches and tags* → agregar `main`.
2. **Environment variables** (solo si hace falta): `PUBLIC_URL` (por defecto `https://snake.enoblega.com.ar`).
3. Opcional: *Required reviewers* si querés aprobar cada deploy manualmente.

### 3.7 Limpieza del diseño anterior basado en SSH

Si quedaron configurados del diseño anterior, ya no se usan y conviene eliminarlos:

- Secrets `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS`, `VPS_HOST` y variable `VPS_PORT` del environment `production`.
- La línea de la clave de CI (`restrict,command="/opt/apps/app_snake/scripts/deploy.sh" ...`) en `~deploy/.ssh/authorized_keys`.
- Restos en `~github-runner/.ssh/` (`deploy_key` y las entradas que el workflow anterior escribió en `known_hosts`).

### 3.8 Proteger `main` (recomendado)

Como todo lo que llega a `main` se despliega, en **Settings → Branches →
Add branch ruleset** para `main`:

- Requerir pull request antes de mergear.
- Requerir que pase el check **Tests y validación**.
- Bloquear force pushes.

### 3.9 Primer deploy automático

Hacer un cambio visible (por ejemplo `APP_VERSION` en `src/game.js`), commit y
`git push origin main`. En la pestaña **Actions** del repositorio:

- Job **Tests y validación** en verde.
- Job **Deploy a VPS** (ejecutado por `vps-production`) termina con
  `DEPLOYMENT OK: <commit>` y el paso *Verificar URL pública* muestra la nueva versión.

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
| El job de deploy queda en *Waiting for a runner to pick up this job* | El runner `vps-production` está offline. Revisar el servicio systemd (sección 1, *Runner self-hosted*). |
| `sudo: a password is required` | Falta la regla sudoers o no coincide con la ruta del script (3.4, 3.5). |
| `sudo: ... /opt/apps/app_snake/scripts/deploy.sh: command not found` | Falta el pull inicial en la VPS (3.3). |
| `detected dubious ownership in repository` | El script se ejecutó como `github-runner` en lugar de `deploy`: revisar que el paso use `sudo -n -H -u deploy`. |
| `la red 'proxy-net' no existe` | La infraestructura del reverse proxy no está levantada. El pipeline no la crea. |
| `hay cambios locales en /opt/apps/app_snake` | Alguien editó archivos en la VPS. Revisar con `git status`; el script no descarta cambios. |
| `el commit ... no pertenece a origin/main` | Se intentó desplegar un commit fuera de `main`. |
| `health check: unhealthy` | La nueva versión no responde. Ver logs del job; hacer rollback. |
| `docker compose no está disponible para el usuario deploy` | `deploy` no está en el grupo `docker` o falta Compose v2. |
| Falla solo *Verificar URL pública* | El contenedor quedó bien, pero el dominio no sirve la versión nueva: revisar reverse proxy/DNS (fuera del pipeline). |

### Revocar el acceso del runner al deploy

Borrar `/etc/sudoers.d/github-runner-snake`. Para detener por completo los
deploys automáticos, detener el servicio del runner o quitarlo en *Settings → Actions → Runners*.

---

## 5. Seguridad y mínimo privilegio

- El runner self-hosted corre como `github-runner` (no root) y solo ejecuta el
  job de deploy, que está limitado a `main` y nunca a pull requests. El código
  de los pull requests se valida en runners hospedados por GitHub.
- `github-runner` y `deploy` son usuarios distintos. `github-runner` no está en
  el grupo `docker` ni puede escribir en `/opt/apps/app_snake`: solo puede
  ejecutar `deploy.sh` como `deploy` mediante la regla sudoers.
- `deploy` no usa `sudo` y no tiene contraseña.
- No hay secrets ni claves SSH en GitHub para el deploy, y no hay conexiones
  entrantes desde GitHub hacia el VPS.
- El workflow corre con `permissions: contents: read` y no imprime secretos en los logs.
- El script solo despliega commits que pertenecen a `origin/main`, valida el
  SHA (40 caracteres hexadecimales), no descarta cambios locales y no crea ni
  modifica `proxy-net`.
- **Limitación conocida:** pertenecer al grupo `docker` equivale en la práctica
  a privilegios de administrador sobre el host. Como `deploy.sh` se actualiza
  desde `main`, quien pueda escribir en `main` puede ejecutar código como
  `deploy` en el VPS. Por eso se recomienda proteger `main` (3.8). Una
  alternativa más estricta (Docker rootless o un wrapper root-owned) queda para
  una SPEC futura.
