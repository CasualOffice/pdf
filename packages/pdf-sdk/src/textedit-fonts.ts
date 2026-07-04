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
 *   - Arial / Helvetica → Arimo (variable — only regular + italic bundled; bold
 *     falls back to regular pending static instances).
 *   - Calibri → Carlito, Times → Tinos, Courier → Cousine, Cambria → Caladea
 *     (all static, full regular/bold/italic/bold-italic).
 * Verdana/Georgia have no clean metric-compatible open match → standard fallback.
 */
import arimoUrl from './fonts/Arimo.ttf?url';
import arimoItalicUrl from './fonts/Arimo-Italic.ttf?url';
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
    faces: { regular: arimoUrl, italic: arimoItalicUrl },
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

/** Match a run's base font name (subset tag already stripped) + weight + italic
 *  to a bundled metric-compatible face, or null when there's no confident match. */
export function matchFont(baseName: string, weight: number, italic: boolean): FontMatch | null {
  const n = baseName.toLowerCase().replace(/[^a-z]/g, '');
  for (const fam of FAMILIES) {
    if (!fam.test.test(n)) continue;
    const bold = weight >= 600;
    const f = fam.faces;
    const url =
      (bold && italic && f.boldItalic) ||
      (bold && f.bold) ||
      (italic && f.italic) ||
      f.regular;
    return { url, name: fam.name };
  }
  return null;
}

/** Fetch a matched font's bytes (from the hashed asset URL). */
export async function fetchFontBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`font fetch failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
