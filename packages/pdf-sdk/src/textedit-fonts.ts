// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Bundled metric-compatible font matching for text editing ("Option C",
 * docs/TEXT-EDITING.md).
 *
 * A PDF's embedded fonts are SUBSETS — they lack the glyphs a user newly types,
 * and the full font isn't in the file — so a text edit can't extend them. To
 * keep the *apparent* typeface anyway, we draw the edited run (as an overlay) in
 * a BUNDLED font that metric-matches the original face, instead of a generic
 * standard-14 substitute. When there's no confident match this returns null and
 * the caller falls back to the standard font (no regression).
 *
 * The bundled fonts are OFL-1.1 (SIL Open Font License) — permitted for font
 * assets by the 2026-07-04 extension of locked decision #4. They're imported as
 * hashed URL assets and fetched on demand, so they never enter the main bundle.
 *
 * Families (the common Office/Windows default set):
 *   - Arial / Helvetica → Arimo (full regular/bold/italic/bold-italic; the bold
 *     faces are static instances of the variable Arimo at wght=700).
 *   - Calibri → Carlito, Times → Tinos, Courier → Cousine, Cambria → Caladea
 *     (all static, full regular/bold/italic/bold-italic).
 * Verdana/Georgia have no clean metric-compatible open match → standard fallback.
 *
 * Beyond the bundled set, `matchFont` also resolves ~30 common **Google Fonts**
 * (Roboto, Open Sans, Lato, Montserrat, Poppins, Inter, …) by fetching their TTF
 * on demand from jsdelivr (OFL-1.1), so an edit to a document that actually uses
 * one of those keeps its real typeface. See GOOGLE_FAMILIES below.
 */
import arimoUrl from './fonts/Arimo.ttf?url';
import arimoBoldUrl from './fonts/Arimo-Bold.ttf?url';
import arimoItalicUrl from './fonts/Arimo-Italic.ttf?url';
import arimoBoldItalicUrl from './fonts/Arimo-BoldItalic.ttf?url';
import carlitoUrl from './fonts/Carlito-Regular.ttf?url';
import carlitoBoldUrl from './fonts/Carlito-Bold.ttf?url';
import carlitoItalicUrl from './fonts/Carlito-Italic.ttf?url';
import carlitoBoldItalicUrl from './fonts/Carlito-BoldItalic.ttf?url';
import tinosUrl from './fonts/Tinos-Regular.ttf?url';
import tinosBoldUrl from './fonts/Tinos-Bold.ttf?url';
import tinosItalicUrl from './fonts/Tinos-Italic.ttf?url';
import tinosBoldItalicUrl from './fonts/Tinos-BoldItalic.ttf?url';
import cousineUrl from './fonts/Cousine-Regular.ttf?url';
import cousineBoldUrl from './fonts/Cousine-Bold.ttf?url';
import cousineItalicUrl from './fonts/Cousine-Italic.ttf?url';
import cousineBoldItalicUrl from './fonts/Cousine-BoldItalic.ttf?url';
import caladeaUrl from './fonts/Caladea-Regular.ttf?url';
import caladeaBoldUrl from './fonts/Caladea-Bold.ttf?url';
import caladeaItalicUrl from './fonts/Caladea-Italic.ttf?url';
import caladeaBoldItalicUrl from './fonts/Caladea-BoldItalic.ttf?url';

export interface FontMatch {
  /** Hashed asset URL of the matched font (style already resolved). */
  url: string;
  /** Display name of the matched family (for tooltips / notes). */
  name: string;
}

/** Per-family bundled faces. Missing styles gracefully fall back (bold→regular). */
interface FamilyFaces {
  regular: string;
  bold?: string;
  italic?: string;
  boldItalic?: string;
}
interface FamilyEntry {
  /** Match against the normalized (lowercased, letters-only) base font name. */
  test: RegExp;
  name: string;
  faces: FamilyFaces;
}

