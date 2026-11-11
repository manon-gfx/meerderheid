FROM node:24-alpine
WORKDIR /app
COPY package.json server.js index.html fallback.json ./
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
