import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The app's topic sounds, copied into the static export at build time.
const EXTRAS = join(process.cwd(), "../src/voice/extras");

export const dynamic = "force-static";
export const dynamicParams = false;

export const generateStaticParams = () =>
  (process.env.LALALA_TOPIC_SOUNDS ?? "")
    .split(",")
    .filter(Boolean)
    .map((name) => ({ file: `${name}.mp3` }));

export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  const audio = await readFile(join(EXTRAS, `topicSounds-${file}`));
  return new Response(audio, { headers: { "content-type": "audio/mpeg" } });
}
