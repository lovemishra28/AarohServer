# Aaroh API (Node/Express) — pilot image.
FROM node:22-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
# `npm ci` not `npm install`: installs exactly what package-lock.json pins, so
# the image is reproducible and cannot silently drift from CI or your machine.
RUN npm ci

# Copy the rest of the source.
COPY . .

EXPOSE 3000

CMD ["npm", "run", "start"]
