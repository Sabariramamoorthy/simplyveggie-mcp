FROM node:22-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=9320
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 9320
CMD ["node", "src/server.js"]
