FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache \
    bash \
    git \
    openssh-client \
    ca-certificates \
    python3 \
    make \
    g++

RUN corepack enable && corepack prepare pnpm@9.6.0 --activate

COPY package.json ./package.json
COPY pnpm-lock.yaml ./pnpm-lock.yaml
COPY tsconfig.json ./tsconfig.json
COPY tsconfig.jest.json ./tsconfig.jest.json
COPY jest.config.cjs ./jest.config.cjs
COPY README.md ./README.md
COPY src ./src

RUN pnpm install --frozen-lockfile && pnpm build

CMD ["node", "dist/main.js"]
