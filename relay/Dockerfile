# TRACS Relay container image. Runs the relay from source under Node rather
# than the SEA binary, so the built-in auto-update stays off (it only runs
# for SEA) and updates come from pulling a newer image instead.
#
#   docker build -t tracs-relay relay
#   docker run -p 8765:8765 -p 10712:10712/udp -v ./relay-data:/data tracs-relay
FROM node:25-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Runtime modules only; scripts/ is the SEA build tooling.
COPY *.js ./

# The release workflow passes the tag's version so /health reports it.
ARG RELAY_VERSION
RUN if [ -n "$RELAY_VERSION" ]; then npm pkg set version="$RELAY_VERSION"; fi

# config.json, sessions.json and tacviewDetectionConfig.json live on the
# mounted volume, not in the image.
ENV RELAY_DATA_DIR=/data
RUN mkdir /data && chown node:node /data
VOLUME /data

USER node

EXPOSE 8765/tcp 10712/udp

# slim has no curl; probe /health with Node itself. Follows RELAY_WS_PORT, so
# set the port through that env var rather than only in config.json.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.RELAY_WS_PORT||8765)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Node as PID 1 is fine: the relay handles SIGTERM/SIGINT itself and shuts
# down cleanly on `docker stop`.
CMD ["node", "index.js"]
