FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
ENV PORT=1200 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 1200
CMD ["node", "server.js"]
