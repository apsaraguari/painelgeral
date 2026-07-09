FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && apk del python3 make g++

COPY server.js ./
COPY database.js ./
COPY public/ ./public/

RUN mkdir -p data uploads

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
