/**
 * Hardhat config for the MatchRecord workspace.
 *
 * Deliberately secret-free: the config only knows the RPC URL (with a public
 * fallback), so `hardhat compile` / `hardhat test` run with no env at all.
 * The deploy script in `scripts/deploy.ts` supplies its own viem signer from
 * `contracts/.env` (MATCH_SIGNER_KEY), so no private key ever lives in a
 * config file or the repo.
 */
import { defineConfig } from "hardhat/config";
import toolbox from "@nomicfoundation/hardhat-toolbox-viem";

export default defineConfig({
  plugins: [toolbox],
  solidity: {
    version: "0.8.28",
  },
  networks: {
    monadTestnet: {
      type: "http",
      // chainType defaults to "generic", which is right for Monad (EVM, not
      // Optimism): the peer is contacted as a plain JSON-RPC node.
      chainId: 10_143,
      url: process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz",
    },
  },
});