const FAMILIES: FamilyEntry[] = [
  {
    // Arial / Helvetica / ArialMT — Arimo is metric-compatible with Arial.
    test: /arial|helvetica|arimo/,
    name: 'Arimo',
    faces: { regular: arimoUrl, bold: arimoBoldUrl, italic: arimoItalicUrl, boldItalic: arimoBoldItalicUrl },
  },
  {
    // Calibri — Carlito is metric-compatible with Calibri (Word's default face).
    test: /calibri|carlito/,
    name: 'Carlito',
    faces: {
      regular: carlitoUrl,
      bold: carlitoBoldUrl,
      italic: carlitoItalicUrl,
      boldItalic: carlitoBoldItalicUrl,
    },
  },
  {
    // Times New Roman / Times — Tinos is metric-compatible.
    test: /timesnewroman|times|tinos/,
    name: 'Tinos',
    faces: { regular: tinosUrl, bold: tinosBoldUrl, italic: tinosItalicUrl, boldItalic: tinosBoldItalicUrl },
  },
  {
    // Courier New / Courier — Cousine is metric-compatible.
    test: /couriernew|courier|cousine/,
    name: 'Cousine',
    faces: { regular: cousineUrl, bold: cousineBoldUrl, italic: cousineItalicUrl, boldItalic: cousineBoldItalicUrl },
  },
  {
    // Cambria — Caladea is metric-compatible.
    test: /cambria|caladea/,
    name: 'Caladea',
    faces: { regular: caladeaUrl, bold: caladeaBoldUrl, italic: caladeaItalicUrl, boldItalic: caladeaBoldItalicUrl },
  },
];

// ── Dynamic Google Fonts (curated) ──────────────────────────────────────────
// When no BUNDLED metric-compatible family matches, resolve the run's font from a
// curated set of common Google Fonts, fetched on demand from jsdelivr (the
// google/fonts repo, OFL-1.1). This dramatically widens coverage (Roboto, Open
// Sans, Lato, Montserrat, Poppins, Inter, …) without shipping the fonts. Paths
// are verified exact (GF's real filenames are inconsistent — static vs [wght] vs
// [wdth,wght] vs [opsz,wght]); variable-only families expose regular (+ italic
// where a separate variable file exists), so bold falls back to regular like the
// bundled Arimo. No new dependency — reuses fetchFontBytes; a fetch failure just
// degrades to the standard substitute (the caller already try/catches).
const GF = 'https://cdn.jsdelivr.net/gh/google/fonts@main/';
const gf = (p: string) => GF + p.replace(/\[/g, '%5B').replace(/\]/g, '%5D');

