"use strict";

/* ==========================================================================
 * Configuración
 * ======================================================================== */

const APP_VERSION = "1.1.0";
const GRID_SIZE = 20;
const GAME_SPEED = 150; // ms por movimiento
const INITIAL_LENGTH = 3;
const INITIAL_DIRECTION = "RIGHT";
const HIGH_SCORE_KEY = "snake.highScore";

const DIRECTIONS = {
  UP: { x: 0, y: -1 },
  DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
};

const OPPOSITE = {
  UP: "DOWN",
  DOWN: "UP",
  LEFT: "RIGHT",
  RIGHT: "LEFT",
};

/* ==========================================================================
 * Input
 * ======================================================================== */

const KEY_TO_DIRECTION = {
  ArrowUp: "UP",
  ArrowDown: "DOWN",
  ArrowLeft: "LEFT",
  ArrowRight: "RIGHT",
  w: "UP",
  s: "DOWN",
  a: "LEFT",
  d: "RIGHT",
};

// Controles de partida (solo teclado de PC).
const KEY_TO_ACTION = {
  " ": "START", // Espacio: iniciar o reiniciar
  Spacebar: "START", // navegadores antiguos
  p: "PAUSE", // P: pausar o reanudar
};

function normalizeKey(key) {
  if (typeof key !== "string") return null;
  return key.length === 1 ? key.toLowerCase() : key;
}

/** Devuelve la dirección asociada a una tecla, o null si no es un control válido. */
function getDirectionFromKey(key) {
  return KEY_TO_DIRECTION[normalizeKey(key)] || null;
}

/** Devuelve la acción de partida asociada a una tecla ("START" | "PAUSE"), o null. */
function getActionFromKey(key) {
  return KEY_TO_ACTION[normalizeKey(key)] || null;
}

/**
 * Registra una nueva dirección pendiente (solo con la partida en curso).
 * Se valida contra la dirección efectivamente aplicada en el último tick
 * (no contra la pendiente), de modo que ninguna secuencia de teclas dentro
 * del mismo tick puede producir un giro de 180°.
 */
function changeDirection(state, newDirection) {
  if (getPhase(state) !== "RUNNING" || !DIRECTIONS[newDirection]) return state;
  if (newDirection === OPPOSITE[state.direction]) return state;
  return { ...state, nextDirection: newDirection };
}

/* ==========================================================================
 * Collision Detection
 * ======================================================================== */

function isSamePosition(a, b) {
  return Boolean(a && b) && a.x === b.x && a.y === b.y;
}

function isOutOfBounds(pos, gridSize = GRID_SIZE) {
  return pos.x < 0 || pos.x >= gridSize || pos.y < 0 || pos.y >= gridSize;
}

function hitsSnake(pos, segments) {
  return segments.some((segment) => isSamePosition(pos, segment));
}

/* ==========================================================================
 * Food Generation
 * ======================================================================== */

/**
 * Elige una celda libre al azar. Devuelve null si el tablero está lleno
 * (recorre las celdas libres en lugar de reintentar posiciones al azar,
 * por lo que nunca entra en un bucle infinito).
 */
function generateFood(snake, rng = Math.random, gridSize = GRID_SIZE) {
  const occupied = new Set(snake.map((s) => `${s.x},${s.y}`));
  const free = [];
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      if (!occupied.has(`${x},${y}`)) free.push({ x, y });
    }
  }
  if (free.length === 0) return null;
  const index = Math.min(Math.floor(rng() * free.length), free.length - 1);
  return free[index];
}

/* ==========================================================================
 * Game State
 * ======================================================================== */

function createInitialSnake() {
  // Centrada en el tablero, mirando hacia la derecha.
  const head = { x: Math.floor(GRID_SIZE / 2), y: Math.floor(GRID_SIZE / 2) };
  const snake = [];
  for (let i = 0; i < INITIAL_LENGTH; i++) {
    snake.push({ x: head.x - i, y: head.y });
  }
  return snake;
}

function createInitialState(rng = Math.random) {
  const snake = createInitialSnake();
  return {
    snake,
    food: generateFood(snake, rng),
    direction: INITIAL_DIRECTION,
    nextDirection: INITIAL_DIRECTION,
    score: 0,
    gameOver: false,
    gameRunning: false,
    paused: false,
    won: false,
  };
}

/**
 * Fase de la partida, derivada del estado:
 * READY (cargada, sin iniciar) → RUNNING ⇄ PAUSED → OVER.
 */
function getPhase(state) {
  if (state.gameOver) return "OVER";
  if (!state.gameRunning) return "READY";
  return state.paused ? "PAUSED" : "RUNNING";
}

/** Pausa una partida en curso o reanuda una pausada; en otras fases no cambia nada. */
function togglePause(state) {
  const phase = getPhase(state);
  if (phase === "RUNNING") return { ...state, paused: true };
  if (phase === "PAUSED") return { ...state, paused: false };
  return state;
}

