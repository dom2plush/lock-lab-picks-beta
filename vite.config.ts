// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { Plugin } from "vite";

/**
 * The generated Supabase client reads its config with bracket notation
 * (`import.meta.env['VITE_SUPABASE_URL']`). Vite's VITE_* define injection only
 * replaces dot-notation access, so the production browser bundle shipped with
 * no credentials and every client-side Supabase call threw at runtime.
 *
 * Rewriting the bracket form to the dot form before define runs lets the
 * standard injection inline the values as intended.
 */
function normalizeImportMetaEnvAccess(): Plugin {
  const pattern = /import\.meta\.env\[\s*(['"`])([A-Za-z_$][\w$]*)\1\s*\]/g;
  return {
    name: "lock-lab:normalize-import-meta-env-access",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/src/")) return null;
      if (!code.includes("import.meta.env[")) return null;
      const next = code.replace(pattern, (_match, _quote, key) => `import.meta.env.${key}`);
      if (next === code) return null;
      return { code: next, map: null };
    },
  };
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  plugins: [normalizeImportMetaEnvAccess()],
});
