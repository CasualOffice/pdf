# @casualoffice/pdf

Embeddable **PDF viewer + editor** SDK — a high-fidelity PDFium-WASM viewer with
`view` / `edit` / `suggest` modes, annotation + form + e-signature editing, true
redaction, page ops, threaded comments, and optional real-time co-editing.

> **Status:** consumed today as workspace **source** by the Casual PDF app. The
> dependency shape is publish-correct (see _Peer dependencies_); a distributable
> `dist` build is driven by the first external embedder.

## Requirements

This SDK is built for a **Vite** (or Vite-compatible) toolchain: it imports its
WASM (`?url`), bundled fonts (`?url`), and CSS directly, which a Vite bundler
resolves. Consuming it outside a Vite-style asset pipeline is not supported yet.

## Install

```bash
pnpm add @casualoffice/pdf react react-dom yjs
# only if you use collaboration:
pnpm add @hocuspocus/provider
```

### Peer dependencies

| Package                 | Required?             | Why                                                            |
| ----------------------- | --------------------- | -------------------------------------------------------------- |
| `react`, `react-dom`    | yes (>=18)            | the viewer is a React component                                |
| `yjs`                   | **yes**               | the CRDT overlay backs annotations/comments/signing — even solo (a local `Y.Doc`). The host owns **one** `yjs` instance so there's no dual-instance CRDT breakage. |
| `@hocuspocus/provider`  | optional              | only the live co-editing transport needs it; solo/embed usage doesn't |

## Quick start

```tsx
import { CasualPdf } from '@casualoffice/pdf';

export function Viewer() {
  return <CasualPdf src="https://example.com/report.pdf" mode="view" />;
}
```

### Key props (`CasualPdfProps`)

| Prop                 | Type                          | Notes                                                                 |
| -------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `src`                | `string`                      | PDF source URL (required)                                             |
| `mode`               | `'view' \| 'edit' \| 'suggest'` | defaults to `view`                                                  |
| `onModeChange`       | `(mode) => void`              | omit → the mode control renders read-only                             |
| `collab`             | `CollabConfig`                | attach to a room → co-editing; omit → solo, persisted locally         |
| `identity`           | `{ name; color? }`            | authorship + presence                                                 |
| `role`               | `'viewer' \| 'commenter' \| 'editor' \| 'signer'` | clamps the effective mode to what the role permits (UI reflection of the server-enforced right) |
| `apiRef`             | `MutableRefObject<CasualPdfApi>` | imperative handle for host menus (see below)                       |
| `onEdited`           | `() => void`                  | first edit — for an unsaved-changes guard                            |
| `onDocumentReplaced` | `(bytes) => void`             | bytes replaced by redaction/organize/text-edit — reload with these   |

## Modes & roles

- **Modes:** `view` (read-only) · `suggest` (proposals reviewed to applied/removed) · `edit` (direct).
- **Roles → modes** (`roleToMode` / `allowedModes` / `clampMode`, exported): `viewer→view`, `commenter→suggest`, `editor`/`signer`→`edit`. `clampMode(mode, role)` is defense-in-depth — a viewer asked to `edit` renders `view`. **The collab server is the real enforcer** (`connection.readOnly`); the client role is a reflection, not the security boundary.

## Collaboration (optional)

```tsx
<CasualPdf
  src={url}
  mode="edit"
  collab={{ url: 'wss://collab.example/yjs', room: 'doc-123', token: shareToken }}
  identity={{ name: 'Ada', color: '#4658ff' }}
  role="editor"
/>
```

Co-editing rides `services/collab` (Yjs/Hocuspocus). Annotations, comments, form
values, cursors, presence, and signing sync peer→peer. Omit `collab` for solo
(local persistence) — same code path, a runtime flag.

## Imperative API (`apiRef`)

```tsx
const api = useRef<CasualPdfApi | null>(null);
<CasualPdf src={url} apiRef={api} mode="edit" />;
// later, from a host menu:
api.current?.download();
api.current?.setTool('highlight');
const bytes = await api.current?.getBytes();
```

Includes `download`, `undo`/`redo`/`canUndo`/`canRedo`, `deleteSelection`,
`setTool`, `openSearch`, `openSignature`, `getBytes`, `pageCount`, `gotoPage`,
`getOutline`, `extractText`.

## Headless utilities (subpath exports)

Byte-in → byte-out operations, no viewer needed (each lazy-loads its heavy deps):

| Import                                  | Does                                             |
| --------------------------------------- | ------------------------------------------------ |
| `@casualoffice/pdf/sign`                | PKCS#7 e-signature (self-signed or your `.p12`)   |
| `@casualoffice/pdf/verify`              | verify a signature + read signer/validity         |
| `@casualoffice/pdf/merge`               | merge/insert PDFs                                 |
| `@casualoffice/pdf/restrict`            | AES-256 permission restriction                    |
| `@casualoffice/pdf/page-furniture`      | watermark / header-footer / Bates numbering       |
| `@casualoffice/pdf/extract`             | extract page text                                 |
| `@casualoffice/pdf/signing-certificate` | build a Certificate of Completion                 |
| `@casualoffice/pdf/ai`                  | "Ask this PDF" agent surface (desktop/collab)     |

There's also a headless **MCP server** (`casual-pdf-mcp`) built via
`pnpm --filter @casualoffice/pdf build:mcp`.

## License

Apache-2.0. Bundled metric-compatible fonts (Arimo, Tinos, Cousine, Carlito,
Caladea) ship under OFL-1.1 — see the repo `NOTICE`.
