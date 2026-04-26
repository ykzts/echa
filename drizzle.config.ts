import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { getDatabaseUrl } from "./db/url.ts";

config({ path: [".env.local", ".env"] });

export default defineConfig({
  dbCredentials: {
    url: getDatabaseUrl(),
  },
  dialect: "postgresql",
  out: "./migrations",
  schema: "./db/schema.ts",
});