function getNextHead(head, direction) {
  const delta = DIRECTIONS[direction];
  return { x: head.x + delta.x, y: head.y + delta.y };
}

/* ==========================================================================
 * Score Management
 * ======================================================================== */

function incrementScore(score) {
  return score + 1;
}

function updateHighScore(score, highScore) {
  return Math.max(score, highScore);
}

/* ==========================================================================
 * Game Loop (lógica pura de un tick)
 * ======================================================================== */

/** Calcula el estado siguiente a partir del actual. No toca el DOM. */
function tick(state, rng = Math.random) {
  if (getPhase(state) !== "RUNNING") return state;

  // 1. Leer la dirección pendiente.
  const direction = state.nextDirection;
  // 2. Calcular la nueva cabeza.
  const head = getNextHead(state.snake[0], direction);
  const eats = isSamePosition(head, state.food);
  // Si no come, la cola se mueve en este tick y deja libre su celda.
  const body = eats ? state.snake : state.snake.slice(0, -1);

  // 3. Comprobar colisiones.
  if (isOutOfBounds(head) || hitsSnake(head, body)) {
    return { ...state, direction, gameOver: true, gameRunning: false };
  }

  // 4-6. Actualizar serpiente, comida y puntaje.
  const snake = [head, ...body];
  if (!eats) {
    return { ...state, snake, direction };
  }

  const food = generateFood(snake, rng);
  const score = incrementScore(state.score);
  if (food === null) {
    // Tablero completo: la partida termina con victoria.
    return { ...state, snake, direction, food, score, gameOver: true, gameRunning: false, won: true };
  }
  return { ...state, snake, direction, food, score };
}

/* ==========================================================================
 * Persistence
 * ======================================================================== */

/** Devuelve localStorage si está disponible y funciona, o null. */
function getStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probe = "__snake_probe__";
    storage.setItem(probe, probe);
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function parseHighScore(raw) {
  if (raw === null || raw === undefined || raw === "") return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function loadHighScore(storage) {
  if (!storage) return 0;
  try {
    return parseHighScore(storage.getItem(HIGH_SCORE_KEY));
  } catch {
    return 0;
  }
}

function saveHighScore(storage, value) {
  if (!storage) return false;
  try {
    storage.setItem(HIGH_SCORE_KEY, String(value));
    return true;
  } catch {
    return false;
  }
}

/* ==========================================================================
 * Rendering
 * ======================================================================== */

const COLORS = {
  board: "#0f172a",
  gridLine: "rgba(148, 163, 184, 0.08)",
  body: "#22c55e",
  head: "#bbf7d0",
  eye: "#0f172a",
  food: "#f43f5e",
};

const BOARD_PIXELS = 400;

function setupCanvas(canvas) {
  const ratio = globalThis.devicePixelRatio || 1;
  canvas.width = BOARD_PIXELS * ratio;
  canvas.height = BOARD_PIXELS * ratio;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

function drawBoard(ctx, cell) {
  ctx.fillStyle = COLORS.board;
  ctx.fillRect(0, 0, BOARD_PIXELS, BOARD_PIXELS);
  ctx.strokeStyle = COLORS.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < GRID_SIZE; i++) {
    const p = i * cell + 0.5;
    ctx.moveTo(p, 0);
    ctx.lineTo(p, BOARD_PIXELS);
    ctx.moveTo(0, p);
    ctx.lineTo(BOARD_PIXELS, p);
  }
  ctx.stroke();
}

function drawFood(ctx, food, cell) {
  if (!food) return;
  ctx.fillStyle = COLORS.food;
  ctx.beginPath();
  ctx.arc(food.x * cell + cell / 2, food.y * cell + cell / 2, cell * 0.38, 0, Math.PI * 2);
  ctx.fill();
}

function drawSnake(ctx, snake, direction, cell) {
  const pad = 1.5;
  snake.forEach((segment, index) => {
    ctx.fillStyle = index === 0 ? COLORS.head : COLORS.body;
    ctx.fillRect(segment.x * cell + pad, segment.y * cell + pad, cell - pad * 2, cell - pad * 2);
  });

  // Ojos en la cabeza, orientados según la dirección.
  const head = snake[0];
  const d = DIRECTIONS[direction];
  const cx = head.x * cell + cell / 2;
  const cy = head.y * cell + cell / 2;
  const forward = cell * 0.2;
  const side = cell * 0.2;
  ctx.fillStyle = COLORS.eye;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(cx + d.x * forward + d.y * side * s, cy + d.y * forward + d.x * side * s, cell * 0.09, 0, Math.PI * 2);
    ctx.fill();
  }
}

function render(ctx, state) {
  const cell = BOARD_PIXELS / GRID_SIZE;
  drawBoard(ctx, cell);
  drawFood(ctx, state.food, cell);
  drawSnake(ctx, state.snake, state.direction, cell);
}

