#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="echelon"
PORT="1947"
BIND_ADDRESS="127.0.0.1"
ALLOWED_IPS=""
KEEP_IMAGES=3
SMOKE_TIMEOUT=15

# ── Helpers ──────────────────────────────────────────────────────────────────

red()   { printf '\033[1;31m%s\033[0m\n' "$*"; }
green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
info()  { printf '\033[1;34m→ %s\033[0m\n' "$*"; }

die() { prune_images; red "ERROR: $*" >&2; exit 1; }

prune_images() {
  info "Pruning unused Docker images"
  # Remove dangling images (untagged layers from builds)
  docker image prune -f >/dev/null 2>&1 || true
  # Remove stopped containers older than 1h (stale smoke tests, old deploys)
  docker container prune -f --filter "until=1h" >/dev/null 2>&1 || true
  # Remove unused images older than 1h not referenced by any container
  docker image prune -a -f --filter "until=1h" >/dev/null 2>&1 || true
}

# Load deploy-relevant variables from an env file
load_deploy_vars() {
  local envfile="$1"
  [[ -f "$envfile" ]] || return 0
  local val
  val=$(grep -E '^BIND_ADDRESS=' "$envfile" | cut -d= -f2 | tr -d '[:space:]' || true)
  [[ -n "$val" ]] && BIND_ADDRESS="$val"
  val=$(grep -E '^ALLOWED_IPS=' "$envfile" | cut -d= -f2 | tr -d '[:space:]' || true)
  [[ -n "$val" ]] && ALLOWED_IPS="$val"
  val=$(grep -E '^DOCKER_NETWORK=' "$envfile" | cut -d= -f2 | tr -d '[:space:]' || true)
  [[ -n "$val" ]] && NETWORK="$val"
  val=$(grep -E '^ECHELON_PORT=' "$envfile" | cut -d= -f2 | tr -d '[:space:]' || true)
  [[ -n "$val" ]] && PORT="$val"
}

# ── Validate ─────────────────────────────────────────────────────────────────

VERSION=""
DEPLOY_LATEST=false
REDEPLOY=false
SEAL_OF_APPROVAL=false
NETWORK=""
INSTANCE_NAME=""

show_help() {
  echo "Usage: $0 [<tag>] [OPTIONS]"
  echo ""
  echo "Build, smoke-test, and deploy an Echelon Analytics Docker container."
  echo ""
  echo "Arguments:"
  echo "  <tag>                   Git tag to deploy (e.g. v26-03-01)"
  echo ""
  echo "Options:"
  echo "  --name NAME             Instance name for multi-instance deploys"
  echo "  --deploy-latest         Deploy the most recent git tag"
  echo "  --seal-of-approval      Deploy current branch/HEAD without a tag (quick testing)"
  echo "  --redeploy              Fast-track redeploy of an existing image (skip build + smoke)"
  echo "  --network NAME          Join Docker network (for Postgres connectivity)"
  echo "  --help                  Show this help message"
  echo ""
  echo "Multi-instance:"
  echo "  Each --name gets isolated containers, data dir, and env file."
  echo "  e.g. --name trippi → container echelon-trippi-*, data-trippi/, .env.trippi"
  echo ""
  echo "Examples:"
  echo "  $0 v26-03-01                     Deploy specific tag"
  echo "  $0 --deploy-latest               Deploy latest tag"
  echo "  $0 --seal-of-approval            Deploy current branch as-is"
  echo "  $0 --name trippi --seal-of-approval  Named instance deploy"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) show_help ;;
    --deploy-latest) DEPLOY_LATEST=true; shift ;;
    --seal-of-approval) SEAL_OF_APPROVAL=true; shift ;;
    --redeploy) REDEPLOY=true; shift ;;
    --network) NETWORK="$2"; shift 2 ;;
    --name) INSTANCE_NAME="$2"; shift 2 ;;
    *) VERSION="$1"; shift ;;
  esac
done

# ── Resolve instance name (CLI flag → .env → default) ───────────────────────

if [[ -z "$INSTANCE_NAME" && -f .env ]]; then
  env_name=$(grep -E '^INSTANCE_NAME=' .env | cut -d= -f2 | tr -d '[:space:]' || true)
  [[ -n "$env_name" ]] && INSTANCE_NAME="$env_name"
fi

# ── Validate instance name ───────────────────────────────────────────────────

