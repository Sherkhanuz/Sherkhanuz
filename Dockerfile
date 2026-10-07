FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY *.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/erp.db
VOLUME /data
EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
