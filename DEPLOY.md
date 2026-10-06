# Deployment manual en VPS (SPEC-003)

Procedimiento manual para preparar la VPS, desplegar, actualizar y hacer rollback de Snake.

> Desde SPEC-004 los deploys a `main` son automáticos mediante GitHub Actions,
> ejecutados por el runner self-hosted `vps-production` instalado en el propio VPS
> (ver [CICD.md](CICD.md)). Este documento sirve para la preparación inicial de la
> VPS, para operar a mano en caso de emergencia y como referencia de lo que
> automatiza `scripts/deploy.sh`.

> Todos los pasos los ejecuta el administrador en la VPS. Este documento no
> modifica el reverse proxy (`/opt/webserver/`), DNS, HTTPS ni el firewall.

## Resumen

| Elemento               | Valor                                        |
| ---------------------- | -------------------------------------------- |
| Directorio             | `/opt/apps/app_snake/`                      |
| Repositorio            | `https://github.com/estebannoblega/app_snake.git` |
| Proyecto Compose       | `snake-cicd`                                 |
| Servicio Compose       | `snake`                                      |
| Imagen                 | `snake-cicd:latest` (se construye en la VPS) |
| Red                    | `proxy-net` (externa, ya existente)          |
| Nombre en la red       | `snake-cicd` → `http://snake-cicd:80`        |
| Puertos en el host     | Ninguno                                      |
| Usuario de deployment  | `deploy` (dueño de `/opt/apps/app_snake`, grupo `docker`) |

```text
VPS
 ├── /opt/webserver/            ← reverse proxy existente (NO se toca)
 │        │
 │        │  red Docker proxy-net
 │        ▼
 └── /opt/apps/app_snake/      ← este repositorio
        └── docker compose → snake (alias snake-cicd, puerto interno 80)
```

Para no repetir el comando en las verificaciones, se usa un contenedor temporal
conectado a `proxy-net` que simula al reverse proxy (se elimina solo con `--rm`):

```bash
alias snake-get='docker run --rm --network proxy-net nginx:1.31-alpine wget -qO-'
```

Definirlo en la sesión antes de verificar (o reemplazar `snake-get` por el comando completo).

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

## 3. Acceso de la VPS al repositorio

El repositorio del VPS usa el remote HTTPS
`https://github.com/estebannoblega/app_snake.git`, que no requiere credenciales
mientras el repositorio sea accesible públicamente.

Si el repositorio pasa a ser **privado**, usar una **deploy key** dedicada y de
**solo lectura**. Como usuario `deploy`:

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

Y cambiar el remote del repositorio para usar ese alias:
`git -C /opt/apps/app_snake remote set-url origin git@github-snake:estebannoblega/app_snake.git`.

> La clave privada queda solo en `~/.ssh/` de la VPS. Nunca se copia al repositorio.

## 4. Preparar el directorio

Como administrador (una sola vez):

```bash
sudo mkdir -p /opt/apps/app_snake
sudo chown deploy:deploy /opt/apps/app_snake
```

Como `deploy`, clonar el repositorio dentro del directorio:

```bash
git clone https://github.com/estebannoblega/app_snake.git /opt/apps/app_snake
cd /opt/apps/app_snake
git log -1 --oneline
```

## 5. Verificar la red `proxy-net`

La red pertenece a la infraestructura del reverse proxy. Debe existir y **no se
crea desde este proyecto**:

```bash
docker network inspect proxy-net --format '{{.Name}} ({{.Driver}})'
```

Esperado: `proxy-net (bridge)`. Si responde `network proxy-net not found`,
**no continuar** y no crearla: informar y resolverlo del lado de la infraestructura.

Verificar que ningún otro contenedor de la red use el nombre `snake-cicd`:

```bash
for c in $(docker network inspect proxy-net --format '{{range .Containers}}{{.Name}} {{end}}'); do
  docker inspect --format '{{.Name}} {{(index .NetworkSettings.Networks "proxy-net").Aliases}}' "$c"
done | grep -w snake-cicd || echo "snake-cicd libre"
```

Si el nombre está en uso **no continuar**: no renombrar ni tocar el otro
contenedor. Informar el conflicto y decidir antes de seguir.

## 6. Primer deployment

```bash
cd /opt/apps/app_snake
docker compose build
docker compose up -d
```

## 7. Verificación

El deployment se considera exitoso solo si el contenedor está **healthy**
(no alcanza con `running`).

```bash
docker compose ps
```

Esperado: `Up ... (healthy)` y en `PORTS` solo `80/tcp` (puerto interno, sin
`->`: no hay nada publicado en el host). Durante los primeros segundos puede
verse `(health: starting)`.

