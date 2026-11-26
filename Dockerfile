FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# El script de parche debe existir ANTES de npm install (se ejecuta en postinstall)
COPY package*.json ./
COPY scripts ./scripts
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
