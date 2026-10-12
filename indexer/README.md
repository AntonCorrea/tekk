# TEKK MatchRecord indexer (Envio HyperIndex)

The **reading** half of TEKK's Monad integration (Stage 2). The game server
writes one tx per finished match to the `MatchRecord` contract on Monad testnet
(Stage 1); this indexer turns those events into GraphQL rows the lobby can show.

Isolated on purpose: its own `package.json`, so it never touches the game's
dependency tree or typecheck (mirrors `tekk2/contracts/`).

## What it indexes

`MatchRegistered` → one `Match` row, `PlayerScored` → one `Player` row (linked).

Chain `10143` (Monad testnet), contract
`0x9a1e7a4Cd75F7916b52C1D63aEC38E893852Da56`, from its deploy block. HyperSync
is the data source, so no RPC is needed.

## Commands

```sh
npm install          # once
npm run codegen      # regenerate types from config.yaml + schema.graphql
npm run dev          # run locally (needs Docker Desktop + a WSL distro on Windows)
npm run deploy       # deploy to Envio Cloud (needs ENVIO_API_TOKEN in .env)
```

> **Node:** pinned to `envio@3.13.0`, whose engine allows Node ≥ 22.0.0.
> `envio@3.14+` requires Node ≥ 22.15.0.

## Deploying to Envio Cloud

1. Create an API token at https://envio.dev/app/api-tokens.
2. `cp .env.example .env`, paste it as `ENVIO_API_TOKEN` (gitignored).
3. `npm run deploy`. The CLI prints the hosted GraphQL endpoint.
4. Put that endpoint in the game's `tekk2/.env` as `VITE_LEADERBOARD_URL`
   (see `tekk2/.env.example`) and the lobby panel starts showing real matches.

## Querying

The endpoint is Hasura-style GraphQL. Recent matches:

```graphql
query {
  Match(limit: 8, order_by: { matchId: desc }) {
    matchId
    courseId
    mode
    winner
    playerCount
    txHash
  }
}
```

`winner` and `Player.wallet` are the zero address until Stage 3 (Privy), so the
leaderboard is match-centric for now.
