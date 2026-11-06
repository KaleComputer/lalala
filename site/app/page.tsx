const features = [
  {
    title: "Local speech",
    body: "Speech-to-text and text-to-speech run on your Mac with Apple's MLX. No audio leaves the machine.",
  },
  {
    title: "A brain that delegates",
    body: "Short spoken answers, real work handed to coding agents. You keep talking while they build.",
  },
  {
    title: "An endless canvas",
    body: "Lists, comparisons, diagrams, small tools, even games, laid out as cards you can drag, resize and come back to on any device.",
  },
  {
    title: "Bring your harness",
    body: "Connects to MCP harnesses like T3 Code and uses the agents and subscriptions you already have.",
  },
];

const steps = [
  { name: "Talk", body: "You speak. Parakeet transcribes it locally while you're still talking." },
  { name: "Brain", body: "A brain thread answers out loud with Kokoro and decides what needs doing." },
  { name: "Agents", body: "Real work goes to coding agents in their own threads, in the background." },
  { name: "Canvas", body: "Anything worth looking at shows up as a card on the canvas next to you." },
];

function Soon() {
  return (
    <span className="btn btn-soon" aria-disabled="true">
      GitHub · coming soon
    </span>
  );
}

function VoiceBar() {
  return (
    <div className="bar" role="img" aria-label="The lalala voice bar, listening">
      <div className="bar-tab">
        <i className="dot" />
        <span>Listening</span>
      </div>
      <div className="bar-time">02:14</div>
      <div className="frame">
        <div className="frame-in">
          <span className="strip" />
          <svg className="wave" viewBox="0 0 400 44" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 22H400" className="wave-base" />
            <path
              className="wave-line"
              d="M0 22 C20 22 30 22 40 22 S60 12 70 22 S85 34 95 22 S110 6 122 22 S138 38 150 22 S165 10 176 22 S190 30 200 22 S215 4 228 22 S244 40 256 22 S272 14 282 22 S298 28 310 22 S330 22 400 22"
            />
          </svg>
          <span className="key">Talk</span>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <>
      <header className="top">
        <a className="mark" href="/" aria-label="lalala home">
          <img src="/favicon.svg" alt="" width={22} height={22} />
          <span>lalala</span>
        </a>
        <span className="tag tag-dim">Open source · MIT</span>
      </header>

      <main>
        <section className="hero">
          <p className="tag">Voice-first canvas for coding agents</p>
          <h1>
            talk to all
            <br />
            your agents
          </h1>
          <p className="lede">
            You speak. An agent brain answers out loud, sends the real work to coding agents, and
            builds what you need as cards on an endless canvas.
          </p>
          <VoiceBar />
          <div className="cta">
            <Soon />
            <span className="tag tag-dim">Repository opens soon</span>
          </div>
        </section>

        <section className="panel">
          <h2 className="tag">What it is</h2>
          <p className="big">
            lalala turns your voice into work. It sits on top of agent harnesses like{" "}
            <a href="https://github.com/pingdotgg/t3code">T3 Code</a>: a &ldquo;brain&rdquo; thread
            listens, replies in a sentence or two, and quietly delegates to Claude Code, Codex and
            friends in the background, so it is always free to keep listening.
          </p>
        </section>

        <section className="features">
          {features.map((f, i) => (
            <article className="card" key={f.title}>
              <div className="card-in">
                <h3 className="tag">
                  {String(i + 1).padStart(2, "0")} · {f.title}
                </h3>
                <p>{f.body}</p>
              </div>
            </article>
          ))}
        </section>

        <section className="panel">
          <h2 className="tag">Demo</h2>
          <div className="video" aria-label="Demo video coming soon">
            <span className="play" aria-hidden="true" />
            <span className="tag tag-dim">Demo video coming soon</span>
          </div>
        </section>

        <section className="panel">
          <h2 className="tag">How it works</h2>
          <ol className="flow">
            {steps.map((s) => (
              <li key={s.name}>
                <span className="step">{s.name}</span>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="panel end">
          <p className="big">Open source, Mac first. The repository goes public soon.</p>
          <Soon />
        </section>
      </main>

      <footer className="foot">
        <span>lalala · MIT License</span>
        <span>Made by Kale Computer</span>
      </footer>
    </>
  );
}
