# Snake

Juego clásico **Snake** hecho con HTML5, CSS3 y JavaScript (ES6+), sin frameworks ni dependencias. Se sirve como archivos estáticos desde cualquier servidor web.

Implementa la especificación `SPEC-001` (versión `1.0.0`).

## Estructura

```text
app_snake/
├── src/
│   ├── index.html   # Estructura de la interfaz
│   ├── style.css    # Estilos (responsive, sin fuentes ni imágenes externas)
│   └── game.js      # Lógica del juego, rendering y persistencia
├── tests/
│   └── game.test.js # Tests de la lógica crítica (node:test)
├── nginx/
│   └── nginx.conf   # Configuración de Nginx para la imagen Docker
├── Dockerfile
├── docker-compose.yml  # Servicio "snake" en la red proxy-net (sin puertos en el host)
├── compose.local.yml   # Override solo para desarrollo local: publica 127.0.0.1:8080
├── .dockerignore
├── scripts/
│   └── deploy.sh    # Deploy en la VPS (lo ejecuta GitHub Actions por SSH)
├── .github/workflows/
│   └── ci-cd.yml    # Pipeline CI/CD: tests → deploy → verificación
├── CICD.md          # CI/CD: funcionamiento, credenciales y operación (SPEC-004)
├── DEPLOY.md        # Preparación y deployment manual en la VPS (SPEC-003)
├── README.md
└── .gitignore
```

## Cómo jugar

- Mover: flechas `↑ ↓ ← →` o `W A S D`.
- La serpiente arranca automáticamente hacia la derecha.
- Cada comida suma `+1` al score y hace crecer la serpiente.
- La partida termina al chocar con un borde o con el propio cuerpo.
- `RESTART` inicia una nueva partida (el High Score se conserva en `localStorage`).

## Ejecutar con Docker (recomendado)

La aplicación se empaqueta en una imagen basada en `nginx:1.31-alpine` que sirve los archivos estáticos de `src/`. Requiere Docker Engine y Docker Compose v2 (`docker compose`). Funciona en Linux y WSL2.

El servicio no publica puertos en el host: se conecta a la red Docker externa `proxy-net`, donde el reverse proxy lo alcanza como `http://snake-cicd:80`. Para desarrollo local, `compose.local.yml` agrega el puerto `127.0.0.1:8080`.

### Preparación local (una sola vez)

```bash
# Crear la red si no existe (en la VPS ya existe y no se crea desde este proyecto)
docker network inspect proxy-net >/dev/null 2>&1 || docker network create proxy-net

# En cada terminal de desarrollo: usar el override local en todos los comandos
export COMPOSE_FILE=docker-compose.yml:compose.local.yml
```

Con `COMPOSE_FILE` definido, los comandos siguientes publican la app en `localhost:8080`. Sin esa variable (como en la VPS) solo se usa `docker-compose.yml`.

| Elemento              | Valor                                  |
| --------------------- | -------------------------------------- |
| Proyecto Compose      | `snake-cicd`                           |
| Servicio Compose      | `snake`                                |
| Imagen                | `snake-cicd:latest`                    |
| Red                   | `proxy-net` (externa), alias `snake-cicd` |
| Puertos en el host    | Ninguno (local: `127.0.0.1:8080` con `compose.local.yml`) |
| Health check          | `GET /` cada 30 s (`wget` a 127.0.0.1) |
| Usuario en contenedor | `nginx` (no-root)                      |

### Construcción

```bash
docker compose build
```

### Inicio

```bash
docker compose up -d
```

Abrir <http://localhost:8080>, o comprobar sin navegador:

```bash
curl http://localhost:8080
```

> Con `compose.local.yml` el puerto se publica solo en `127.0.0.1` (no en todas las interfaces), por lo que la app no queda expuesta a la red.

### Estado

```bash
docker compose ps
```

La columna `STATUS` muestra `(healthy)` cuando Nginx responde correctamente, o `(unhealthy)` si falla el health check. Durante los primeros segundos puede verse `(health: starting)`.

### Logs

```bash
docker compose logs
```

### Logs en tiempo real

```bash
docker compose logs -f
```

### Detener

```bash
docker compose down
```

### Publicar cambios de código

