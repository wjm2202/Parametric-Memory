FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine
# Explicit heap ceiling — prevents V8 guessing from container-visible RAM.
# Override at runtime: docker run -e NODE_OPTIONS=--max-old-space-size=1024 ...
ENV NODE_OPTIONS=--max-old-space-size=512
RUN apk add --no-cache libstdc++
WORKDIR /app
# Pre-create shard directory for LevelDB
RUN mkdir -p mmpm-db
COPY package*.json ./
RUN npm install --only=production
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]