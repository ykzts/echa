import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { getDatabaseUrl } from "./url.ts";

config({ path: [".env.local", ".env"] });

export const db = drizzle(getDatabaseUrl());
