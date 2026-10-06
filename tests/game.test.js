"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const game = require("../src/game.js");

const {
  GRID_SIZE,
  HIGH_SCORE_KEY,
  changeDirection,
  createInitialState,
  generateFood,
  getActionFromKey,
  getDirectionFromKey,
  getPhase,
  hitsSnake,
  isOutOfBounds,
  loadHighScore,
  parseHighScore,
  saveHighScore,
  tick,
  togglePause,
  updateHighScore,
} = game;

/** Estado de prueba con valores por defecto sobreescribibles. */
function makeState(overrides = {}) {
  return {
    snake: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }],
    food: { x: 15, y: 15 },
    direction: "RIGHT",
    nextDirection: "RIGHT",
    score: 0,
    gameOver: false,
    gameRunning: true,
    paused: false,
    won: false,
    ...overrides,
  };
}

/** Storage en memoria compatible con la API de localStorage. */
function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    data,
  };
}

describe("Estado inicial", () => {
  test("serpiente de 3 segmentos, dirección RIGHT, score 0", () => {
    const state = createInitialState();
    assert.equal(state.snake.length, 3);
    assert.equal(state.direction, "RIGHT");
    assert.equal(state.nextDirection, "RIGHT");
    assert.equal(state.score, 0);
    assert.equal(state.gameOver, false);
    state.snake.forEach((s) => assert.equal(isOutOfBounds(s), false));
  });

  test("la comida inicial está dentro del tablero y fuera de la serpiente", () => {
    const state = createInitialState();
    assert.ok(state.food);
    assert.equal(isOutOfBounds(state.food), false);
    assert.equal(hitsSnake(state.food, state.snake), false);
  });
});

describe("1. Movimiento", () => {
  test("avanza una celda en la dirección actual manteniendo la longitud", () => {
    const next = tick(makeState());
    assert.deepEqual(next.snake, [{ x: 6, y: 5 }, { x: 5, y: 5 }, { x: 4, y: 5 }]);
  });

  test("aplica la dirección pendiente en el tick", () => {
    const next = tick(makeState({ nextDirection: "DOWN" }));
    assert.deepEqual(next.snake[0], { x: 5, y: 6 });
    assert.equal(next.direction, "DOWN");
  });

  test("mapea flechas y WASD (mayúsculas y minúsculas) e ignora otras teclas", () => {
    assert.equal(getDirectionFromKey("ArrowUp"), "UP");
    assert.equal(getDirectionFromKey("ArrowDown"), "DOWN");
    assert.equal(getDirectionFromKey("ArrowLeft"), "LEFT");
    assert.equal(getDirectionFromKey("ArrowRight"), "RIGHT");
    assert.equal(getDirectionFromKey("w"), "UP");
    assert.equal(getDirectionFromKey("A"), "LEFT");
    assert.equal(getDirectionFromKey("s"), "DOWN");
    assert.equal(getDirectionFromKey("D"), "RIGHT");
    assert.equal(getDirectionFromKey("x"), null);
    assert.equal(getDirectionFromKey("Enter"), null);
    assert.equal(getDirectionFromKey(undefined), null);
  });
});

describe("2. Colisión con bordes", () => {
  test("isOutOfBounds respeta 0 <= x,y < 20", () => {
    assert.equal(isOutOfBounds({ x: 0, y: 0 }), false);
    assert.equal(isOutOfBounds({ x: GRID_SIZE - 1, y: GRID_SIZE - 1 }), false);
    assert.equal(isOutOfBounds({ x: -1, y: 0 }), true);
    assert.equal(isOutOfBounds({ x: 0, y: -1 }), true);
    assert.equal(isOutOfBounds({ x: GRID_SIZE, y: 0 }), true);
    assert.equal(isOutOfBounds({ x: 0, y: GRID_SIZE }), true);
  });

  test("salir por el borde derecho termina la partida", () => {
    const state = makeState({ snake: [{ x: 19, y: 5 }, { x: 18, y: 5 }, { x: 17, y: 5 }] });
    const next = tick(state);
    assert.equal(next.gameOver, true);
    assert.equal(next.gameRunning, false);
    assert.deepEqual(next.snake, state.snake, "la serpiente no se mueve fuera del tablero");
  });

  test("salir por el borde superior termina la partida", () => {
    const next = tick(makeState({
      snake: [{ x: 5, y: 0 }, { x: 5, y: 1 }, { x: 5, y: 2 }],
      direction: "UP",
      nextDirection: "UP",
    }));
    assert.equal(next.gameOver, true);
  });

  test("tras Game Over, tick no modifica el estado", () => {
    const over = makeState({ gameOver: true });
    assert.equal(tick(over), over);
  });
});

