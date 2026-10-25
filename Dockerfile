FROM node:22.23.4-alpine
WORKDIR /app

# Outils de compilation pour le module natif better-sqlite3 (meme pattern que argon2 sur Nexio,
# cf Projets/VPS/docker.md).
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 3003
CMD ["node", "src/index.js"]
