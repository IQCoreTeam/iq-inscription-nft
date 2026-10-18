# Self-contained backend image. Build from the REPO ROOT so config.ts can
# resolve the program IDL relative to the repo tree (REPO_ROOT = /app):
#   docker build -f backend/Dockerfile -t iq-inscription-nft .
#
# Secrets (registrar key, RPC urls, optional Arweave key) are NOT baked in; they
# are injected at runtime via env and a mounted /app/backend/.data volume. The
# image holds only public code and the public IDL.
FROM oven/bun:1.3

WORKDIR /app

# Root dependencies (hono, solana web3, anchor, metaplex umi, iqlabs sdk). The
# umi pins in package.json "overrides" are load-bearing (1.0.0). Module
# resolution walks backend/node_modules then /app/node_modules, same as the repo.
COPY package.json ./
RUN bun install

# Backend-local dependency (irys upload), kept under backend/ like the repo.
COPY backend/package.json backend/bun.lock ./backend/
RUN cd backend && bun install

# Application code.
COPY backend/src ./backend/src

# Baked-in public data: config.ts reads the IDL from REPO_ROOT/target/idl.
COPY target/idl ./target/idl

WORKDIR /app/backend
ENV PORT=8787
EXPOSE 8787
CMD ["bun", "run", "src/server.ts"]
