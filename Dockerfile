FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# Sem etapa de build: o Bun executa TypeScript direto. O typecheck roda no CI.
EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
