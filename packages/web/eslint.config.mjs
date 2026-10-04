import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

/**
 * ESLint flat config for the dashboard.
 *
 * `next/core-web-vitals` and `next/typescript` come from `eslint-config-next`, so the
 * rules that matter for a Next.js App Router app are applied without duplicating them.
 */
const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
];

export default eslintConfig;
