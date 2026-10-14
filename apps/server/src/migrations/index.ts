import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_init";

/** Ordered by key. Add new migrations here. */
export const migrations: Record<string, Migration> = {
  "0001_init": m0001,
};