const GOOGLE_FAMILIES: FamilyEntry[] = [
  { test: /^roboto$/, name: 'Roboto', faces: { regular: gf('ofl/roboto/Roboto[wdth,wght].ttf'), italic: gf('ofl/roboto/Roboto-Italic[wdth,wght].ttf') } },
  { test: /^opensans$/, name: 'Open Sans', faces: { regular: gf('ofl/opensans/OpenSans[wdth,wght].ttf'), italic: gf('ofl/opensans/OpenSans-Italic[wdth,wght].ttf') } },
  { test: /^lato$/, name: 'Lato', faces: { regular: gf('ofl/lato/Lato-Regular.ttf'), bold: gf('ofl/lato/Lato-Bold.ttf'), italic: gf('ofl/lato/Lato-Italic.ttf'), boldItalic: gf('ofl/lato/Lato-BoldItalic.ttf') } },
  { test: /^montserrat$/, name: 'Montserrat', faces: { regular: gf('ofl/montserrat/Montserrat[wght].ttf'), italic: gf('ofl/montserrat/Montserrat-Italic[wght].ttf') } },
  { test: /^poppins$/, name: 'Poppins', faces: { regular: gf('ofl/poppins/Poppins-Regular.ttf'), bold: gf('ofl/poppins/Poppins-Bold.ttf'), italic: gf('ofl/poppins/Poppins-Italic.ttf'), boldItalic: gf('ofl/poppins/Poppins-BoldItalic.ttf') } },
  { test: /^inter$/, name: 'Inter', faces: { regular: gf('ofl/inter/Inter[opsz,wght].ttf') } },
  { test: /^raleway$/, name: 'Raleway', faces: { regular: gf('ofl/raleway/Raleway[wght].ttf'), italic: gf('ofl/raleway/Raleway-Italic[wght].ttf') } },
  { test: /^nunito$/, name: 'Nunito', faces: { regular: gf('ofl/nunito/Nunito[wght].ttf'), italic: gf('ofl/nunito/Nunito-Italic[wght].ttf') } },
  { test: /^notosans$/, name: 'Noto Sans', faces: { regular: gf('ofl/notosans/NotoSans[wdth,wght].ttf') } },
  { test: /^worksans$/, name: 'Work Sans', faces: { regular: gf('ofl/worksans/WorkSans[wght].ttf'), italic: gf('ofl/worksans/WorkSans-Italic[wght].ttf') } },
  { test: /^sourcesans/, name: 'Source Sans 3', faces: { regular: gf('ofl/sourcesans3/SourceSans3[wght].ttf'), italic: gf('ofl/sourcesans3/SourceSans3-Italic[wght].ttf') } },
  { test: /^playfairdisplay$/, name: 'Playfair Display', faces: { regular: gf('ofl/playfairdisplay/PlayfairDisplay[wght].ttf'), italic: gf('ofl/playfairdisplay/PlayfairDisplay-Italic[wght].ttf') } },
  { test: /^ubuntu$/, name: 'Ubuntu', faces: { regular: gf('ufl/ubuntu/Ubuntu-Regular.ttf'), bold: gf('ufl/ubuntu/Ubuntu-Bold.ttf'), italic: gf('ufl/ubuntu/Ubuntu-Italic.ttf'), boldItalic: gf('ufl/ubuntu/Ubuntu-BoldItalic.ttf') } },
  { test: /^oswald$/, name: 'Oswald', faces: { regular: gf('ofl/oswald/Oswald[wght].ttf') } },
  { test: /^rubik$/, name: 'Rubik', faces: { regular: gf('ofl/rubik/Rubik[wght].ttf'), italic: gf('ofl/rubik/Rubik-Italic[wght].ttf') } },
  { test: /^dmsans$/, name: 'DM Sans', faces: { regular: gf('ofl/dmsans/DMSans[opsz,wght].ttf') } },
  { test: /^notoserif$/, name: 'Noto Serif', faces: { regular: gf('ofl/notoserif/NotoSerif[wdth,wght].ttf') } },
  { test: /^merriweather$/, name: 'Merriweather', faces: { regular: gf('ofl/merriweather/Merriweather[opsz,wdth,wght].ttf') } },
  // Monospace — code / technical documents. (The only bundled monospace is
  // Cousine, for Courier; these cover the popular code faces.)
  { test: /^robotomono$/, name: 'Roboto Mono', faces: { regular: gf('ofl/robotomono/RobotoMono[wght].ttf'), italic: gf('ofl/robotomono/RobotoMono-Italic[wght].ttf') } },
  { test: /^jetbrainsmono$/, name: 'JetBrains Mono', faces: { regular: gf('ofl/jetbrainsmono/JetBrainsMono[wght].ttf'), italic: gf('ofl/jetbrainsmono/JetBrainsMono-Italic[wght].ttf') } },
  { test: /^sourcecodepro$/, name: 'Source Code Pro', faces: { regular: gf('ofl/sourcecodepro/SourceCodePro[wght].ttf') } },
  { test: /^ibmplexmono$/, name: 'IBM Plex Mono', faces: { regular: gf('ofl/ibmplexmono/IBMPlexMono-Regular.ttf') } },
  { test: /^spacemono$/, name: 'Space Mono', faces: { regular: gf('ofl/spacemono/SpaceMono-Regular.ttf') } },
  // More common sans families.
  { test: /^firasans$/, name: 'Fira Sans', faces: { regular: gf('ofl/firasans/FiraSans-Regular.ttf') } },
  { test: /^manrope$/, name: 'Manrope', faces: { regular: gf('ofl/manrope/Manrope[wght].ttf') } },
  { test: /^karla$/, name: 'Karla', faces: { regular: gf('ofl/karla/Karla[wght].ttf') } },
  { test: /^librefranklin$/, name: 'Libre Franklin', faces: { regular: gf('ofl/librefranklin/LibreFranklin[wght].ttf') } },
  { test: /^titilliumweb$/, name: 'Titillium Web', faces: { regular: gf('ofl/titilliumweb/TitilliumWeb-Regular.ttf') } },
  { test: /^barlow$/, name: 'Barlow', faces: { regular: gf('ofl/barlow/Barlow-Regular.ttf') } },
  { test: /^mukta$/, name: 'Mukta', faces: { regular: gf('ofl/mukta/Mukta-Regular.ttf') } },
];

function pickFace(fam: FamilyEntry, weight: number, italic: boolean): FontMatch {
  const bold = weight >= 600;
  const f = fam.faces;
  const url =
    (bold && italic && f.boldItalic) ||
    (bold && f.bold) ||
    (italic && f.italic) ||
    f.regular;
  return { url, name: fam.name };
}

