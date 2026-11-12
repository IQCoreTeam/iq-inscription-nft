import { build } from "esbuild";
import path from "node:path";
// IQ's existing wallet boundary uses web3 v1. Tensor's pinned resolvers use
// web3 v2 internally; a global alias would rewrite their incompatible imports.
const walletWeb3 = path.resolve(
  "node_modules/@solana/web3.js/lib/index.browser.esm.js",
);
await build({
  entryPoints: { browser: "browser-entry.mjs", sealed: "sealed-browser.mjs" },
  bundle: true,
  platform: "browser",
  format: "esm",
  outdir: "dist",
  alias: {
    buffer: "./node_modules/buffer",
    "@noble/hashes": "./node_modules/@noble/hashes",
  },
  plugins: [
    {
      name: "wallet-web3-boundary",
      setup(builder) {
        builder.onResolve({ filter: /^@solana\/web3\.js$/ }, (args) =>
          args.importer.includes("/@tensor-foundation/")
            ? undefined
            : { path: walletWeb3 },
        );
      },
    },
  ],
});
