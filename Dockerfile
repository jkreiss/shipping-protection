FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY . .
RUN npm ci --include=dev
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start"]
