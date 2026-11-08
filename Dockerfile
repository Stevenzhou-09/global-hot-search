FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

ENV PORT=3000 REFRESH_MINUTES=60
EXPOSE 3000
VOLUME ["/app/data"]

CMD ["npm", "start"]
