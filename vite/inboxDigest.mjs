// The away inbox's digest (Labs, off by default): one message after about two hours away while
// results pile up, then at most one every two hours, never one per item. It goes through the
// user's own command (LALALA_DIGEST_COMMAND in .env, given the text as its one argument), so
// nothing from a page decides what runs on this machine.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

const AWAY_MS = 2 * 60 * 60 * 1000;
const MIN_ITEMS = 2;
const LINES = 6;

const commandPath = () => {
  const command = process.env.LALALA_DIGEST_COMMAND?.trim();
  if (!command) return null;
  return command.startsWith("~/") ? `${NodeOS.homedir()}${command.slice(1)}` : command;
};

export function createDigest({ on, inbox, sent }) {
  const command = commandPath();
  // A restart can't tell whether a call is on: it counts as one, so nothing goes out for two hours.
  let presentAt = Date.now();
  let timer = null;

  const since = () => Math.max(presentAt, Date.parse(inbox().digestAt ?? "") || 0);
  const waiting = () =>
    inbox().items.filter((item) => !item.heard && Date.parse(item.at) > since());

  function send() {
    timer = null;
    const items = waiting();
    if (!on() || command === null || items.length < MIN_ITEMS) return;
    if (Date.now() - since() < AWAY_MS) return arm();
    const lines = items
      .slice(-LINES)
      .reverse()
      .map((item) => `• ${item.from}: ${item.summary}`);
    const more = items.length > LINES ? `\n…and ${items.length - LINES} more.` : "";
    const text = `lalala: ${items.length} results while you were away\n${lines.join("\n")}${more}`;
    sent(new Date().toISOString());
    NodeChildProcess.execFile(command, [text], { timeout: 30_000 }, (error) => {
      if (error) console.warn(`[lalala] away digest: ${command} failed (${error.code ?? error.message})`);
    });
  }

  function arm() {
    clearTimeout(timer);
    timer = null;
    if (!on() || command === null || waiting().length < MIN_ITEMS) return;
    timer = setTimeout(send, Math.max(1_000, since() + AWAY_MS - Date.now()));
  }

  return {
    configured: command !== null,
    /** The inbox changed: a result came in or was heard. */
    changed: arm,
    /** A page reports the user in a call: the time away starts again. */
    callSeen() {
      presentAt = Date.now();
      arm();
    },
    stop() {
      clearTimeout(timer);
      timer = null;
    },
  };
}
