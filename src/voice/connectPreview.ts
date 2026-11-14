/**
 * `?connect=fresh`: the app shows lalala.talk's not-yet-paired start (CONNECT TO T3 CODE in the bar) and
 * its connect screen, so they can be seen and designed on a computer that is always connected. Nothing
 * here touches the real connection; pairing from the preview only says it is a preview.
 */
export const connectPreview =
  typeof location !== "undefined" && new URLSearchParams(location.search).get("connect") === "fresh";

/** The commands lalala.talk shows (src/site/ConnectSection.tsx), for the preview. */
export const TALK_PAIR_COMMAND = "npx t3 pair --label lalala.talk";
export const TALK_CONNECT_COMMAND =
  "npx t3 auth pairing create --base-url https://<your T3 Connect address> --label lalala.talk";
