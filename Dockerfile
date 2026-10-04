FROM oven/bun:1.4.2 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
FROM dependencies AS development
COPY . .
FROM dependencies AS build
COPY src ./src
COPY migrations ./migrations
RUN bun run build
FROM oven/bun:1.4.2 AS runtime
WORKDIR /app
LABEL org.opencontainers.image.title="Warden"
LABEL org.opencontainers.image.description="Webhook-first GitHub App for aggregate PR checks"
LABEL org.opencontainers.image.licenses="MIT"
COPY LICENSE THIRD_PARTY_NOTICES.txt ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
USER bun
FROM runtime AS app
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=3 CMD bun -e 'if (!(await fetch("http://localhost:3000/ready")).ok) process.exit(1)'
CMD ["bun", "dist/app.js"]
FROM runtime AS api
EXPOSE 3000
CMD ["bun", "dist/app.js", "api"]
FROM runtime AS worker
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --retries=3 CMD bun -e 'if (!(await fetch("http://localhost:3001/ready")).ok) process.exit(1)'
CMD ["bun", "dist/app.js", "worker"]