describe("3. Colisión consigo misma", () => {
  test("la cabeza sobre el cuerpo termina la partida", () => {
    // Serpiente en forma de U: al subir choca con su propio cuerpo.
    const snake = [
      { x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 4 },
    ];
    const next = tick(makeState({ snake, direction: "LEFT", nextDirection: "UP" }));
    assert.equal(next.gameOver, true);
  });

  test("moverse a la celda que libera la cola no es colisión", () => {
    // Cuadrado de 4: la cabeza entra donde estaba la cola.
    const snake = [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 4 }, { x: 5, y: 4 }];
    const next = tick(makeState({ snake, direction: "LEFT", nextDirection: "UP" }));
    assert.equal(next.gameOver, false);
    assert.deepEqual(next.snake[0], { x: 5, y: 4 });
  });
});

describe("4 y 5. Comida y puntaje", () => {
  test("al comer crece, suma +1 y genera nueva comida libre", () => {
    const state = makeState({ food: { x: 6, y: 5 }, score: 4 });
    const next = tick(state, () => 0);
    assert.equal(next.snake.length, state.snake.length + 1);
    assert.deepEqual(next.snake[0], { x: 6, y: 5 });
    assert.equal(next.score, 5);
    assert.ok(next.food);
    assert.equal(hitsSnake(next.food, next.snake), false);
  });

  test("sin comer, el puntaje no cambia", () => {
    const next = tick(makeState({ score: 3 }));
    assert.equal(next.score, 3);
    assert.deepEqual(next.food, { x: 15, y: 15 });
  });
});

describe("6. Generación de comida", () => {
  test("nunca aparece sobre la serpiente ni fuera del tablero", () => {
    const snake = createInitialState().snake;
    for (let i = 0; i < 500; i++) {
      const food = generateFood(snake);
      assert.equal(isOutOfBounds(food), false);
      assert.equal(hitsSnake(food, snake), false);
    }
  });

  test("con una sola celda libre, elige esa celda", () => {
    const snake = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (!(x === 7 && y === 13)) snake.push({ x, y });
      }
    }
    assert.deepEqual(generateFood(snake, () => 0.999), { x: 7, y: 13 });
  });

  test("con el tablero lleno devuelve null sin bucle infinito", () => {
    const snake = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) snake.push({ x, y });
    }
    assert.equal(generateFood(snake), null);
  });

  test("comer la última celda libre termina la partida con victoria", () => {
    // Serpiente que ocupa todo menos (0,0); la cabeza en (1,0) va a la izquierda.
    const snake = [{ x: 1, y: 0 }];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (!((x === 0 && y === 0) || (x === 1 && y === 0))) snake.push({ x, y });
      }
    }
    const next = tick(makeState({ snake, food: { x: 0, y: 0 }, direction: "LEFT", nextDirection: "LEFT" }));
    assert.equal(next.gameOver, true);
    assert.equal(next.won, true);
    assert.equal(next.food, null);
    assert.equal(next.snake.length, GRID_SIZE * GRID_SIZE);
  });
});

describe("7. Prevención del giro de 180°", () => {
  test("RIGHT + LEFT mantiene RIGHT", () => {
    const next = changeDirection(makeState(), "LEFT");
    assert.equal(next.nextDirection, "RIGHT");
  });

  test("giro de 90° es válido", () => {
    assert.equal(changeDirection(makeState(), "UP").nextDirection, "UP");
  });

  test("secuencia rápida RIGHT → DOWN → LEFT en el mismo tick no invierte la serpiente", () => {
    let state = makeState();
    state = changeDirection(state, "DOWN");
    state = changeDirection(state, "LEFT");
    const next = tick(state);
    assert.equal(next.gameOver, false);
    assert.deepEqual(next.snake[0], { x: 5, y: 6 });
  });

  test("secuencia RIGHT → DOWN → LEFT → DOWN → UP no produce 180° ni colisión", () => {
    let state = makeState();
    for (const dir of ["DOWN", "LEFT", "DOWN", "UP"]) state = changeDirection(state, dir);
    const next = tick(state);
    assert.equal(next.gameOver, false);
    assert.notEqual(next.direction, "LEFT");
  });

  test("ignora direcciones inválidas", () => {
    const state = makeState();
    assert.equal(changeDirection(state, "DIAGONAL"), state);
  });
});

