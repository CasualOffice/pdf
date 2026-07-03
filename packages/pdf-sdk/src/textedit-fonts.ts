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
 * PR1 covers Arial/Helvetica → Arimo. Weight is not yet differentiated (the
 * bundled Arimo is a variable font embedded at its default ~Regular weight);
 * per-weight static instances are a follow-up. Further families
 * (Tinos/Cousine/Carlito/Caladea) land in PR2.
 */
import arimoUrl from './fonts/Arimo.ttf?url';
import arimoItalicUrl from './fonts/Arimo-Italic.ttf?url';

export interface FontMatch {
  /** Hashed asset URL of the matched font. */
  url: string;
  /** Display name of the matched family (for tooltips / notes). */
  name: string;
}

/** Match a run's base font name (subset tag already stripped) to a bundled
 *  metric-compatible font, or null when there's no confident match. */
export function matchFont(baseName: string, italic: boolean): FontMatch | null {
  const n = baseName.toLowerCase().replace(/[^a-z]/g, '');
  // Arial / Helvetica / ArialMT → Arimo (Croscore; metric-compatible with Arial).
  if (/(^|.)arial|helvetica|^arimo/.test(n)) {
    return { url: italic ? arimoItalicUrl : arimoUrl, name: 'Arimo' };
  }
  return null;
}

/** Fetch a matched font's bytes (from the hashed asset URL). */
export async function fetchFontBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`font fetch failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
