# TEKK contracts — MatchRecord

The on-chain half of TEKK's mandatory Monad integration. One finished game
match becomes **one transaction**: a `MatchRegistered` header event plus one
`PlayerScored` event per racer, so the demo can point at real tx hashes.

Isolated on purpose: this workspace has its own `package.json` and never mixes
into the game server's dependency tree or typecheck.

## Layout

- `contracts/MatchRecord.sol` — the contract (append-only, registrar-gated)
- `scripts/deploy.ts` — deploys to Monad testnet with a viem signer
- `test/MatchRecord.test.ts` — contract tests on the in-memory Hardhat network

## Commands

```sh
npm install          # once
npm run compile      # solc 0.8.28 -> artifacts/
npm test             # contract tests, no chain needed
npm run deploy:testnet
```

## Deploying

1. `cp .env.example .env`, fill `MONAD_RPC_URL` and `MATCH_SIGNER_KEY`
   (a **funded testnet** wallet — https://faucet.monad.xyz).
2. `npm run compile`
3. `npm run deploy:testnet` — prints the contract address + deployment tx.
   Track it at https://testnet.monadvision.com.
4. Put the address into the game server's `tekk2/.env` as
   `MATCH_RECORD_ADDRESS` (see `tekk2/.env.example`).

## Security notes

- The deploy signer key is read from `.env` by the deploy script only; the
  Hardhat config holds no secrets.
- The contract holds no value and spends no funds on players — the recorded
  tx is the redemption.