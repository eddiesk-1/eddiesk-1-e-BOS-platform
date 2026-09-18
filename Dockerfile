# ============================================================================
# e-BOS backend — portable container build.
#
# Builds and runs from the REPO ROOT (this file's own directory) so the
# build step's `cp ../frontend/*.html dist/public/` (see
# backend/package.json's build script) has the sibling frontend/
# directory actually present in the build context — this Dockerfile
# must be built with the repo root as its context, not backend/ alone:
#
#   docker build -f Dockerfile -t e-bos .
#
# NOT `docker build -f backend/Dockerfile backend/` — that would never
# see frontend/ at all, and the build would fail at the cp step.
#
# WHAT THIS CONTAINER DOES NOT HANDLE, STATED PLAINLY:
# - Postgres itself. This ships the APPLICATION only — point it at a
#   real, already-running Postgres via DATABASE_URL/APP_DATABASE_URL/
#   PUBLIC_DATABASE_URL (a managed database from your host, or a
#   separate container/service you run alongside this one).
# - pgvector. That extension has to be available on whatever Postgres
#   this connects to — it is a property of the DATABASE, not something
#   this container can install into a database it doesn't own. Confirm
#   your Postgres provider supports `CREATE EXTENSION vector` BEFORE
#   deploying this — migration 001 will fail outright otherwise, and
#   that failure surfaces at container start (see the CMD below), not
#   at build time.
# ============================================================================

FROM node:20-slim AS build
WORKDIR /repo

# bcrypt is a native module — it compiles a C++ binding via node-gyp at
# install time. node:20-slim deliberately omits build tools to stay
# small, so without these, `npm install` fails specifically on bcrypt
# with a confusing node-gyp/python error, not a clear message about a
# missing system dependency. Only needed in the BUILD stage — the
# compiled binary that results gets copied into the runtime stage,
# which never needs a compiler at all.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy BOTH sibling directories the build step needs — frontend for its
# static HTML files, backend for the actual application.
COPY frontend/ ./frontend/
COPY backend/ ./backend/

WORKDIR /repo/backend
RUN npm install
RUN npm run build

# ---- Runtime stage: only what's needed to actually RUN the built app,
# not the TypeScript compiler or dev dependencies used to build it. ----
FROM node:20-slim AS runtime
WORKDIR /app

COPY --from=build /repo/backend/dist ./dist
COPY --from=build /repo/backend/migrations ./migrations
COPY --from=build /repo/backend/package.json ./package.json
COPY --from=build /repo/backend/package-lock.json ./package-lock.json

# Copies the ALREADY-INSTALLED node_modules from the build stage,
# rather than running npm install again here. This is deliberate, not
# an oversight: bcrypt's compiled native binding already exists in the
# build stage's node_modules (it needed python3/make/g++ to produce),
# and this runtime image never installs those compilers at all —
# reinstalling here would hit the identical bcrypt/node-gyp failure the
# build stage's apt-get install line exists to prevent. This also
# means the runtime image never needs network access to npm's registry
# at container start, which matters on platforms that isolate runtime
# containers from build-time network access differently.
#
# This DOES carry the build stage's full node_modules (including dev
# dependencies like typescript) into the runtime image rather than a
# pruned production-only set — a real, known tradeoff of this simpler
# approach (a larger image) against the alternative of a
# --omit=dev install that would break bcrypt. Acceptable for now;
# revisit with an npm-prune step if image size becomes a real problem.
COPY --from=build /repo/backend/node_modules ./node_modules

ENV NODE_ENV=production
EXPOSE 3000

# Runs migrations THEN starts the server, every time the container
# starts — safe to repeat on every deploy/restart, since
# node-pg-migrate tracks which migrations already applied and skips
# them (see backend/README.md's "Running migrations" section). This is
# what makes this container safe to redeploy repeatedly against the
# same database without a separate manual migration step.
CMD ["npm", "run", "deploy"]
