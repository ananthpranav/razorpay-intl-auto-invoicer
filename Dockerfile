FROM node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5

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
