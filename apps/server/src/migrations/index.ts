import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_init";
import * as m0002 from "./0002_billing";
import * as m0003 from "./0003_finances";
import * as m0004 from "./0004_integrations";
import * as m0005 from "./0005_batch_a";
import * as m0006 from "./0006_batch_b";
import * as m0007 from "./0007_batch_c";

/** Ordered by key. Add new migrations here. */
export const migrations: Record<string, Migration> = {
  "0001_init": m0001,
  "0002_billing": m0002,
  "0003_finances": m0003,
  "0004_integrations": m0004,
  "0005_batch_a": m0005,
  "0006_batch_b": m0006,
  "0007_batch_c": m0007,
};
