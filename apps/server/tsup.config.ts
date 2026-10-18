import { defineConfig } from "tsup";

/** One self-contained ESM bundle per entry, so the runtime image needs no node_modules. */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    migrate: "src/cli/migrate.ts",
    seed: "src/cli/seed.ts",
    backup: "src/cli/backup.ts",
    "restore-verify": "src/cli/restoreVerify.ts",
    "import-workspace": "src/cli/importWorkspace.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  noExternal: [/.*/],
  external: ["pg-native"],
  splitting: true,
  sourcemap: true,
  clean: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
