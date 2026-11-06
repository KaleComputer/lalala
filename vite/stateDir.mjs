import * as NodePath from "node:path";

/** Where this checkout keeps its T3 session, canvas layout and call log (gitignored). */
export const stateDir = () =>
  process.env.LALALA_STATE_DIR?.trim() || NodePath.join(import.meta.dirname, "../.lalala");
