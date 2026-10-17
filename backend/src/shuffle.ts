// The pre-committed shuffle, byte for byte the bible-nft algorithm so the same
// public replay tool verifies both. Publishing sha256(seed) at launch and the
// seed at sellout lets anyone replay the whole assignment order.
//
// PRNG: byte stream = sha256(seed || u64_le(0)) || sha256(seed || u64_le(1)) ...
// Fisher-Yates from j = N-1 down to 1, drawing big-endian u64s with rejection
// sampling (no modulo bias).

import { createHash } from "node:crypto";

const sha256 = (data: Uint8Array): Buffer => createHash("sha256").update(data).digest();

class HashStream {
  private buf = Buffer.alloc(0);
  private counter = 0n;
  constructor(private seed: Buffer) {}

  nextU64(): bigint {
    while (this.buf.length < 8) {
      const ctr = Buffer.alloc(8);
      ctr.writeBigUInt64LE(this.counter);
      this.buf = Buffer.concat([this.buf, sha256(Buffer.concat([this.seed, ctr]))]);
      this.counter++;
    }
    const x = this.buf.readBigUInt64BE(0);
    this.buf = this.buf.subarray(8);
    return x;
  }
}

// Position k (0-based) is the item index served to the k-th allocation.
export function derivePermutation(seed: Buffer, n: number): number[] {
  const a = Array.from({ length: n }, (_, k) => k + 1);
  const stream = new HashStream(seed);
  for (let j = n - 1; j >= 1; j--) {
    const bound = BigInt(j + 1);
    const limit = (2n ** 64n / bound) * bound;
    let x = stream.nextU64();
    while (x >= limit) x = stream.nextU64();
    const r = Number(x % bound);
    [a[j], a[r]] = [a[r], a[j]];
  }
  return a;
}
