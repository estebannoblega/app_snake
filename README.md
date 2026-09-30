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
├── docker-compose.yml
├── .dockerignore
├── DEPLOY.md        # Deployment manual en la VPS (SPEC-003)
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

| Elemento              | Valor                                  |
| --------------------- | -------------------------------------- |
| Proyecto Compose      | `snake-cicd`                           |
| Servicio Compose      | `snake`                                |
| Imagen                | `snake-cicd:latest`                    |
| Puerto                | `127.0.0.1:8080` → contenedor `80`     |
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

> El puerto se publica solo en `127.0.0.1` (no en todas las interfaces), por lo que la app no queda expuesta a la red. En WSL2 se puede abrir igualmente desde el navegador de Windows en `localhost:8080`.

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
docker-compose.yml   # Proyecto "snake-cicd", servicio único "snake"
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

## Deployment manual en VPS

El procedimiento completo (usuario de deployment, deploy key SSH, clonado en `/opt/apps/snake-cicd/`, verificación, actualización, rollback y operación) está en [DEPLOY.md](DEPLOY.md). Resumen:

```bash
# Primer deployment (en la VPS, como usuario de deployment)
git clone git@github-snake:estebannoblega/app_snake.git /opt/apps/snake-cicd
cd /opt/apps/snake-cicd
docker compose build && docker compose up -d
docker compose ps                    # debe mostrar (healthy)
curl -i http://127.0.0.1:8080        # 200 OK + HTML

# Actualización
git pull --ff-only
docker compose build && docker compose up -d
```

### Rollback

```bash
cd /opt/apps/snake-cicd
git log --oneline -n 10              # elegir el commit estable anterior
git checkout <commit>                # queda en detached HEAD (esperado)
docker compose build && docker compose up -d
docker compose ps                    # verificar (healthy)
curl -s http://127.0.0.1:8080/game.js | grep 'const APP_VERSION'
```

Mientras la VPS esté en un commit de rollback no ejecutar `git pull`. Una vez corregido el problema en `main` (con `git revert`, sin reescribir historia), volver con `git checkout main && git pull --ff-only` y reconstruir.
