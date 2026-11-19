import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BOT_TOKEN: "123456:TEST-TOKEN",
            ENCRYPTION_KEY: "q83vEjRbTLQh+8l+6nW0P5lXK7cS7k2h0w3lQm9yQ7A=",
          },
        },
      }),
    ],
    test: { setupFiles: ["./tests/setup.ts"] },
  };
});
