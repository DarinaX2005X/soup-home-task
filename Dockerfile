FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
COPY server/package.json server/
COPY web/package.json web/
COPY tests/package.json tests/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY sdk sdk
COPY server server
COPY web web
RUN npm run build

# The API is one bundled file. No node_modules in the image.
FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/server/dist/server.js ./server.js
# Only used when LOG_FILE points here (the test stack mounts a volume on it).
RUN mkdir /logs && chown node:node /logs
USER node
EXPOSE 3000
CMD ["node", "server.js"]

FROM nginx:1.27-alpine AS web
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
