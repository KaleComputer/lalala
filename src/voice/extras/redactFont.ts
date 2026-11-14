/**
 * Streamer mode's font: every character but whitespace is one block of the same width (0.48em,
 * about an average glyph), so text keeps its spaces, line breaks and wrapping but can't be read
 * or guessed. A 352-byte woff2 whose one cmap (format 13) maps all of Unicode to that block.
 */
const WOFF2 =
  "d09GMgABAAAAAAFgAAoAAAAAAugAAAEXAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAAgRQKHDYBNgIkAwYLBgAEIAVyBywbRwLIngVOmT0a8SFJ5E+EiNpRK1Lb5Rjx0Npv3u5iksxCgUt4zmRKpWv6qVKv4ckUojrdpFvnn7doiDNeCzUuzGG4goRNoqtNyMUJTigwSSTvLyDLdJhg4ITD0iiY0OHgl1/U0gdDGiuS98WmvDblvw7EpQ74AgBsAKIax6QpcAIYxyY4huAUZwgumHtAmPtYF4SNEBsZzLFRAmhgWxCdwbVRD39/CP/Myj8CCmgIGoYADZC2PzTVnr0AQXj6VVVw9OrXegs36kp3nTym2UFVQJjGKL2O3LgiAICkR4eBogkoAABodjBATCGgGDGlShsTS6T0YtrW3mTqY+ib7jqkKnaNntAcBr1G51IYTG67xsFkFFKGFgcAAA==";

export const REDACT_FAMILY = "lalala redact";

export const REDACT_FONT_FACE =
  `@font-face{font-family:"${REDACT_FAMILY}";font-display:block;` +
  `src:url(data:font/woff2;base64,${WOFF2}) format("woff2")}`;
