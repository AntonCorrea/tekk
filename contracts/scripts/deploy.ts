/**
 * Deploy MatchRecord to Monad testnet.
 *
 *   npm run deploy:testnet
 *
 * Reads `contracts/.env` (MONAD_RPC_URL, MATCH_SIGNER_KEY) -- copy
 * `.env.example` to `.env` and fill it in with a funded testnet wallet. The
 * signer key is read here in the script, never from the Hardhat config.
 *
 * Prints the contract address and the deployment tx hash; paste the hash into
 * https://testnet.monadvision.com to watch it land.
 */
import { loadEnvFile } from "node:process";
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

try {
  loadEnvFile(); // contracts/.env, optional -- otherwise env comes from the shell
} catch {
  // fine, no .env present
}

const RPC_URL = process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";

const monadTestnet = defineChain({
  id: 10_143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: "MonadVision", url: "https://testnet.monadvision.com" },
  },
});

// Artifact produced by `hardhat compile` (see contracts/package.json).
const ARTIFACT_URL = new URL(
  "../artifacts/contracts/MatchRecord.sol/MatchRecord.json",
  import.meta.url,
);

async function main(): Promise<void> {
  const signerKey = process.env.MATCH_SIGNER_KEY;
  if (!signerKey) {
    throw new Error(
      "MATCH_SIGNER_KEY is not set. Copy contracts/.env.example to contracts/.env and fill it in.",
    );
  }

  const account = privateKeyToAccount(signerKey as Hex);
  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ chain: monadTestnet, transport });
  const walletClient = createWalletClient({ account, chain: monadTestnet, transport });

  const artifact = JSON.parse(readFileSync(ARTIFACT_URL, "utf8"));

  console.log(`Deploying MatchRecord to Monad testnet (chain 10143) from ${account.address}...`);

  const deployTx = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    account,
    args: [account.address], // the deployer is the registrar
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTx });

  console.log(`MatchRecord deployed: ${receipt.contractAddress}`);
  console.log(`Deployment tx:       ${deployTx}`);
  console.log(`Explorer:            https://testnet.monadvision.com/tx/${deployTx}`);
  console.log("Next: set MATCH_RECORD_ADDRESS + MATCH_SIGNER_KEY in tekk2/.env");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});