// Compiles assets/glyph-claude.svg into a single-glyph WOFF used by the status
// bar icon. Glyph is mapped to U+E900 and exposed as the "claude" icon id.
const fs = require("fs");
const path = require("path");
const { SVGIcons2SVGFontStream } = require("svgicons2svgfont");
const svg2ttf = require("svg2ttf");
const ttf2woff = require("ttf2woff");

const ASSETS = path.join(__dirname, "assets");
const OUT_WOFF = path.join(ASSETS, "claude.woff");

const fontStream = new SVGIcons2SVGFontStream({
  fontName: "claude-switch",
  fontHeight: 1000,
  normalize: true,
  centerHorizontally: true,
  log: () => {},
});

let svgFont = "";
fontStream
  .on("data", (chunk) => (svgFont += chunk))
  .on("end", () => {
    const ttf = svg2ttf(svgFont, {});
    const ttfBuf = Buffer.from(ttf.buffer);
    const woff = ttf2woff(ttfBuf);
    fs.writeFileSync(OUT_WOFF, Buffer.from(woff.buffer));
    console.log("wrote", path.relative(__dirname, OUT_WOFF), Buffer.from(woff.buffer).length, "bytes");
  })
  .on("error", (e) => {
    console.error(e);
    process.exit(1);
  });

const glyph = fs.createReadStream(path.join(ASSETS, "glyph-claude.svg"));
glyph.metadata = { unicode: [String.fromCodePoint(0xe900)], name: "claude" };
fontStream.write(glyph);
fontStream.end();
