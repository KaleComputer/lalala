declare module "virtual:lalala-cards" {
  import type { ComponentType } from "react";

  /** `cards/index.tsx` in the brain's folder (vite/cards.mjs), or null when there is none. */
  const UserCards: ComponentType | null;
  export default UserCards;
}
