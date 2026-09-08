# Always-on container for the screener (Render, Railway, Fly.io, a VPS, ...).
# The app is a long-running poller + tiny HTTP server, so it needs a host that
# keeps a process alive; serverless platforms such as Vercel cannot run it.
FROM node:22-alpine
WORKDIR /app

# tsx (the TypeScript runner used by `npm start`) is a devDependency, so keep
# dev dependencies in the image rather than adding a build step.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# Hosts inject PORT; the app reads it. GMGN_API_KEY must be set on the host.
ENV PORT=4477
EXPOSE 4477
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["npm", "start"]
