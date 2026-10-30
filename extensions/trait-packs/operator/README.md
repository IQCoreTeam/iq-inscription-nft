# Signed operator-transaction recovery

This module handles transactions the existing operator has already built, simulated, signed and durably stored. It never receives a private key or creates a new transaction on an uncertain outcome.

The host must enforce one database-backed lease per job and atomically store signed bytes, signature, blockhash and last-valid height before broadcasting. Save must commit before returning. Confirmed/failed signatures reconcile without another broadcast; a still-valid unresolved job resends only exact bytes. An expired absent signature remains unresolved for on-chain reconciliation. Missing RPC status is not proof of failure.

`nextEpochTask` selects one bounded action from already identity-validated confirmed pool/epoch/provider state. It has no timer or signer. This is recovery infrastructure, not a complete hosted epoch scheduler. The host must separately select bounded request/capture/allocation/claim/refund/payout actions from confirmed state, validate ORAO configuration and fund operator costs. Do not expose signed checkpoints publicly or enable a relay automatically.
