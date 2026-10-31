// Read-only adapter for the existing HTTP host. `markets` is an allowlist built
// from operator-owned cluster/program configuration, never request RPC URLs.
export function createPackSaleApi(markets) {
  return async (request) => {
    const url = new URL(request.url),
      match = /^\/packs\/([1-9A-HJ-NP-Za-km-z]{32,44})\/sale$/.exec(
        url.pathname,
      );
    if (!match) return Response.json({ error: "Not found" }, { status: 404 });
    if (request.method !== "GET")
      return Response.json({ error: "Read-only endpoint" }, { status: 405 });
    if (url.search)
      return Response.json(
        { error: "Unexpected sale parameters" },
        { status: 400 },
      );
    const market = markets.get(match[1]);
    if (!market)
      return Response.json(
        { error: "Unknown pack collection" },
        { status: 404 },
      );
    try {
      const { pool, epoch, slot, canPurchase } = await market.readSale();
      return Response.json(
        {
          collection: pool.collection.toBase58(),
          creatorTreasury: pool.treasury.toBase58(),
          creatorPrice: pool.price,
          platformFee: pool.platformFee,
          totalPrice: pool.totalPrice,
          epoch: epoch.id,
          ticketCount: epoch.ticketCount,
          slot,
          canPurchase,
          stock: pool.definitions.map(({ id, name, slot, remaining }) => ({
            id,
            name,
            slot,
            remaining,
          })),
        },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    } catch {
      return Response.json(
        { error: "Confirmed sale state is temporarily unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  };
}
