<!-- Copyright (c) 2026 Casual Office. SPDX-License-Identifier: Apache-2.0 -->

# Text editing — where it is, and the pragmatic path forward

Status: **design / decision doc** (2026-07-04). Written after a multi-agent
assessment rated the current in-place text editor *demo-grade*. Nothing here is
built yet; this scopes the options so a direction can be confirmed before coding.

## 1. Where it is today

The shipped **Edit text** tool ([`textedit-pdfium.ts`](../packages/pdf-sdk/src/textedit-pdfium.ts))
edits one reconstructed run at a time via PDFium text objects
(`FPDFText_SetText` → `FPDFPage_GenerateContent` → `FPDF_SaveAsCopy`). It works
in the lab case (ASCII, non-subsetted, absolutely-positioned Latin) and degrades
in the cases that dominate real PDFs:

- **Substitutes a standard-14 font on nearly every real document.** Embedded
  fonts are subsets (`ABCDEF+` tag per ISO 32000 §9.6.4); their glyphs can't be
  extended, so any edit swaps the typeface. This is the headline "barely
  accurate" complaint.
- **No reflow.** Replacing a run's text doesn't re-wrap the paragraph; longer
  text overflows, shorter leaves a gap.
- **Regenerates the whole page content stream**, so justification/kerning/tab
  alignment can collapse and neighbours can shift.
- Trust items (**now fixed**, PR #11): fail-closed on unencodable substitution;
  a `residual` warning when a suppressed run was moved off-page and its glyphs
  remain extractable (→ use Redaction to remove).

**Root cause (not bugs):** PDF stores *positioned glyphs, not text*, and
embedded fonts are *subsets missing the glyphs you type*. Real editing therefore
needs layout reconstruction + font re-subsetting — the layer PDF deliberately
discarded, i.e. "Adobe's moat". This doc does **not** try to build that; it makes
the *honest* scope good.

## 2. Goal

"**Quick text edits, done right**": fix a typo, a date, a number, a short field —
predictably, without collateral damage to the rest of the page, and honest about
what it can't do (reflow, exotic scripts, guaranteed typeface match).

## 3. Options

| # | Approach | Fixes | Can't | Effort | Production for its scope? |
|---|----------|-------|-------|--------|---------------------------|
| **A** | **Overlay-replace** — cover the old run, place matched new text on top | Collateral damage, removal-leak, predictability | Perfect typeface match, reflow | **S–M** | ✅ |
| **C** | **Subset re-embed** (HarfBuzz-WASM) — add typed glyphs to the original font | The typeface swap (the #1 complaint) | Reflow; needs the full source font | **L** | 🟡 partial |
| **D** | **True reflow** — paragraph reconstruction + Knuth-Plass line-break | Real Tier-2 intra-box reflow | Cross-block/page reflow; long tail | **XL (~2–4 mo)** | ✅ (intra-box) |

### Recommended sequence: **A now → C when justified → D only as a deliberate bet.**

## 4. Option A — overlay-replace (the proposed build)

**Model.** Instead of mutating the content stream, treat an edit as: *hide the
old run, draw new text over it.* Reuses primitives Casual PDF already ships.

**UX flow**

1. In **Edit text**, clicking a run opens the same inline input (unchanged).
2. On commit, instead of `editTextRun`:
   - Sample the run's **background colour** (render the page region behind the
     run — reuse `useRenderCapability().renderPage`, as redaction already does —
     and read the modal pixel just outside the glyph boxes).
   - Draw an **opaque rectangle** of that colour over the run's bounds.
   - Place a **free-text object** on top: the new string, at the run's baseline,
     with the matched size/colour and the closest standard font (same
     `pickStandardFont` mapping).
3. Two commit modes:
   - **Overlay (default)** — non-destructive; original bytes remain (disclosed).
   - **Bake / secure** — route through the existing flatten path
     ([`redact.ts`](../packages/pdf-sdk/src/redact.ts)) so the old text is truly
     gone (for renaming sensitive values). Reuses redaction wholesale.

**Why it's better than the current path**

- No whole-page content-stream regeneration → **no reflow/justification damage,
  no neighbour shifts**.
- The **residual-leak disappears** in Bake mode; in Overlay mode it's disclosed
  (same honesty bar as today).
- Predictable and simple — the edit is a localized object, not a global rewrite.

**What it still can't do**

- The overlay text uses a substituted standard font (Option C fixes this).
- No reflow (Option D).
- Background sampling is imperfect over gradients/images → offer a manual colour
  override and prefer Bake mode there.

**Implementation sketch** (all in `packages/pdf-sdk`, mirrors existing tools)

- `src/textedit-overlay.ts` — `buildOverlayEdit(bytes, pageIndex, rect, text,
  style, {bake})` using **pdf-lib** (already a dependency; same lazy-chunk as
  redact/merge). Draw rect + `drawText`; in bake mode call the redaction flatten.
- `chrome.tsx` — the **Edit text** commit calls the overlay path; add a
  Overlay/Bake toggle to the text-edit banner; background-colour sampling via the
  render capability (the redaction code already renders page regions).
- Verify headless (new `verify-textedit-overlay.mjs`): edit a value → the new
  text is in the output and searchable; Bake mode → the old value is gone from
  the bytes (UX-S5-style extract assertion).

**Estimate:** ~1–2 focused sessions. Risk: low (composed from shipped pieces).

## 5. Option C — subset re-embed (the accuracy upgrade)

When the full source font is available (system/webfont), collect the codepoints
the edited run needs and `hb-subset` a new subset that includes the typed glyphs,
then rewrite the font dict / `Widths` / `ToUnicode`. Keeps the **original
typeface** — kills the #1 complaint for single-run edits. Reference pattern:
fontTools/uharfbuzz (fpdf2 does exactly this); on our stack a HarfBuzz-WASM or a
Rust subsetter in `casual-pdf-core`. **L (~3–6 wks).** Still no reflow. Do this
*after* A proves the interaction, and only if text-edit stays a priority.

## 6. Option D — true reflow (explicit research bet, not committed)

Cluster PDFium glyph positions into words→lines→paragraphs, measure with real
advance widths, re-break with `tex-linebreak` (MIT), regenerate the `BT…ET`
block. This is the actual architecture behind Acrobat/Foxit/Apryse/Nutrient —
and the multi-month bet they charge five figures for. Scope to **intra-box**
reflow first; depends on C for glyphs. **XL.** Start only on strong user demand.

## 7. Decision

- Keep the honest **"Quick text edits"** framing (done, PR #11).
- Build **Option A** as the primary quick-edit path (proposed here).
- Revisit **C** as the accuracy upgrade; treat **D** as a deliberate research
  bet, not a roadmap commitment.

Confirm Option A and it becomes the next implementation PR.
