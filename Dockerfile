FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY . .
RUN npm run build

# ── test stage ────────────────────────────────────────────────────────────────
# Contains full devDependencies + compiled source + test files.
# Run with:  docker build --target test --progress=plain .
# or via:    docker compose run --rm mmpm-test
#
# NODE_OPTIONS ensures V8 uses the same heap ceiling as production.
FROM builder AS test
ENV NODE_OPTIONS=--max-old-space-size=512
CMD ["npm", "test"]

# ── production runtime ────────────────────────────────────────────────────────
FROM node:20-alpine
# Explicit heap ceiling — prevents V8 guessing from container-visible RAM.
# Override at runtime: docker run -e NODE_OPTIONS=--max-old-space-size=1024 ...
ENV NODE_OPTIONS=--max-old-space-size=512
RUN apk add --no-cache libstdc++
WORKDIR /app
# Pre-create the mount point so Docker bind-mounts it with correct ownership.
# The actual DB files come from the host at ${HOME}/.mmpm/data (see compose).
RUN mkdir -p /app/mmpm-db
COPY package*.json ./
RUN npm install --only=production
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]