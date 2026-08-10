# Build context: project root (run with -f confs/Dockerfile .)

# ---- Build stage ----
FROM denoland/deno:2.9.5 AS build
WORKDIR /app

# Install dependencies first (better layer caching)
COPY echelon-analytics/deno.json echelon-analytics/deno.lock* echelon-analytics/vite.config.ts ./
RUN deno install

# Copy application source
COPY echelon-analytics/ .

# Run checks: fmt, lint, typecheck
RUN deno task check

# Production build
RUN deno task build

# ---- Runtime stage ----
FROM denoland/deno:2.9.5 AS runtime
WORKDIR /app

# Built output
COPY --from=build /app/_fresh/ ./_fresh/
COPY --from=build /app/static/ ./static/
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/deno.json ./

# Server source files
COPY --from=build /app/main.ts ./
COPY --from=build /app/utils.ts ./
COPY --from=build /app/client.ts ./
COPY --from=build /app/types.ts ./
COPY --from=build /app/routes/ ./routes/
COPY --from=build /app/islands/ ./islands/
COPY --from=build /app/components/ ./components/
COPY --from=build /app/lib/ ./lib/

ARG VERSION=dev
ENV VERSION=${VERSION}

ARG GIT_HASH=
ENV GIT_HASH=${GIT_HASH}

ENV ECHELON_PORT=1947
EXPOSE ${ECHELON_PORT}

# PID 1 init — proper signal propagation to child processes
RUN apt-get update && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]

# Non-root user
RUN groupadd --system --gid 1001 echelon \
 && useradd --system --uid 1001 --gid echelon --no-create-home echelon

# DB directory — mount a host directory here so WAL/SHM files are shared
RUN mkdir -p /app/data && chown -R echelon:echelon /app
ENV ECHELON_DB_PATH=/app/data/echelon.db

ENV DENO_JOBS=4
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD deno eval "const r=await fetch('http://127.0.0.1:'+(Deno.env.get('ECHELON_PORT')||'1947')+'/api/health');if(!r.ok)Deno.exit(1)" || exit 1

USER echelon
# Single worker — do NOT add --parallel (in-memory state: sessions, buffers, rate limits)
CMD ["sh", "-c", "exec deno serve -A --port=${ECHELON_PORT} _fresh/server.js"]
