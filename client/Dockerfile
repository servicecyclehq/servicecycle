FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Ensure the node user owns /app so Vite can write temp files
# (vite.config.js.timestamp-*.mjs) and the .vite build cache during npm run build
RUN chown -R node:node /app

EXPOSE 5173

USER node

# --host 0.0.0.0 is required so Vite listens on all interfaces inside Docker
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