describe("8. Persistencia del High Score", () => {
  test("sin valor previo devuelve 0", () => {
    assert.equal(loadHighScore(makeStorage()), 0);
  });

  test("guarda y recupera el valor", () => {
    const storage = makeStorage();
    assert.equal(saveHighScore(storage, 12), true);
    assert.equal(storage.data[HIGH_SCORE_KEY], "12");
    assert.equal(loadHighScore(storage), 12);
  });

  test("valores inválidos se interpretan como 0", () => {
    for (const raw of ["abc", "-5", "3.7", "12abc", "", "NaN", "Infinity"]) {
      assert.equal(parseHighScore(raw), 0, `raw=${raw}`);
      assert.equal(loadHighScore(makeStorage({ [HIGH_SCORE_KEY]: raw })), 0);
    }
  });

  test("sin storage disponible no lanza errores", () => {
    assert.equal(loadHighScore(null), 0);
    assert.equal(saveHighScore(null, 5), false);
  });

  test("storage que lanza excepciones no rompe el juego", () => {
    const broken = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("quota"); },
    };
    assert.equal(loadHighScore(broken), 0);
    assert.equal(saveHighScore(broken, 5), false);
  });

  test("updateHighScore conserva el máximo", () => {
    assert.equal(updateHighScore(5, 10), 10);
    assert.equal(updateHighScore(11, 10), 11);
  });
});

describe("9. Controles de partida: Espacio y P", () => {
  test("mapea Espacio a START y P/p a PAUSE; otras teclas no son acciones", () => {
    assert.equal(getActionFromKey(" "), "START");
    assert.equal(getActionFromKey("Spacebar"), "START");
    assert.equal(getActionFromKey("p"), "PAUSE");
    assert.equal(getActionFromKey("P"), "PAUSE");
    assert.equal(getActionFromKey("Enter"), null);
    assert.equal(getActionFromKey("ArrowUp"), null);
    assert.equal(getActionFromKey(undefined), null);
  });

  test("las teclas de acción no se interpretan como direcciones", () => {
    assert.equal(getDirectionFromKey(" "), null);
    assert.equal(getDirectionFromKey("p"), null);
  });

  test("fases: READY al cargar, RUNNING, PAUSED y OVER", () => {
    assert.equal(getPhase(createInitialState()), "READY");
    assert.equal(getPhase(makeState()), "RUNNING");
    assert.equal(getPhase(makeState({ paused: true })), "PAUSED");
    assert.equal(getPhase(makeState({ gameOver: true, gameRunning: false })), "OVER");
  });

  test("la partida no avanza antes de iniciarse", () => {
    const ready = createInitialState();
    assert.equal(tick(ready), ready);
  });

  test("P pausa y vuelve a reanudar", () => {
    const paused = togglePause(makeState());
    assert.equal(getPhase(paused), "PAUSED");
    assert.equal(getPhase(togglePause(paused)), "RUNNING");
  });

  test("en pausa la serpiente no se mueve ni acepta giros", () => {
    const paused = makeState({ paused: true });
    assert.equal(tick(paused), paused);
    assert.equal(changeDirection(paused, "UP"), paused);
  });

  test("al reanudar continúa desde la misma posición y dirección", () => {
    const running = makeState();
    const resumed = togglePause(togglePause(running));
    assert.deepEqual(tick(resumed).snake, tick(running).snake);
  });

  test("P no tiene efecto antes de iniciar ni tras Game Over", () => {
    const ready = createInitialState();
    const over = makeState({ gameOver: true, gameRunning: false });
    assert.equal(togglePause(ready), ready);
    assert.equal(togglePause(over), over);
  });

  test("antes de iniciar no se aceptan giros", () => {
    const ready = createInitialState();
    assert.equal(changeDirection(ready, "UP"), ready);
  });
});

describe("Configuración", () => {
  test("versión y velocidad definidas como constantes", () => {
    assert.equal(game.APP_VERSION, "1.1.0");
    assert.equal(game.GAME_SPEED, 150);
    assert.equal(GRID_SIZE, 20);
  });
});
