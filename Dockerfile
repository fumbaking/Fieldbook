FROM node:22-alpine
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY app ./app
COPY db ./db
COPY selfhost ./selfhost
ENV PORT=8080 DB_FILE=/data/fieldbook.sqlite DATA_FILE=/data/store.json
VOLUME /data
EXPOSE 8080
CMD ["node", "selfhost/server.js"]