/* ==========================================================================
 * App (enlace con el DOM)
 * ======================================================================== */

function initApp(doc) {
  const canvas = doc.getElementById("board");
  const scoreEl = doc.getElementById("score");
  const highScoreEl = doc.getElementById("high-score");
  const overlayEl = doc.getElementById("overlay");
  const overlayTitleEl = doc.getElementById("overlay-title");
  const overlayScoreEl = doc.getElementById("overlay-score");
  const overlayHintEl = doc.getElementById("overlay-hint");
  const statusEl = doc.getElementById("status");
  const restartBtn = doc.getElementById("restart");
  const versionEl = doc.getElementById("version");

  const ctx = setupCanvas(canvas);
  const storage = getStorage();
  let highScore = loadHighScore(storage);
  let state = createInitialState();
  let loopId = null;

  versionEl.textContent = `Version ${APP_VERSION}`;

  // Textos del overlay según la fase; RUNNING no muestra overlay.
  function getOverlay(phase) {
    switch (phase) {
      case "READY":
        return { title: "SNAKE", score: "", hint: "Press SPACE to start" };
      case "PAUSED":
        return { title: "PAUSED", score: `Score: ${state.score}`, hint: "Press P to resume" };
      case "OVER":
        return {
          title: state.won ? "YOU WIN" : "GAME OVER",
          score: `Score: ${state.score}`,
          hint: "Press SPACE to restart",
        };
      default:
        return null;
    }
  }

  function updateUI() {
    scoreEl.textContent = String(state.score);
    highScoreEl.textContent = String(highScore);

    const phase = getPhase(state);
    const overlay = getOverlay(phase);
    overlayEl.hidden = overlay === null;
    overlayEl.dataset.phase = phase;
    if (overlay) {
      overlayTitleEl.textContent = overlay.title;
      overlayScoreEl.textContent = overlay.score;
      overlayScoreEl.hidden = overlay.score === "";
      overlayHintEl.textContent = overlay.hint;
    }

    // Anuncio accesible solo cuando cambia el mensaje (no en cada tick).
    const message = overlay ? [overlay.title, overlay.score, overlay.hint].filter(Boolean).join(". ") : "Game running.";
    if (statusEl.textContent !== message) statusEl.textContent = message;
  }

  function stopLoop() {
    if (loopId !== null) {
      clearInterval(loopId);
      loopId = null;
    }
  }

  function startLoop() {
    stopLoop(); // garantiza un único loop activo
    loopId = setInterval(onTick, GAME_SPEED);
  }

  function onTick() {
    state = tick(state);
    if (state.score > highScore) {
      highScore = updateHighScore(state.score, highScore);
      saveHighScore(storage, highScore);
    }
    if (state.gameOver) stopLoop();
    render(ctx, state);
    updateUI();
  }

  function startGame() {
    state = { ...createInitialState(), gameRunning: true };
    render(ctx, state);
    updateUI();
    startLoop();
  }

  function pauseOrResume() {
    state = togglePause(state);
    const phase = getPhase(state);
    if (phase === "PAUSED") stopLoop();
    else if (phase === "RUNNING") startLoop();
    updateUI();
  }

  doc.addEventListener("keydown", (event) => {
    // No interferir con atajos del navegador (por ejemplo Ctrl+P).
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const action = getActionFromKey(event.key);
    if (action) {
      // Evita el scroll con Espacio y que active el botón enfocado.
      event.preventDefault();
      if (event.repeat) return; // mantener la tecla no repite la acción
      const phase = getPhase(state);
      if (action === "START" && (phase === "READY" || phase === "OVER")) startGame();
      if (action === "PAUSE") pauseOrResume();
      return;
    }

    const direction = getDirectionFromKey(event.key);
    if (!direction) return;
    event.preventDefault(); // evita el scroll con las flechas
    state = changeDirection(state, direction);
  });

  restartBtn.addEventListener("click", () => {
    startGame();
    restartBtn.blur(); // que Espacio/Enter no vuelvan a activar el botón
  });

  // La partida queda lista y empieza con Espacio.
  render(ctx, state);
  updateUI();
}

/* ==========================================================================
 * Arranque / exportación para tests
 * ======================================================================== */

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    APP_VERSION,
    GRID_SIZE,
    GAME_SPEED,
    INITIAL_LENGTH,
    INITIAL_DIRECTION,
    HIGH_SCORE_KEY,
    DIRECTIONS,
    getDirectionFromKey,
    getActionFromKey,
    changeDirection,
    getPhase,
    togglePause,
    isSamePosition,
    isOutOfBounds,
    hitsSnake,
    generateFood,
    createInitialSnake,
    createInitialState,
    getNextHead,
    incrementScore,
    updateHighScore,
    tick,
    parseHighScore,
    loadHighScore,
    saveHighScore,
  };
} else if (typeof document !== "undefined") {
  initApp(document);
}
