FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

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
