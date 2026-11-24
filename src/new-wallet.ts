// Generates a throwaway TEST wallet for the client. Run it yourself: npm run wallet:new
// Prints the key once; paste it into .env as CLIENT_PRIVATE_KEY. Never put real funds here.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
const { address } = privateKeyToAccount(key);
console.log(`Address: ${address}`);
console.log(`Add to .env:\nCLIENT_PRIVATE_KEY=${key}`);
console.log(`\nThen get testnet USDC for ${address} at https://faucet.circle.com (network: Base Sepolia).`);
