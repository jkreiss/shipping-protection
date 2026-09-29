FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app

COPY . .
RUN npm ci --include=dev
RUN npx prisma generate && npm run build

FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
COPY extensions/insurance-ext/package.json ./extensions/insurance-ext/package.json
COPY extensions/shipping-protection-transform/package.json ./extensions/shipping-protection-transform/package.json
COPY prisma ./prisma
RUN npm ci --omit=dev --workspaces=false

COPY --from=build /app/build ./build
COPY --from=build /app/node_modules/.prisma/client ./node_modules/.prisma/client
COPY app ./app
COPY scripts ./scripts
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start"]
