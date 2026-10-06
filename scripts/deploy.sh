#!/usr/bin/env bash
#
# Deployment de Snake en la VPS (SPEC-004).
#
# Lo ejecuta el runner self-hosted de GitHub Actions en la VPS, como usuario
# "deploy" (sudo -n -H -u deploy). También puede ejecutarse a mano como deploy:
#
#   /opt/apps/app_snake/scripts/deploy.sh <commit-sha>
#
# Pasos: validar entorno → actualizar código al commit indicado (debe
# pertenecer a main) → docker compose build → up -d → verificar salud, red,
# ausencia de puertos publicados y respuesta HTTP dentro de proxy-net.
#
# No crea ni modifica proxy-net ni el reverse proxy.

set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/apps/app_snake}"
BRANCH="main"
SERVICE="snake"
IMAGE="snake-cicd:latest"
NETWORK="proxy-net"
NETWORK_ALIAS="snake-cicd"
IMAGE_LABEL="org.opencontainers.image.title=snake-cicd"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"

log()  { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

# Obtiene el SHA a desplegar: un único argumento con el commit completo
# (40 caracteres hexadecimales).
parse_sha() {
  [[ $# -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]] \
    || fail "se esperaba un único argumento con el commit SHA completo (recibido: '$*')"
  printf '%s' "$1"
}

check_prerequisites() {
  log "Verificando prerrequisitos"
  command -v git >/dev/null || fail "git no está instalado"
  docker compose version >/dev/null 2>&1 || fail "docker compose no está disponible para el usuario $(id -un)"
  docker network inspect "$NETWORK" >/dev/null 2>&1 \
    || fail "la red '$NETWORK' no existe. No se crea desde el pipeline: debe crearla la infraestructura del reverse proxy"
  [[ -d "$APP_DIR/.git" ]] || fail "$APP_DIR no es un repositorio git"
  cd "$APP_DIR"
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] \
    || fail "hay cambios locales en $APP_DIR. Revisar con 'git status' (no se descartan automáticamente)"
}

update_code() {
  local sha="$1"
  log "Actualizando código desde origin/$BRANCH"
  git fetch --quiet origin "$BRANCH"
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$sha" "origin/$BRANCH"; then
    fail "el commit $sha no pertenece a origin/$BRANCH"
  fi
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    [[ -z "$(git rev-list "origin/$BRANCH..$BRANCH")" ]] \
      || fail "la rama local $BRANCH tiene commits que no están en origin/$BRANCH"
  fi
  git checkout --quiet -B "$BRANCH" "$sha"
  log "Código en $(git log -1 --format='%h %s')"
}

build_and_start() {
  log "docker compose build"
  docker compose build
  log "docker compose up -d"
  docker compose up -d --remove-orphans
}

show_diagnostics() {
  docker compose ps >&2 || true
  docker compose logs --tail 50 "$SERVICE" >&2 || true
}

verify() {
  local cid status waited=0
  cid="$(docker compose ps -q "$SERVICE")"
  [[ -n "$cid" ]] || fail "no se encontró el contenedor del servicio '$SERVICE'"

  log "Verificando estado del contenedor"
  [[ "$(docker inspect -f '{{.State.Running}}' "$cid")" == "true" ]] || { show_diagnostics; fail "el contenedor no está en ejecución"; }

  log "Esperando health check (máximo ${HEALTH_TIMEOUT}s)"
  while true; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
    case "$status" in
      healthy) break ;;
      unhealthy|none) show_diagnostics; fail "health check: $status" ;;
    esac
    (( waited >= HEALTH_TIMEOUT )) && { show_diagnostics; fail "health check sin respuesta tras ${HEALTH_TIMEOUT}s (estado: $status)"; }
    sleep 3
    waited=$((waited + 3))
  done
  log "Health check: healthy"

  log "Verificando red y puertos"
  docker inspect -f "{{with index .NetworkSettings.Networks \"$NETWORK\"}}{{join .Aliases \" \"}}{{end}}" "$cid" \
    | tr " " "\n" | grep -qx "$NETWORK_ALIAS" || fail "el contenedor no está en '$NETWORK' con el alias '$NETWORK_ALIAS'"
  [[ -z "$(docker port "$cid")" ]] || fail "el contenedor publica puertos en el host: $(docker port "$cid")"

  log "Verificando HTTP en http://$NETWORK_ALIAS/ dentro de $NETWORK"
  local expected served
  expected="$(grep -oE 'APP_VERSION = "[^"]+"' src/game.js)"
  local index
  index="$(docker run --rm --network "$NETWORK" --entrypoint wget "$IMAGE" -q -O - "http://$NETWORK_ALIAS/")" \
    || fail "la aplicación no responde por HTTP dentro de $NETWORK"
  [[ "$index" == *'<title>Snake</title>'* ]] || fail "http://$NETWORK_ALIAS/ no devuelve la aplicación Snake"
  served="$(docker run --rm --network "$NETWORK" --entrypoint wget "$IMAGE" -q -O - "http://$NETWORK_ALIAS/game.js" \
    | grep -oE 'APP_VERSION = "[^"]+"' || true)"
  [[ "$served" == "$expected" ]] || fail "versión servida ($served) distinta de la del código ($expected)"
  log "HTTP OK, $served"
}

cleanup_images() {
  # Solo imágenes huérfanas de Snake (de builds anteriores); no toca otras.
  docker image prune -f --filter "label=$IMAGE_LABEL" >/dev/null || true
}

main() {
  # Banner de falla para cualquier salida con error (incluido fail).
  trap 'rc=$?; (( rc == 0 )) || printf "\n[deploy] ======== DEPLOYMENT FALLIDO ========\n" >&2' EXIT
  local sha
  sha="$(parse_sha "$@")"
  log "Deployment solicitado para $sha"
  check_prerequisites
  update_code "$sha"
  build_and_start
  verify
  cleanup_images
  printf '\n[deploy] ======== DEPLOYMENT OK: %s ========\n' "$(git log -1 --format='%h %s')"
}

# Todo el script se parsea antes de ejecutar main: el checkout puede modificar
# este mismo archivo sin afectar la ejecución en curso.
main "$@"; exit $?
