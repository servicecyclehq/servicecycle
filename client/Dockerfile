FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 5173

USER node

# --host 0.0.0.0 is required so Vite listens on all interfaces inside Docker
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