Estado de salud directo:

```bash
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q snake)"
```

Logs (no deben aparecer líneas `emerg`, `alert`, `crit` ni `error`):

```bash
docker compose logs
docker compose logs | grep -Eai 'emerg|alert|crit|error' || echo "sin errores"
```

Conexión a la red (debe listar `proxy-net` y el alias `snake-cicd`):

```bash
docker inspect --format '{{range $n, $c := .NetworkSettings.Networks}}{{$n}} {{$c.Aliases}}{{"\n"}}{{end}}' "$(docker compose ps -q snake)"
```

HTTP desde `proxy-net` (como lo verá el reverse proxy):

```bash
snake-get http://snake-cicd/
```

Esperado: el HTML de Snake. Sin HTML, o un error `bad address`/`Connection refused`,
indica que el contenedor no está en la red o no está levantado.

Versión desplegada:

```bash
snake-get http://snake-cicd/game.js | grep 'const APP_VERSION'
```

### Verificación funcional en navegador

Como no hay puertos publicados, para probarlo desde tu PC antes de publicarlo en
el reverse proxy se puede usar un túnel SSH hacia la IP del contenedor en `proxy-net`.

En la VPS, obtener la IP (cambia si el contenedor se recrea):

```bash
docker inspect --format '{{(index .NetworkSettings.Networks "proxy-net").IPAddress}}' "$(docker compose ps -q snake)"
```

En tu PC:

```bash
ssh -L 8080:<IP_CONTENEDOR>:80 <usuario>@<IP_VPS>
```

Y abrir <http://localhost:8080>. Verificar: carga de la interfaz, movimiento,
controles (flechas y WASD), comida, score, Game Over, RESTART, High Score y el
texto `Version X.Y.Z` en el pie.

> Si en tu PC el puerto 8080 está ocupado (por ejemplo, por el contenedor local),
> usar otro puerto local: `ssh -L 9080:<IP_CONTENEDOR>:80 ...` y abrir `localhost:9080`.

## 8. Actualización manual

Flujo: `git push` (desarrollo) → GitHub → VPS (`git pull` + build + up).

En la máquina de desarrollo, antes de desplegar, subir la versión en
`src/game.js` (`APP_VERSION`) para poder confirmar visualmente el deployment,
hacer commit y `git push`.

En la VPS:

```bash
cd /opt/apps/app_snake

# Anotar el commit actual: es el punto de retorno si hay que hacer rollback.
git log -1 --oneline

git pull --ff-only
docker compose build
docker compose up -d

docker compose ps
snake-get http://snake-cicd/game.js | grep 'const APP_VERSION'
```

Esperado: `(healthy)` y la nueva versión. Si `git pull --ff-only` falla es porque
hay cambios locales en la VPS o la historia divergió: no forzar, revisar con
`git status` antes de continuar.

## 9. Rollback manual

Se vuelve a un commit anterior con Git y se reconstruye la imagen desde ese código.

```bash
cd /opt/apps/app_snake

# 1. Identificar el commit al que se quiere volver.
git log --oneline -n 10

# 2. Posicionarse en ese commit (queda en "detached HEAD", es lo esperado).
git checkout <commit>

# 3. Reconstruir y reiniciar.
docker compose build
docker compose up -d

# 4. Verificar salud, HTTP y versión.
docker compose ps
snake-get http://snake-cicd/game.js | grep 'const APP_VERSION'
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

Siempre desde `/opt/apps/app_snake`:

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
proxy existente. Nada de este repositorio modifica `/opt/webserver/`.

Estado actual: el reverse proxy corre en el contenedor `reverse-proxy-prod`
(`/opt/webserver`), conectado a `proxy-net`, y publica Snake en
<https://snake.enoblega.com.ar/>. Su configuración, DNS y certificados se
administran fuera de este repositorio.

El reverse proxy debe estar conectado a `proxy-net` y apuntar a:

```text
http://snake-cicd:80
```

Ejemplo orientativo para un reverse proxy Nginx en contenedor:

```nginx
location / {
    # DNS interno de Docker: resuelve el nombre en cada request, así el proxy
    # arranca aunque Snake esté detenido y sigue funcionando si se recrea.
    resolver 127.0.0.11 valid=10s;
    set $snake_upstream http://snake-cicd:80;
    proxy_pass $snake_upstream;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

> Con `proxy_pass http://snake-cicd:80;` directo (sin `resolver`/variable),
> Nginx resuelve el nombre solo al arrancar: si Snake no está levantado en ese
> momento, el reverse proxy no inicia (`host not found in upstream`).