/** Match a run's base font name (subset tag already stripped) + weight + italic
 *  to a bundled metric-compatible face, then (widening coverage) to a curated
 *  Google Font fetched on demand. Returns null when there's no confident match. */
export function matchFont(baseName: string, weight: number, italic: boolean): FontMatch | null {
  const n = baseName.toLowerCase().replace(/[^a-z]/g, '');
  for (const fam of FAMILIES) if (fam.test.test(n)) return pickFace(fam, weight, italic);
  for (const fam of GOOGLE_FAMILIES) if (fam.test.test(n)) return pickFace(fam, weight, italic);
  return null;
}

/** Fetch a matched font's bytes (from the hashed asset URL). */
export async function fetchFontBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`font fetch failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ── Unicode coverage + fallback ─────────────────────────────────────────────
// The bundled/GF matched faces already cover Latin, Cyrillic, Greek and common
// symbols, but NOT CJK (Han/Kana/Hangul). When the typed text has characters the
// matched (or standard-14) font can't render, fall back to a broad Noto face so
// the edit shows real glyphs instead of tofu — Noto Sans for most scripts, Noto
// Sans SC for CJK. Both OFL-1.1, fetched on demand (NOTICE covers this).
const NOTO_SANS = gf('ofl/notosans/NotoSans[wdth,wght].ttf');
const NOTO_SANS_SC = gf('ofl/notosanssc/NotoSansSC[wght].ttf');
// CJK unified ideographs + Hiragana/Katakana + Hangul + CJK symbols/fullwidth.
const CJK_RE = /[　-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;

/** Does `fontBytes` have a glyph for every (non-space) char in `text`? (fontkit) */
async function covers(fontBytes: Uint8Array, text: string): Promise<boolean> {
  try {
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = fontkit.create(fontBytes as any) as any;
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) continue;
      const has = typeof f.hasGlyphForCodePoint === 'function' ? f.hasGlyphForCodePoint(cp) : true;
      if (!has) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export interface ResolvedFont {
  bytes: Uint8Array;
  name: string;
  /** true = the run's own/matched typeface (kept); false = a Unicode fallback. */
  typefacePreserved: boolean;
}

/**
 * Resolve the best embeddable font for editing `text` in a run's face:
 *   1. the genuine installed system font (desktop only, via the bridge),
 *   2. the bundled / Google-Font metric-compatible match,
 *   3. a broad Noto fallback when 1–2 don't cover the typed characters and the
 *      text needs it (`needsUnicode`) — so CJK / uncommon scripts still render.
 * Each candidate is coverage-checked before use. Returns null to fall back to the
 * standard-14 substitute (Latin/WinAnsi only) — unchanged for plain-Latin text.
 */
export async function resolveEditFont(
  baseName: string,
  weight: number,
  italic: boolean,
  text: string,
  needsUnicode: boolean,
): Promise<ResolvedFont | null> {
  // 1. Desktop: the genuine installed face (best fidelity), if the shell exposes it.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const desk = (globalThis as any).__deskApp__;
    if (desk?.resolveSystemFont) {
      const bytes: Uint8Array | null = await desk.resolveSystemFont(baseName, weight, italic);
      if (bytes && bytes.length > 0 && (await covers(bytes, text))) {
        return { bytes, name: baseName, typefacePreserved: true };
      }
    }
  } catch {
    /* fall through to bundled/GF */
  }

  // 2. Bundled / Google Font metric-compatible match.
  const m = matchFont(baseName, weight, italic);
  if (m) {
    try {
      const bytes = await fetchFontBytes(m.url);
      if (await covers(bytes, text)) return { bytes, name: m.name, typefacePreserved: true };
    } catch {
      /* fall through */
    }
  }

  // 3. Unicode fallback (only when the text actually needs one).
  if (needsUnicode) {
    const cjk = CJK_RE.test(text);
    try {
      const bytes = await fetchFontBytes(cjk ? NOTO_SANS_SC : NOTO_SANS);
      if (await covers(bytes, text)) {
        return { bytes, name: cjk ? 'Noto Sans SC' : 'Noto Sans', typefacePreserved: false };
      }
    } catch {
      /* fall through */
    }
  }

  return null;
}
