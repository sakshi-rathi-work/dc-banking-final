FROM node:20-alpine

WORKDIR /app

# Install wget and procps if needed for healthchecks
RUN apk add --no-cache wget

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000 8080

CMD ["node", "src/node/server.js"]