Después de modificar archivos en `src/`:

```bash
docker compose build
docker compose up -d
```

### Archivos de Docker

```text
Dockerfile           # Imagen nginx:1.31-alpine + archivos estáticos + health check
docker-compose.yml   # Proyecto "snake-cicd", servicio único "snake" en proxy-net
compose.local.yml    # Override de desarrollo: publica 127.0.0.1:8080
.dockerignore        # Solo envía src/ y nginx/ al build context
nginx/nginx.conf     # Configuración mínima de Nginx (sitio estático, no-root)
```

La imagen no usa volúmenes, bind mounts ni variables de entorno, y no incluye secretos. El High Score se guarda en el `localStorage` del navegador.

## Ejecutar sin Docker

La app es estática: basta con servir la carpeta `src/`.

**Con Python:**

```bash
python3 -m http.server 8080 --directory src
```

También se puede abrir `src/index.html` directamente en el navegador.

## Tests

Los tests usan el runner nativo de Node.js (`node:test`), sin dependencias externas. Requieren **Node.js 18 o superior** (solo para correr los tests; la app no usa Node).

```bash
node --test tests/*.test.js
```

Sin Node instalado, con Docker:

```bash
docker run --rm -v "$PWD":/app -w /app node:22-alpine node --test tests/*.test.js
```

Cubren: movimiento, colisión con bordes, colisión consigo misma, detección de comida, incremento de score, generación de comida en posición válida (incluido tablero lleno), prevención del giro de 180° e inputs rápidos, y persistencia del High Score (valor ausente, inválido o `localStorage` no disponible).

## Configuración

Las constantes están al inicio de `src/game.js`:

| Constante     | Valor     | Descripción                          |
| ------------- | --------- | ------------------------------------ |
| `APP_VERSION` | `"1.0.0"` | Versión mostrada en la interfaz      |
| `GAME_SPEED`  | `150`     | Milisegundos por movimiento          |
| `GRID_SIZE`   | `20`      | Tamaño lógico del tablero (20 × 20)  |

La versión se define solo en `APP_VERSION`; el HTML la muestra desde esa constante.

## CI/CD

Cada push a `main` ejecuta los tests en GitHub Actions y, si pasan, despliega automáticamente en la VPS (`/opt/apps/app_snake`) por SSH con el usuario `deploy`, verificando que el contenedor quede healthy en `proxy-net` y que el dominio sirva la nueva versión. Los pull requests hacia `main` solo ejecutan los tests.

La configuración (qué secrets crear, la clave SSH de CI restringida, la huella del servidor) y la operación (leer resultados, redesplegar, rollback) están en [CICD.md](CICD.md).

## Deployment manual en VPS

El servicio se conecta a la red existente `proxy-net` y no publica puertos en el host. El procedimiento completo (usuario de deployment, deploy key SSH, verificación de la red, clonado en `/opt/apps/app_snake/`, verificación, actualización, rollback y operación) está en [DEPLOY.md](DEPLOY.md). Resumen:

```bash
# Primer deployment (en la VPS, como usuario de deployment)
git clone git@github-snake:estebannoblega/app_snake.git /opt/apps/app_snake
cd /opt/apps/app_snake
docker compose build && docker compose up -d
docker network inspect proxy-net >/dev/null   # la red debe existir (no se crea)
docker compose ps                    # debe mostrar (healthy)
docker run --rm --network proxy-net nginx:1.31-alpine wget -qO- http://snake-cicd/   # HTML de Snake

# Actualización
git pull --ff-only
docker compose build && docker compose up -d
```

### Rollback

```bash
cd /opt/apps/app_snake
git log --oneline -n 10              # elegir el commit estable anterior
git checkout <commit>                # queda en detached HEAD (esperado)
docker compose build && docker compose up -d
docker compose ps                    # verificar (healthy)
docker run --rm --network proxy-net nginx:1.31-alpine wget -qO- http://snake-cicd/game.js | grep "const APP_VERSION"
```

Mientras la VPS esté en un commit de rollback no ejecutar `git pull`. Una vez corregido el problema en `main` (con `git revert`, sin reescribir historia), volver con `git checkout main && git pull --ff-only` y reconstruir.
