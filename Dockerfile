FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "src/cli/index.js", "web"]