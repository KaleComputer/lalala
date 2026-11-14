import UserCards from "virtual:lalala-cards";

import { VoiceExtras as SharedExtras } from "./VoiceExtras";

/**
 * The app's canvas: lalala's own cards plus the user's, from `cards/index.tsx` in the brain's folder
 * (vite/cards.mjs). lalala.talk mounts VoiceExtras itself, with its file cards only.
 */
export function VoiceExtras() {
  return <SharedExtras>{UserCards ? <UserCards /> : null}</SharedExtras>;
}
