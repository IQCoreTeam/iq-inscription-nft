// THE one place to tune every devnet/mainnet difference.
//
// Edit this file to retarget or retune a network. config.ts picks a preset by
// CLUSTER and derives gatewayBase / tensorBase / irys / explorer from it, so a
// devnet deploy can NEVER accidentally carry a mainnet gateway (the misconfig
// that baked `gateway.iqlabs.dev` into devnet NFTs' on-chain uri + image url,
// 404ing them in every wallet). The env file only selects CLUSTER and supplies
// secrets/paths; it no longer holds any network-coupled URL.
//
// Network-INDEPENDENT ids (same address on both clusters) live in config.ts, not
// here: the program id (idl.address), CODE_IN_PROGRAM, MPL_CORE, and siteBase.

export type Cluster = "devnet" | "mainnet";

export type NetworkPreset = {
  // Our RPC pool, primary first (rotates on 429/5xx). A public endpoint is the
  // committed default; override with a keyed endpoint via the RPC_URLS env.
  rpcUrls: string[];
  // Host that serves /img and /token-meta, baked into every NFT's on-chain uri
  // and the image url inside each inscribed metadata. MUST match the cluster.
  gatewayBase: string;
  // Secondary-market sales API (read-only). Keyed by cluster in the hostname.
  tensorBase: string;
  // Irys devnet mode for the permanent image upload (devnet vs mainnet bundler).
  irysDevnet: boolean;
  // Where the client fetches an item's inscribed image bytes before re-inscribing.
  arweaveGateway: string;
  // Appended to solscan links so external_url resolves on the right cluster
  // (mainnet omits it; devnet needs ?cluster=devnet or the link 404s).
  explorerCluster: string;
};

export const NETWORKS: Record<Cluster, NetworkPreset> = {
  devnet: {
    rpcUrls: ["https://api.devnet.solana.com"],
    gatewayBase: "https://dev-gateway.iqlabs.dev",
    tensorBase: "https://api.devnet.tensordev.io/api/v1",
    irysDevnet: true,
    arweaveGateway: "https://devnet.irys.xyz",
    explorerCluster: "?cluster=devnet",
  },
  mainnet: {
    rpcUrls: ["https://api.mainnet-beta.solana.com"],
    gatewayBase: "https://gateway.iqlabs.dev",
    tensorBase: "https://api.mainnet.tensordev.io/api/v1",
    irysDevnet: false,
    arweaveGateway: "https://gateway.irys.xyz",
    explorerCluster: "",
  },
};

export function networkFor(cluster: string): NetworkPreset {
  const net = NETWORKS[cluster as Cluster];
  if (!net) throw new Error(`unknown CLUSTER "${cluster}" (expected devnet or mainnet)`);
  return net;
}
