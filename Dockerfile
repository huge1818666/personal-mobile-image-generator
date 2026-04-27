FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server.mjs image-api.mjs ./
COPY public ./public

ENV HOST=0.0.0.0
ENV PORT=4273
ENV DATA_DIR=/data
EXPOSE 4273
VOLUME ["/data"]

CMD ["npm", "start"]
