FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl git python3 procps && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir /workspace && chown node:node /workspace
CMD ["node", "src/control.mjs"]
