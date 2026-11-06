import type { StorageAdapter } from "../index";

/** lalala.talk has no server: the stores' localStorage copy is the only one. */
export const browserStorage: StorageAdapter = {
  shared: false,
  read: async () => null,
  write: async () => null,
};
