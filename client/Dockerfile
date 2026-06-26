FROM node:20-alpine

# Pre-create /app owned by node so the node user can write to it at runtime
# (Vite writes vite.config.js.timestamp-*.mjs and .vite/ cache during build)
RUN mkdir /app && chown node:node /app

WORKDIR /app

# Switch to node before npm ci so node_modules is owned by node from the start.
# This avoids the slow chown -R /app pass that would otherwise be needed after
# COPY . . to fix permissions on every rebuild.
USER node

COPY --chown=node:node package*.json ./
RUN npm ci

COPY --chown=node:node . .

EXPOSE 5173

# --host 0.0.0.0 is required so Vite listens on all interfaces inside Docker
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
