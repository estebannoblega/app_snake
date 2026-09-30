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
├── README.md
└── .gitignore
```

## Cómo jugar

- Mover: flechas `↑ ↓ ← →` o `W A S D`.
- La serpiente arranca automáticamente hacia la derecha.
- Cada comida suma `+1` al score y hace crecer la serpiente.
- La partida termina al chocar con un borde o con el propio cuerpo.
- `RESTART` inicia una nueva partida (el High Score se conserva en `localStorage`).

## Ejecutar localmente

La app es estática: basta con servir la carpeta `src/`.

**Con Docker (nginx):**

```bash
docker run --rm -p 8080:80 -v "$PWD/src":/usr/share/nginx/html:ro nginx:alpine
```

Abrir <http://localhost:8080>.

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
