# Derived outfit view — local integration candidate

This is a read-only adapter for the existing gateway/router. It does not replace immutable `/token-meta/{M}`, `/img/{C}` or `/data/{signature}` responses. An opted-in NFT points at `/wardrobe/metadata/{asset}`; the original IQ M signature remains in its Core Attributes and derived metadata.

Supply the host's already-budgeted Core reader, `createWardrobeReader` from the portable client, existing IQ metadata reader, and collection renderer. The Core reader must return the verified Core asset, including collection authority and Attributes. The metadata reader returns the exact original IQ bytes, never arbitrary HTTP metadata selected by an NFT owner. The renderer consumes the committed loadout and the collection's pinned layer recipes.

`createOutfitView(...).handle(request)` accepts GET/HEAD for `/wardrobe/metadata/{asset}` and `/wardrobe/image/{asset}?r={revision}&h={loadoutHash}`. Apply the gateway's normal concurrency/rate limits outside this handler. Errors do not expose RPC credentials or filesystem paths. Unknown paths and methods fail; stale revision/hash image requests return 409 and must refresh metadata. Responses revalidate; immutable base metadata is separately cached by its signature with bounded entries and coalesced reads.

The original name/URI must still match the binding in the program-owned loadout. Current Core collection membership, metadata signature shape and original name are checked. Returned metadata does not mutate the cached original object. Existing on-chain recovery can restore the original URI; doing so intentionally makes the bound outfit view reject until an approved re-opt-in restores its bound identity.

Confirmed equip/remove/transfer actions should invalidate the affected avatar in the shared reader. Unobserved external changes become visible after its short cache interval; no polling or table `/notify` calls are needed. Marketplace cache refresh is venue-specific and not guaranteed by HTTP invalidation. Buying clients still include the on-chain outfit assertion to prevent races.

`npm test` exercises immutable-reference preservation, cold/repeated metadata reads, stale image rejection, method/path/address bounds and safe transient errors. The sibling Surfpool test wires this adapter to real Core/IQ accounts and the existing private Nubbies renderer, including a fresh-view cache-loss recovery check. Actual layer/art publication and production hosting remain separately approved actions.
