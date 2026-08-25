# Aaroh API (Node/Express) — pilot image.
FROM node:22-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install

# Copy the rest of the source.
COPY . .

EXPOSE 3000

CMD ["npm", "run", "start"]
