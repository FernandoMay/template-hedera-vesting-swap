import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  // The dashboard reads live Mirror Node state, so nothing is prerendered at build time.
  // Pages fetch per request and degrade to a readable message when the node is
  // unreachable, which keeps the app bootable in an offline CI environment.
  output: "standalone",
};

/**
 * Loads the repository root `.env` before Next.js reads its own environment.
 *
 * Next.js only loads `.env*` files from the directory it runs in, which in this workspace
 * layout is `packages/web`. The deploy script reads the same file from the repository root,
 * so without this line one `NEXT_PUBLIC_*` value would have to be duplicated in two places
 * and the dashboard would quietly render "contract not configured" while a deployment sat
 * right there in the terminal. Node's loader never overrides an exported variable, so
 * `NEXT_PUBLIC_HEDERA_NETWORK=mainnet npm run dev` still wins over the file.
 */
const rootEnv = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default nextConfig;