// Writes docs/dish-export.schema.json from the zod schema the app checks share files with, so both never drift
// apart (test/dish-share-schema.test.ts compares them). Usage (from meal-planner/): npm run schema
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shareFileJsonSchema } from "../src/app.ts";

const target = fileURLToPath(new URL("../../docs/dish-export.schema.json", import.meta.url));
writeFileSync(target, shareFileJsonSchema());
