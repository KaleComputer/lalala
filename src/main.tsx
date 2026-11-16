// One entry for both hosts, from the one index.html: the app (`vite`, :5780, with its own server
// for layout, speech and the T3 bridge) and lalala.talk (`vite build --mode site`, static on
// Vercel, everything in the browser). vite.config.mjs sets import.meta.env.LALALA_HOST; the other
// host's code is dropped from the build.
// ?bench=k10c: the speech speed bench alone (src/bench), nothing else of either host loads.
if (new URLSearchParams(location.search).has("bench")) void import("./bench/main");
else if (import.meta.env.LALALA_HOST === "site") void import("./site/main");
else void import("./app/main");
