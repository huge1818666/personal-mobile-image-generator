FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache libheif-tools
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.mjs image-api.mjs ./
COPY public ./public

EXPOSE 4273
VOLUME ["/data"]

CMD ["npm", "start"]
