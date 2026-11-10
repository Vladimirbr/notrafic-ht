FROM node:26.13.0-bookworm-slim AS build

WORKDIR /app
RUN npm install --global pnpm@12.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json frontend/package.json
RUN pnpm install --frozen-lockfile
COPY fixtures ./fixtures
COPY frontend ./frontend
RUN pnpm --filter @notraffic/frontend build

FROM nginx:1.30.6-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
