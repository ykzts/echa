import { reset, seed } from "drizzle-seed";
import { db } from "#db/drizzle.ts";
import { users } from "#db/schema.ts";

async function main() {
  await reset(db, { users });

  await seed(db, { users });
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
