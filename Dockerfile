FROM node:22.18.0-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app

# Install from the manifests alone so a code change reuses the installed layer.
COPY package.json package-lock.json ./
COPY extensions/insurance-ext/package.json ./extensions/insurance-ext/package.json
COPY extensions/shipping-protection-transform/package.json ./extensions/shipping-protection-transform/package.json
RUN npm ci --include=dev
COPY . .
RUN npx prisma generate && npm run build

FROM node:22.18.0-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
COPY extensions/insurance-ext/package.json ./extensions/insurance-ext/package.json
COPY extensions/shipping-protection-transform/package.json ./extensions/shipping-protection-transform/package.json
RUN npm ci --omit=dev --workspaces=false
COPY prisma ./prisma

COPY --from=build /app/build ./build
COPY --from=build /app/node_modules/.prisma/client ./node_modules/.prisma/client
COPY app ./app
COPY scripts ./scripts
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["npm", "run", "start"]
