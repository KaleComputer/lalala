import type { Metadata } from "next";

import { Connect } from "./Connect";
import "./connect.css";

export const metadata: Metadata = {
  title: "lalala — talk to your own agent",
  description: "Connect lalala.talk to T3 Code on your computer and talk to it, speech in the browser.",
};

export default function ConnectPage() {
  return (
    <main>
      <Connect />
    </main>
  );
}
