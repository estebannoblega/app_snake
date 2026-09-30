# Deployment manual en VPS (SPEC-003)

Procedimiento manual para desplegar, actualizar y hacer rollback de Snake en la VPS.
Es la base que luego se automatizará en SPEC-004 (CI) y SPEC-005 (CD).

> Todos los pasos los ejecuta el administrador en la VPS. Este documento no
> modifica el reverse proxy (`/opt/webserver/`), DNS, HTTPS ni el firewall.

## Resumen

| Elemento               | Valor                                        |
| ---------------------- | -------------------------------------------- |
| Directorio             | `/opt/apps/snake-cicd/`                      |
| Repositorio            | `git@github.com:estebannoblega/app_snake.git` |
| Proyecto Compose       | `snake-cicd`                                 |
| Servicio Compose       | `snake`                                      |
| Imagen                 | `snake-cicd:latest` (se construye en la VPS) |
| Puerto                 | `127.0.0.1:8080` → contenedor `80`           |
| Usuario de deployment  | `deploy` (o el usuario de apps ya existente) |

```text
VPS
 ├── /opt/webserver/            ← reverse proxy existente (NO se toca)
 └── /opt/apps/snake-cicd/      ← este repositorio
        └── docker compose → snake → 127.0.0.1:8080
```

---

## 1. Requisitos previos

En la VPS:

```bash
docker --version
docker compose version   # Compose v2 (subcomando "docker compose")
git --version
```

## 2. Usuario de deployment

La aplicación no se administra como `root`. Si la VPS ya tiene un usuario para
aplicaciones, usarlo y reemplazar `deploy` en los comandos siguientes.

Verificar si existe:

```bash
id deploy
```

Si no existe, crearlo (una sola vez, como administrador):

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
```

> Pertenecer al grupo `docker` permite administrar contenedores, lo que en la
> práctica equivale a privilegios elevados sobre Docker. No agregar el usuario
> a `sudo` ni otorgarle otros permisos: no los necesita.

El resto del procedimiento se ejecuta como ese usuario:

```bash
sudo -iu deploy
```

## 3. Clave SSH para que la VPS lea el repositorio

Se usa una **deploy key** dedicada y de **solo lectura**, distinta de cualquier
clave que en el futuro use GitHub Actions para entrar a la VPS.

Como usuario `deploy`:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github_snake_deploy -C "vps-snake-cicd-deploy-key" -N ""
cat ~/.ssh/github_snake_deploy.pub
```

En GitHub: **repositorio → Settings → Deploy keys → Add deploy key**, pegar la
clave pública, **sin** marcar "Allow write access".

Configurar un alias SSH para usar esa clave solo con este repositorio:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-snake
    HostName github.com
    User git
    IdentityFile ~/.ssh/github_snake_deploy
    IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
```

Probar la conexión:

```bash
ssh -T git@github-snake
```

La primera vez pide confirmar la huella del host. Debe coincidir con la
publicada por GitHub (ED25519: `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`,
ver <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints>).
La respuesta esperada es `Hi estebannoblega/app_snake! You've successfully authenticated...`.

> La clave privada queda solo en `~/.ssh/` de la VPS. Nunca se copia al repositorio.

## 4. Preparar el directorio

Como administrador (una sola vez):

```bash
sudo mkdir -p /opt/apps/snake-cicd
sudo chown deploy:deploy /opt/apps/snake-cicd
```

Como `deploy`, clonar el repositorio dentro del directorio:

```bash
git clone git@github-snake:estebannoblega/app_snake.git /opt/apps/snake-cicd
cd /opt/apps/snake-cicd
git log -1 --oneline
```

## 5. Verificar que el puerto esté libre

```bash
ss -ltn | grep ':8080 ' || echo "8080 libre"
docker ps --format '{{.Names}}\t{{.Ports}}' | grep 8080 || echo "ningún contenedor usa 8080"
```

Si el puerto está ocupado **no continuar**: no cambiar el puerto ni detener el
otro servicio. Informar el conflicto y decidir antes de seguir.

## 6. Primer deployment

```bash
cd /opt/apps/snake-cicd
docker compose build
docker compose up -d
```

## 7. Verificación

El deployment se considera exitoso solo si el contenedor está **healthy**
(no alcanza con `running`).

```bash
docker compose ps
```

Esperado: `Up ... (healthy)` y en `PORTS` únicamente `127.0.0.1:8080->80/tcp`.
Durante los primeros segundos puede verse `(health: starting)`.

Estado de salud directo:

```bash
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q snake)"
```

Logs (no deben aparecer líneas `emerg`, `alert`, `crit` ni `error`):

