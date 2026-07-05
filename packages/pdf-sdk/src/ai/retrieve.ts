// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * RAG-lite retrieval over a PDF's text — pure JS, no embeddings or vector store
 * (that's the later Phase-B RAG in docs/AI.md §4). This lets the AI answer a
 * question from ANYWHERE in a large document in one `search_document` tool call
 * instead of reading pages one by one, and returns page numbers so answers can
 * cite their source.
 *
 * Pipeline: chunk each page's text into passages → rank passages against the
 * query with Okapi BM25 → return the top-k with their page index. Deterministic
 * and fully unit-testable.
 */

/** A retrievable passage tied to the page it came from (zero-based). */
export interface DocChunk {
  page: number;
  text: string;
}

// Small English stoplist — keeps BM25 idf meaningful for common words.
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'with', 'as', 'by',
  'at', 'be', 'this', 'that', 'are', 'was', 'were', 'from', 'but', 'not', 'they', 'you', 'we',
]);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Split each page's text into passages of up to ~`maxChars`, breaking on
 * paragraph/line boundaries so a passage stays coherent. Each passage keeps its
 * page index for citations.
 */
export function chunkPages(pages: { pageIndex: number; text: string }[], maxChars = 900): DocChunk[] {
  const chunks: DocChunk[] = [];
  for (const p of pages) {
    const paras = p.text
      .split(/\n{2,}|\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    let buf = '';
    const flush = () => {
      if (buf) chunks.push({ page: p.pageIndex, text: buf });
      buf = '';
    };
    for (const para of paras) {
      if (buf && buf.length + para.length + 1 > maxChars) flush();
      buf = buf ? `${buf}\n${para}` : para;
      if (buf.length >= maxChars) flush();
    }
    flush();
  }
  return chunks;
}

/**
 * Rank chunks against `query` with Okapi BM25 and return the top-k (score > 0).
 * Standard k1=1.5, b=0.75.
 */
export function rankChunks(chunks: DocChunk[], query: string, k = 6): DocChunk[] {
  const qTerms = [...new Set(tokenize(query))];
  if (qTerms.length === 0 || chunks.length === 0) return [];

  const docs = chunks.map((c) => tokenize(c.text));
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N || 1;

  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);

  const k1 = 1.5;
  const b = 0.75;
  const scored = chunks.map((c, i) => {
    const d = docs[i];
    const dl = d.length;
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const q of qTerms) {
      const f = tf.get(q) ?? 0;
      if (f === 0) continue;
      const n = df.get(q) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + b * (dl / avgdl)));
    }
    return { chunk: c, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.chunk);
}

// ── Dense / hybrid retrieval (embeddings RAG, docs/AI.md §4) ──────────────────
//
// BM25 is lexical: it misses passages that answer a question in different words
// ("how do cells make energy?" vs "mitochondria produce ATP"). An embedding model
// scores by meaning. Per the two-mode architecture, the model itself runs in the
// desktop llama.cpp worker or the collab server — NOT bundled in the client — so
// this module takes an injectable `Embedder`. When none is supplied (plain web),
// retrieval degrades to BM25. When one is, we fuse lexical + dense rankings with
// Reciprocal Rank Fusion, which is robust without score normalization.

/** Turns texts into vectors. Supplied by the runtime (desktop worker / collab). */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/** Cosine similarity of two equal-length vectors (0 if either is degenerate). */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Reciprocal Rank Fusion — merge several ranked lists into one. An item's score
 * is Σ 1/(rrfK + rank) across the lists it appears in; higher wins. `keyOf` gives
 * each item a stable identity across lists. Standard rrfK=60.
 */
export function reciprocalRankFusion<T>(rankings: T[][], keyOf: (t: T) => string, rrfK = 60): T[] {
  const score = new Map<string, number>();
  const item = new Map<string, T>();
  for (const list of rankings) {
    list.forEach((t, i) => {
      const key = keyOf(t);
      score.set(key, (score.get(key) ?? 0) + 1 / (rrfK + i + 1));
      if (!item.has(key)) item.set(key, t);
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => item.get(key) as T);
}

const chunkKey = (c: DocChunk): string => `${c.page}:${c.text}`;

/**
 * Retrieve the top-k chunks for `query`. With an `embedder`, fuse BM25 with dense
 * cosine ranking via RRF (semantic + lexical). Without one — or if embedding
 * throws — fall back to BM25 alone. Async because embedding is.
 */
export async function hybridRankChunks(
  chunks: DocChunk[],
  query: string,
  k = 6,
  embedder?: Embedder,
): Promise<DocChunk[]> {
  const lexical = rankChunks(chunks, query, chunks.length);
  if (!embedder) return lexical.slice(0, k);
  try {
    const [queryVec] = await embedder([query]);
    const chunkVecs = await embedder(chunks.map((c) => c.text));
    const dense = chunks
      .map((c, i) => ({ c, s: cosineSimilarity(queryVec, chunkVecs[i]) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    return reciprocalRankFusion([lexical, dense], chunkKey).slice(0, k);
  } catch {
    return lexical.slice(0, k);
  }
}
