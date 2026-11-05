# The sample receiver runs the reference implementation (which imports the
# service's src/domain/verification.ts through tsx), so it shares the main
# image's source and dependency tree. Build context: repository root.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY examples/receiver/server.ts ./examples/receiver/server.ts
WORKDIR /app/examples/receiver
USER node
CMD ["npx", "tsx", "server.ts"]
