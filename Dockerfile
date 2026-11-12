# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage
FROM node:22-alpine
ENV NODE_ENV=production
# DNS lookups run on libuv's threadpool, which defaults to 4 threads — a
# few slow resolutions at 50 concurrent sends delay everyone's (I4).
ENV UV_THREADPOOL_SIZE=16
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
CMD ["node", "dist/main/api.js"]
