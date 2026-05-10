### Build stage
FROM node:24-alpine AS build
WORKDIR /app

RUN apk add --no-cache python3 make g++ \
 && corepack enable \
 && corepack prepare pnpm@10.32.1 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/tsconfig.json apps/gateway/drizzle.config.ts ./apps/gateway/
RUN pnpm install --frozen-lockfile

COPY apps/gateway/src ./apps/gateway/src
COPY apps/gateway/scripts ./apps/gateway/scripts
COPY apps/gateway/drizzle ./apps/gateway/drizzle

RUN pnpm --filter @llmgate/gateway build

### Runtime stage
FROM node:24-alpine
WORKDIR /app/apps/gateway

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/gateway/node_modules ./node_modules
COPY --from=build /app/apps/gateway/dist ./dist
COPY --from=build /app/apps/gateway/drizzle ./drizzle
COPY --from=build /app/apps/gateway/scripts ./scripts
COPY --from=build /app/apps/gateway/package.json ./package.json

EXPOSE 4000
CMD ["node", "dist/index.js"]