```bash
docker compose logs
docker compose logs | grep -Eai 'emerg|alert|crit|error' || echo "sin errores"
```

HTTP desde la VPS:

```bash
curl -i http://127.0.0.1:8080
```

Esperado: `HTTP/1.1 200 OK` y el HTML de Snake.

Versión desplegada:

```bash
curl -s http://127.0.0.1:8080/game.js | grep 'const APP_VERSION'
```

Comprobar que **no** está expuesto hacia afuera (desde otra máquina, con la IP
pública de la VPS): `curl http://<IP_VPS>:8080` debe fallar.

### Verificación funcional en navegador

Como el servicio solo escucha en `127.0.0.1`, para probarlo desde tu PC antes de
publicarlo en el reverse proxy se puede usar un túnel SSH:

```bash
# En tu PC
ssh -L 8080:127.0.0.1:8080 <usuario>@<IP_VPS>
```

Y abrir <http://localhost:8080>. Verificar: carga de la interfaz, movimiento,
controles (flechas y WASD), comida, score, Game Over, RESTART, High Score y el
texto `Version X.Y.Z` en el pie.

> Si en tu PC el puerto 8080 está ocupado (por ejemplo, por el contenedor local),
> usar otro puerto local: `ssh -L 9080:127.0.0.1:8080 ...` y abrir `localhost:9080`.

## 8. Actualización manual

Flujo: `git push` (desarrollo) → GitHub → VPS (`git pull` + build + up).

En la máquina de desarrollo, antes de desplegar, subir la versión en
`src/game.js` (`APP_VERSION`) para poder confirmar visualmente el deployment,
hacer commit y `git push`.

En la VPS:

```bash
cd /opt/apps/snake-cicd

# Anotar el commit actual: es el punto de retorno si hay que hacer rollback.
git log -1 --oneline

git pull --ff-only
docker compose build
docker compose up -d

docker compose ps
curl -s http://127.0.0.1:8080/game.js | grep 'const APP_VERSION'
```

Esperado: `(healthy)` y la nueva versión. Si `git pull --ff-only` falla es porque
hay cambios locales en la VPS o la historia divergió: no forzar, revisar con
`git status` antes de continuar.

## 9. Rollback manual

Se vuelve a un commit anterior con Git y se reconstruye la imagen desde ese código.

```bash
cd /opt/apps/snake-cicd

# 1. Identificar el commit al que se quiere volver.
git log --oneline -n 10

# 2. Posicionarse en ese commit (queda en "detached HEAD", es lo esperado).
git checkout <commit>

# 3. Reconstruir y reiniciar.
docker compose build
docker compose up -d

# 4. Verificar salud, HTTP y versión.
docker compose ps
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080
curl -s http://127.0.0.1:8080/game.js | grep 'const APP_VERSION'
```

Mientras la VPS esté en un commit de rollback **no ejecutar `git pull`**.

Para salir del rollback, corregir el problema en desarrollo (por ejemplo con
`git revert <commit_defectuoso>` y `git push`, sin reescribir la historia de
`main`) y en la VPS volver a la rama:

```bash
git checkout main
git pull --ff-only
docker compose build
docker compose up -d
docker compose ps
```

> Recomendación: etiquetar cada versión desplegada (`git tag v1.0.0 && git push --tags`
> desde desarrollo) para poder hacer rollback con `git checkout v1.0.0`.

## 10. Operación

Siempre desde `/opt/apps/snake-cicd`:

| Acción           | Comando                  |
| ---------------- | ------------------------ |
| Consultar estado | `docker compose ps`      |
| Consultar logs   | `docker compose logs`    |
| Logs en vivo     | `docker compose logs -f` |
| Reiniciar        | `docker compose restart` |
| Detener          | `docker compose down`    |
| Iniciar          | `docker compose up -d`   |
| Reconstruir      | `docker compose build`   |

El contenedor usa `restart: unless-stopped`: vuelve a iniciar solo tras un
reinicio de la VPS, salvo que se haya detenido con `docker compose down`.

## 11. Publicación mediante el reverse proxy (manual, fuera de alcance)

La publicación la hace el administrador modificando manualmente el reverse
proxy existente para que apunte a `127.0.0.1:8080`. Nada de este repositorio
modifica `/opt/webserver/`.

> **Importante:** `127.0.0.1:8080` es alcanzable por un reverse proxy que corre
> **directamente en el host**. Si el reverse proxy corre **dentro de un contenedor**
> (con red bridge), para él `127.0.0.1` es su propio contenedor y no llegará a
> Snake. En ese caso habrá que definir, en una etapa posterior, cómo se conectan
> (por ejemplo, una red Docker compartida) sin cambiar lo definido en esta SPEC.
