// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { Plugin } from "vite";

/**
 * The published build does not have access to .env (it is gitignored), so Vite
 * cannot inline VITE_SUPABASE_* into the browser bundle, and the client build
 * rewrites `process.env` to `{}`. The result was a browser Supabase client that
 * threw "Missing Supabase environment variable(s)" on the live site.
 *
 * The worker DOES hold the values at runtime, so the root shell publishes the
 * public config on `globalThis.__LOVABLE_PUBLIC_ENV__`. This plugin points the
 * generated client's `process.env` fallback at that runtime object instead of
 * the compile-time stub. Only public (publishable) values ever travel this way.
 */
const RUNTIME_ENV_GLOBAL = "__LOVABLE_PUBLIC_ENV__";

function runtimePublicEnvFallback(): Plugin {
  const processEnv = /process\.env\[\s*(['"`])([A-Za-z_$][\w$]*)\1\s*\]/g;
  const importMetaEnv = /import\.meta\.env\[\s*(['"`])([A-Za-z_$][\w$]*)\1\s*\]/g;

  return {
    name: "lock-lab:runtime-public-env-fallback",
    enforce: "pre",
    transform(code, id) {
      if (this.environment?.name !== "client") return null;
      if (!id.includes("integrations/supabase/client")) return null;
      if (id.includes(".server")) return null;

      let next = code.replace(
        importMetaEnv,
        (_match, _quote, key: string) => `import.meta.env.${key}`,
      );
      next = next.replace(
        processEnv,
        (_match, _quote, key: string) =>
          `(globalThis.${RUNTIME_ENV_GLOBAL}||{})[${JSON.stringify(key)}]`,
      );

      return next === code ? null : { code: next, map: null };
    },
  };
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  plugins: [runtimePublicEnvFallback()],
});