if [[ -n "$INSTANCE_NAME" ]]; then
  if ! [[ "$INSTANCE_NAME" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
    echo "ERROR: --name must be lowercase alphanumeric with optional hyphens (e.g. trippi, my-site)" >&2
    exit 1
  fi
  if [[ "$INSTANCE_NAME" =~ ^(v[0-9]|dev(-|$)|smoke(-|$)) ]]; then
    echo "ERROR: --name must not start with v<digit>, dev, or smoke (reserved prefixes)" >&2
    exit 1
  fi
fi

# ── Compute instance-scoped paths ────────────────────────────────────────────

if [[ -n "$INSTANCE_NAME" ]]; then
  CONTAINER_PREFIX="echelon-${INSTANCE_NAME}"
  DATA_DIR="data-${INSTANCE_NAME}"
  ENV_FILE=".env.${INSTANCE_NAME}"
  LOCK_FILE="/tmp/echelon-${INSTANCE_NAME}-deploy.lock"
  # Container stop filter: only match this named instance's containers
  STOP_FILTER="^echelon-${INSTANCE_NAME}-"
else
  CONTAINER_PREFIX="echelon"
  DATA_DIR="data"
  ENV_FILE=".env"
  LOCK_FILE="/tmp/echelon-deploy.lock"
  # Container stop filter: match default instance only (tagged or dev), not named instances
  STOP_FILTER="^echelon-(v|dev-)"
fi

# ── Prevent concurrent deploys ───────────────────────────────────────────────

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "ERROR: Another deploy is already running (lock: $LOCK_FILE)" >&2
  exit 1
fi

# ── Load env vars ────────────────────────────────────────────────────────────

if [[ -n "$INSTANCE_NAME" && -f "$ENV_FILE" ]]; then
  load_deploy_vars "$ENV_FILE"
elif [[ -n "$INSTANCE_NAME" && ! -f "$ENV_FILE" ]]; then
  info "Instance env file $ENV_FILE not found, falling back to .env"
  ENV_FILE=".env"
  load_deploy_vars ".env"
else
  load_deploy_vars ".env"
fi

# Enforce main-only deploys (unless --seal-of-approval)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$SEAL_OF_APPROVAL" == "true" ]]; then
  SHORT_SHA=$(git rev-parse --short HEAD)
  GIT_TAG="dev-${CURRENT_BRANCH}-${SHORT_SHA}"
  VERSION="$SHORT_SHA"
  info "Seal of approval: deploying $CURRENT_BRANCH @ $SHORT_SHA as $GIT_TAG"
else
  if [[ "$CURRENT_BRANCH" != "main" ]]; then
    die "Production deploys must run from the main branch (current: $CURRENT_BRANCH). Use --seal-of-approval to deploy any branch."
  fi

  # Pull latest code and tags
  info "Pulling latest changes"
  git pull --tags

  if [[ "$DEPLOY_LATEST" == "true" ]]; then
    VERSION=$(set +o pipefail; git tag -l --sort=-version:refname | head -1)
    if [[ -z "$VERSION" ]]; then
      die "No tags found. Create one first with scripts/tag-release.sh"
    fi
    info "Selected latest tag: $VERSION"
  fi

  if [[ -z "$VERSION" ]]; then
    echo "Latest 5 tags:"
    echo ""
    (set +o pipefail; git tag -l --sort=-version:refname | head -5) | while read -r tag; do
      msg=$(git tag -l -n1 "$tag" | sed "s/^$tag\s*//")
      printf "  %-16s %s\n" "$tag" "$msg"
    done
    echo ""
    echo "Usage: $0 <tag> [--deploy-latest] [--redeploy]"
    exit 0
  fi

  GIT_TAG="$VERSION"
  [[ "$VERSION" != v* ]] && GIT_TAG="v$VERSION"

  if ! git rev-parse "$GIT_TAG" >/dev/null 2>&1; then
    die "Git tag $GIT_TAG not found. Create one first with scripts/tag-release.sh"
  fi
fi

DEPLOY_START=$SECONDS

# ── Redeploy check ──────────────────────────────────────────────────────────

if [[ "$REDEPLOY" == "true" ]]; then
  if ! docker image inspect "$IMAGE:$GIT_TAG" >/dev/null 2>&1; then
    die "Image $IMAGE:$GIT_TAG not found. Cannot --redeploy without an existing image."
  fi
  info "Fast-track redeploy — skipping build and smoke test"
fi

info "Deploying $IMAGE:$GIT_TAG"

# ── Build ────────────────────────────────────────────────────────────────────

if [[ "$REDEPLOY" == "true" ]]; then
  info "Skipping Docker build (--redeploy)"
else
  info "Building Docker image (checks run inside build stage)"
  DOCKER_BUILDKIT=0 docker build \
    -f confs/Dockerfile \
    --build-arg "VERSION=$GIT_TAG" \
    --build-arg "GIT_HASH=$(git rev-parse --short HEAD)" \
    -t "$IMAGE:$GIT_TAG" \
    .
  green "Build succeeded"
fi

# ── Load env vars from env file ──────────────────────────────────────────────

ENV_ARGS=()
if [[ -f "$ENV_FILE" ]]; then
  info "Loading env vars from $ENV_FILE"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "${line// /}" || "$line" == \#* ]] && continue
    [[ "$line" != *"="* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    value="${value%\"}" ; value="${value#\"}"
    value="${value%\'}" ; value="${value#\'}"
    ENV_ARGS+=(-e "$key=$value")
  done < "$ENV_FILE"
fi

# ── Docker network ──────────────────────────────────────────────────────────

NETWORK_ARGS=()
if [[ -n "$NETWORK" ]]; then
  info "Docker network: $NETWORK"
  NETWORK_ARGS=(--network "$NETWORK")
fi

# ── Smoke test ───────────────────────────────────────────────────────────────

CONTAINER="${CONTAINER_PREFIX}-${GIT_TAG}"

# Ensure data directory exists and is writable by the container user (UID 1001)
mkdir -p "$DATA_DIR"
chown -R 1001:1001 "$DATA_DIR"

if [[ "$REDEPLOY" == "true" ]]; then
  info "Skipping smoke test (--redeploy)"
else
  info "Running smoke test"
  SMOKE_NAME="${CONTAINER_PREFIX}-smoke-$$"

  docker run -d \
    --name "$SMOKE_NAME" \
    -p "127.0.0.1:0:$PORT" \
    -v "$(pwd)/${DATA_DIR}:/app/data" \
    --add-host=host.docker.internal:host-gateway \
    "${NETWORK_ARGS[@]+"${NETWORK_ARGS[@]}"}" \
    "${ENV_ARGS[@]+"${ENV_ARGS[@]}"}" \
    "$IMAGE:$GIT_TAG" >/dev/null

  SMOKE_PORT=$(docker port "$SMOKE_NAME" "$PORT/tcp" | head -1 | cut -d: -f2)

  smoke_cleanup() {
    docker rm -f "$SMOKE_NAME" >/dev/null 2>&1 || true
  }
  trap smoke_cleanup EXIT

  passed=false
  for i in $(seq 1 "$SMOKE_TIMEOUT"); do
    http_code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SMOKE_PORT/api/health" 2>/dev/null) || http_code="000"
    if [[ "$http_code" == "200" ]]; then
      passed=true
      break
    fi
    if (( i % 5 == 0 )); then
      container_status=$(docker inspect -f '{{.State.Status}}' "$SMOKE_NAME" 2>/dev/null || echo "unknown")
      printf '  [%2d/%ds] status=%s http=%s\n' "$i" "$SMOKE_TIMEOUT" "$container_status" "$http_code"
      if [[ "$container_status" == "exited" ]]; then
        red "Container exited prematurely!"
        break
      fi
    fi
    sleep 1
  done

  if [[ "$passed" != "true" ]]; then
    red "Smoke test failed — /api/health did not return 200 within ${SMOKE_TIMEOUT}s"
    red "Container logs (last 50 lines):"
    docker logs "$SMOKE_NAME" --tail 50 2>&1 || true
    smoke_cleanup
    trap - EXIT
    exit 1
  fi

  # ── Full smoke + fuzz + perf test suite ────────────────────────────────────
  info "Running full smoke test suite"
  SMOKE_SECRET=""
  if [[ -f "$ENV_FILE" ]]; then
    SMOKE_SECRET=$(grep -E '^ECHELON_SECRET=' "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]' || true)
  fi

  SMOKE_ARGS=("http://127.0.0.1:${SMOKE_PORT}")
  [[ -n "$SMOKE_SECRET" ]] && SMOKE_ARGS+=(--secret "$SMOKE_SECRET")

  if ! ECHELON_SECRET="$SMOKE_SECRET" ECHELON_DATA_DIR="$(pwd)/${DATA_DIR}" bash "$(dirname "$0")/smoke-test.sh" "${SMOKE_ARGS[@]}"; then
    red "Smoke test suite FAILED"
    red "Container logs (last 30 lines):"
    docker logs "$SMOKE_NAME" --tail 30 2>&1 || true
    smoke_cleanup
    trap - EXIT
    exit 1
  fi

  green "Smoke test suite passed"

  smoke_cleanup
  trap - EXIT
fi

# ── Firewall (optional IP restriction) ──────────────────────────────────────

if [[ -n "$ALLOWED_IPS" ]]; then
  info "Configuring firewall rules for port $PORT"
  sudo iptables -D INPUT -p tcp --dport "$PORT" -j DROP 2>/dev/null || true
  IFS=',' read -ra IPS <<< "$ALLOWED_IPS"
  for ip in "${IPS[@]}"; do
    ip=$(echo "$ip" | tr -d '[:space:]')
    [[ -z "$ip" ]] && continue
    sudo iptables -I INPUT -p tcp --dport "$PORT" -s "$ip" -j ACCEPT
  done
  sudo iptables -A INPUT -p tcp --dport "$PORT" -j DROP
  green "Firewall: allowed ${#IPS[@]} IP(s), blocked all others on port $PORT"
fi

# ── Deploy: stop old, start new ─────────────────────────────────────────────

# Stop any running container matching this instance's pattern
OLD=$(docker ps -q -f "name=${STOP_FILTER}" | head -1)
OLD_NAME=""
if [[ -n "$OLD" ]]; then
  OLD_NAME=$(docker inspect --format '{{.Name}}' "$OLD" | sed 's|^/||')
  # Longer than the app's own force-exit (ECHELON_SHUTDOWN_TIMEOUT_MS, 60s
  # default): a shorter grace SIGKILLs a slow final flush before the app's
  # timeout can log it, silently losing the buffered records.
  info "Stopping $OLD_NAME (70s grace period for buffer flush)"
  docker stop --time=70 "$OLD" >/dev/null
  docker rm "$OLD" >/dev/null
fi

# Remove any stopped container with the same name
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  info "Removing stopped container $CONTAINER"
  docker rm "$CONTAINER" >/dev/null
fi

info "Starting $CONTAINER"
docker run -d \
  --name "$CONTAINER" \
  -p "${BIND_ADDRESS}:${PORT}:${PORT}" \
  -v "$(pwd)/${DATA_DIR}:/app/data" \
  -e "VERSION=$VERSION" \
  --add-host=host.docker.internal:host-gateway \
  "${NETWORK_ARGS[@]+"${NETWORK_ARGS[@]}"}" \
  "${ENV_ARGS[@]+"${ENV_ARGS[@]}"}" \
  --restart unless-stopped \
  --stop-timeout 70 \
  --log-driver json-file \
  --log-opt max-size=50m \
  --log-opt max-file=5 \
  --memory 512m \
  "$IMAGE:$GIT_TAG" >/dev/null

# ── Live health check ───────────────────────────────────────────────────────

info "Waiting for health check"
passed=false
for i in $(seq 1 15); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    passed=true
    break
  fi
  sleep 1
done

if [[ "$passed" != "true" ]]; then
  red "Health check failed — automatic rollback"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

  if [[ -n "$OLD_NAME" ]]; then
    info "Restarting previous container: $OLD_NAME"
    docker start "$OLD_NAME" >/dev/null 2>&1 || true
    red "Rolled back to $OLD_NAME"
  else
    red "No previous container to rollback to"
  fi

  red "Deployment FAILED"
  docker logs "$CONTAINER" --tail 30 2>&1 || true
  exit 1
fi

green "Health check passed"

# ── Prune old images ────────────────────────────────────────────────────────

if [[ "$KEEP_IMAGES" -gt 0 ]]; then
  old_images=$(docker images "$IMAGE" --format '{{.Tag}}' \
    | grep -v '<none>' \
    | grep -v 'latest' \
    | sort -V \
    | head -n -"$KEEP_IMAGES" || true)

  for old_tag in $old_images; do
    info "Removing old image: $IMAGE:$old_tag"
    docker rmi "$IMAGE:$old_tag" >/dev/null 2>&1 || true
  done
fi

prune_images

# ── Summary ──────────────────────────────────────────────────────────────────

ELAPSED=$(( SECONDS - DEPLOY_START ))
echo ""
green "Deployment complete in ${ELAPSED}s"
echo "  Image:     $IMAGE:$GIT_TAG"
echo "  Container: $CONTAINER"
echo "  Port:      ${BIND_ADDRESS}:${PORT}"
echo "  Data dir:  $DATA_DIR"
[[ -n "$INSTANCE_NAME" ]] && echo "  Instance:  $INSTANCE_NAME"
