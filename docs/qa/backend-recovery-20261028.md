# Backend recovery validation

Base: `98781d4bedffbef194ff0f144d65fdce1509068b`.

The production diff is limited to `backend/src/allocator.ts` and seven reservation regression cases in `tests/reserve-limits.test.ts`. Existing creator finalization and collection ordering behavior are preserved.

- Focused backend tests: 19 pass, 96 assertions; backend bundle and whitespace checks pass.
- Fresh offline Surfpool comparison: all four candidate scenarios pass; the exact upstream source reproduces all four failures. Ten signed fixture transactions cover actual Core/registry reads, deposits, paid recovery and concurrent reservation limits.
- Separate full local rehearsal: an actual 52,142-byte image and canonical metadata were inscribed through IQ, read back, verified, co-signed and minted with the cached NFT/Core programs. Replay, missing/reused deposits, mismatched metadata, reservation reuse/cancellation, separate owner/burner and sweep checks pass.
- The full rehearsal contains 97 landed transactions. All critical final receipts resolve; indexed burner balance deltas close exactly through its final zero balance. Additional unindexed submission attempts are not counted as confirmed transactions.

Generated disposable signers and simulated SOL only. Irys staging was substituted with an in-memory byte store. Program binaries and the SDK were pinned local fixtures; this does not establish deployed-byte equivalence, live Irys acceptance, gateway-cache acceptance, mobile-wallet acceptance or mainnet release readiness. No contract, schema, fee or provider behavior changes are included.

Raw private fixture outputs, signer material, build artifacts and dependency directories are intentionally excluded from this PR.
