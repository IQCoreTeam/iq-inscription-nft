import { assertConnectionChain } from "./transactions.mjs";

// The existing IQ SDK signs in the browser through its supplied wallet/burner.
// The host owns source-consent, funding and the publication checkpoint; this
// adapter accepts no private-key serialization or server-side wallet payload.
export async function createIqMediaContext({
  sdk,
  connection,
  signer,
  chain,
  localGenesis,
  gateway,
  saveCheckpoint,
  onProgress,
  owner = signer.publicKey.toBase58(),
}) {
  const url = new URL(gateway);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw Error("Use the pinned cluster gateway");
  const expectedGenesis = await assertConnectionChain(
    connection,
    chain,
    localGenesis,
  );
  const pending = new Map();
  const signingAddress = signer.publicKey.toBase58();
  const reportProgress = event => {
    if (typeof onProgress !== "function") return;
    try { Promise.resolve(onProgress(event)).catch(() => {}); }
    catch { /* Display-only observers cannot interrupt publication or verification. */ }
  };
  return {
    gateway: url.origin,
    connection,
    owner,
    expectedGenesis,
    saveCheckpoint,
    async writeArtifact(bytes, name) {
      await assertConnectionChain(connection, chain, localGenesis);
      if (signer.publicKey.toBase58() !== signingAddress)
        throw Error("Media signer changed");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      JSON.parse(text); // Only the existing JSON inscription format is published.
      let lastPercent = -1;
      const signature = await sdk.writer.codeIn(
        { connection, signer },
        text,
        name,
        0,
        "json",
        typeof onProgress === "function" ? value => {
          if (!Number.isFinite(value)) return;
          const percent = Math.max(0, Math.min(100, Math.floor(value)));
          if (percent === lastPercent) return;
          lastPercent = percent;
          reportProgress({ name, percent });
        } : undefined,
      );
      if (
        typeof signature !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)
      )
        throw Error("Invalid media receipt");
      const result = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const status = result.value[0];
      if (
        !status ||
        status.err ||
        !["confirmed", "finalized"].includes(status.confirmationStatus)
      )
        throw Object.assign(
          Error("Media confirmation unresolved; retain its receipt"),
          { signature },
        );
      return signature;
    },
    async readArtifact(signature) {
      if (
        typeof signature !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)
      )
        throw Error("Invalid media reference");
      if (pending.has(signature)) return pending.get(signature);
      const work = (async () => {
        reportProgress({ phase: "checking-gateway-copy" });
        const response = await fetch(new URL("/token-meta/" + signature, url), {
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(120000),
        });
        if (!response.ok)
          throw Error(
            "Confirmed media is not available from the cached gateway yet",
          );
        if (Number(response.headers.get("content-length")) > 100000000)
          throw Error("Media inscription exceeds the supported bound");
        const reader = response.body.getReader(),
          parts = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 100000000)
              throw Error("Media inscription exceeds the supported bound");
            parts.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        return bytes;
      })().catch(error => {
        if (["TimeoutError", "AbortError"].includes(error?.name))
          throw Error("The gateway copy is still unavailable after 2 minutes. Its receipt is saved; retry pack setup to check the existing inscription.");
        throw error;
      });
      pending.set(signature, work);
      if (pending.size > 64) pending.delete(pending.keys().next().value);
      try {
        return await work;
      } finally {
        if (pending.get(signature) === work) pending.delete(signature);
      }
    },
  };
}
