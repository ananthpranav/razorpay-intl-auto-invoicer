FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4

LABEL org.opencontainers.image.title="razorpay-intl-auto-invoicer" \
      org.opencontainers.image.description="Monthly Razorpay invoices for international clients paid by MoneySaver bank transfer" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
# Templates for `init`, which writes the editable config files into a mounted folder.
COPY .env.example clients.example.json bank-details.example.json docker-compose.yml ./

RUN mkdir -p /app/output /app/data && chown node:node /app/output /app/data
USER node

ENTRYPOINT ["node", "src/cli.ts"]
CMD ["start"]
