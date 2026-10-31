// The only message schema for an authenticated sale-window intent. This is
// not a transaction, a spending authorization or an automatic funding request.
export function packWindowMessage(challenge) {
  const fields = [
    "origin",
    "chain",
    "program",
    "collection",
    "owner",
    "nonce",
    "expiresAt",
  ];
  if (
    !challenge ||
    typeof challenge !== "object" ||
    Array.isArray(challenge) ||
    Object.keys(challenge).some((key) => !fields.includes(key))
  )
    throw Error("Invalid pack window challenge");
  const origin = new URL(challenge.origin);
  if (
    origin.origin !== challenge.origin ||
    origin.username ||
    origin.password ||
    !(
      origin.protocol === "https:" ||
      (origin.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
    )
  )
    throw Error("Invalid pack window origin");
  if (
    !["solana:localnet", "solana:devnet", "solana:mainnet"].includes(
      challenge.chain,
    )
  )
    throw Error("Invalid pack window chain");
  for (const field of ["program", "collection", "owner"])
    if (
      typeof challenge[field] !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(challenge[field])
    )
      throw Error("Invalid pack window identity");
  if (
    typeof challenge.nonce !== "string" ||
    !/^[0-9a-f]{64}$/.test(challenge.nonce) ||
    !Number.isSafeInteger(challenge.expiresAt) ||
    challenge.expiresAt <= 0
  )
    throw Error("Invalid pack window lifetime");
  return [
    "Request one IQ pack sale window",
    "Origin: " + challenge.origin,
    "Chain: " + challenge.chain,
    "Pack program: " + challenge.program,
    "Collection: " + challenge.collection,
    "Wallet: " + challenge.owner,
    "Nonce: " + challenge.nonce,
    "Expires (Unix ms): " + challenge.expiresAt,
    "This signs no transaction and spends no wallet SOL.",
  ].join("\n");
}
