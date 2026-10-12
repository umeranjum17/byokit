# A hosted @byokit/relay: computers dial out to this, phones reach them through it.
# Build with the relay version in package.json; run one replica behind TLS (see the README).
FROM node:22-slim
ENV NODE_ENV=production
RUN useradd --system --no-create-home --shell /usr/sbin/nologin relay
WORKDIR /srv/relay
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs config.example.json ./
RUN mkdir -p /srv/relay/data /srv/relay/secrets && chown -R relay:relay /srv/relay
USER relay
EXPOSE 7300
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:7300/health').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"
CMD ["node", "server.mjs", "config.json"]
