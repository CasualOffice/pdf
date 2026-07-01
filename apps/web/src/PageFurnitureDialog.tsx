// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { Icon, type CasualPdfApi } from '@casualoffice/pdf';

type Tab = 'watermark' | 'headerfooter' | 'bates';

/**
 * Phase 5 — Page furniture dialog: Watermark, Header & Footer, Bates Numbers.
 * Each tab collects options and calls the lazy-loaded page-furniture module from
 * the SDK. Results flow through the host's onDocumentReplaced so the version
 * undo stack and autosave both fire.
 */
export function PageFurnitureDialog({
  api,
  onDocumentReplaced,
  onClose,
}: {
  api: CasualPdfApi | null;
  onDocumentReplaced: (bytes: Uint8Array) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('watermark');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  // Watermark state
  const [wmText, setWmText] = useState('DRAFT');
  const [wmOpacity, setWmOpacity] = useState(30);
  const [wmRotation, setWmRotation] = useState(45);
  const [wmSize, setWmSize] = useState(60);
  const [wmColor, setWmColor] = useState('#808080');

  // Header/footer state
  const [hfHeaderLeft, setHfHeaderLeft] = useState('');
  const [hfHeaderCenter, setHfHeaderCenter] = useState('');
  const [hfHeaderRight, setHfHeaderRight] = useState('');
  const [hfFooterLeft, setHfFooterLeft] = useState('');
  const [hfFooterCenter, setHfFooterCenter] = useState('{page} / {pages}');
  const [hfFooterRight, setHfFooterRight] = useState('');
  const [hfFontSize, setHfFontSize] = useState(10);
  const [hfSkipFirst, setHfSkipFirst] = useState(false);

  // Bates state
  const [bPrefix, setBPrefix] = useState('');
  const [bStart, setBStart] = useState(1);
  const [bDigits, setBDigits] = useState(6);
  const [bPosition, setBPosition] = useState<'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'>('bottom-right');
  const [bFontSize, setBFontSize] = useState(10);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const apply = async () => {
    setError(null);
    if (!api) { setError('Document not ready.'); return; }
    setBusy(true);
    try {
      const pdf = await api.getBytes();
      if (!pdf) throw new Error('Could not read document bytes.');
      const mod = await import('@casualoffice/pdf/page-furniture');

      let out: Uint8Array;
      if (tab === 'watermark') {
        if (!wmText.trim()) throw new Error('Enter watermark text.');
        out = await mod.addWatermark(pdf, {
          text: wmText.trim(),
          opacity: wmOpacity / 100,
          rotation: wmRotation,
          fontSize: wmSize,
          color: wmColor,
        });
      } else if (tab === 'headerfooter') {
        const hasHeader = hfHeaderLeft || hfHeaderCenter || hfHeaderRight;
        const hasFooter = hfFooterLeft || hfFooterCenter || hfFooterRight;
        if (!hasHeader && !hasFooter) throw new Error('Enter at least one header or footer field.');
        out = await mod.addHeaderFooter(pdf, {
          header: hasHeader ? { left: hfHeaderLeft || undefined, center: hfHeaderCenter || undefined, right: hfHeaderRight || undefined } : undefined,
          footer: hasFooter ? { left: hfFooterLeft || undefined, center: hfFooterCenter || undefined, right: hfFooterRight || undefined } : undefined,
          fontSize: hfFontSize,
          skipFirstPage: hfSkipFirst,
        });
      } else {
        out = await mod.addBatesNumbers(pdf, {
          prefix: bPrefix || undefined,
          startNumber: bStart,
          digits: bDigits,
          position: bPosition,
          fontSize: bFontSize,
        });
      }

      onDocumentReplaced(out);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply.');
      setBusy(false);
    }
  };

  return (
    <div className="dialog__scrim" role="presentation" onClick={() => !busy && onClose()}>
      <div
        className="dialog dialog--form pf-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Page furniture"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="signdlg__head">
          <Icon name="text-tool" size={20} />
          <h2 className="dialog__title" style={{ margin: 0 }}>Page Furniture</h2>
        </div>

        {/* Tab strip */}
        <div className="pf-tabs" role="tablist">
          {([
            { id: 'watermark', label: 'Watermark' },
            { id: 'headerfooter', label: 'Header & Footer' },
            { id: 'bates', label: 'Bates Numbers' },
          ] as const).map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className="pf-tab"
              data-active={tab === id ? 'true' : undefined}
              onClick={() => { setTab(id); setError(null); }}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'watermark' && (
          <div className="pf-panel">
            <label className="signdlg__field">
              <span>Text</span>
              <input ref={firstRef} value={wmText} onChange={(e) => setWmText(e.target.value)} placeholder="DRAFT" />
            </label>
            <div className="pf-row">
              <label className="signdlg__field">
                <span>Opacity ({wmOpacity}%)</span>
                <input type="range" min={5} max={80} value={wmOpacity} onChange={(e) => setWmOpacity(+e.target.value)} />
              </label>
              <label className="signdlg__field">
                <span>Rotation ({wmRotation}°)</span>
                <input type="range" min={0} max={90} step={5} value={wmRotation} onChange={(e) => setWmRotation(+e.target.value)} />
              </label>
            </div>
            <div className="pf-row">
              <label className="signdlg__field">
                <span>Font size ({wmSize}pt)</span>
                <input type="range" min={20} max={150} step={5} value={wmSize} onChange={(e) => setWmSize(+e.target.value)} />
              </label>
              <label className="signdlg__field">
                <span>Color</span>
                <input type="color" value={wmColor} onChange={(e) => setWmColor(e.target.value)} style={{ height: '32px', padding: '2px' }} />
              </label>
            </div>
          </div>
        )}

        {tab === 'headerfooter' && (
          <div className="pf-panel">
            <p className="pf-hint">Use <code>{'{page}'}</code>, <code>{'{pages}'}</code>, <code>{'{date}'}</code> as placeholders.</p>
            <fieldset className="pf-fieldset">
              <legend>Header</legend>
              <div className="pf-trio">
                <label><span>Left</span><input ref={firstRef} value={hfHeaderLeft} onChange={(e) => setHfHeaderLeft(e.target.value)} placeholder="Left" /></label>
                <label><span>Center</span><input value={hfHeaderCenter} onChange={(e) => setHfHeaderCenter(e.target.value)} placeholder="Center" /></label>
                <label><span>Right</span><input value={hfHeaderRight} onChange={(e) => setHfHeaderRight(e.target.value)} placeholder="Right" /></label>
              </div>
            </fieldset>
            <fieldset className="pf-fieldset">
              <legend>Footer</legend>
              <div className="pf-trio">
                <label><span>Left</span><input value={hfFooterLeft} onChange={(e) => setHfFooterLeft(e.target.value)} placeholder="Left" /></label>
                <label><span>Center</span><input value={hfFooterCenter} onChange={(e) => setHfFooterCenter(e.target.value)} placeholder="{page} / {pages}" /></label>
                <label><span>Right</span><input value={hfFooterRight} onChange={(e) => setHfFooterRight(e.target.value)} placeholder="Right" /></label>
              </div>
            </fieldset>
            <div className="pf-row">
              <label className="signdlg__field">
                <span>Font size ({hfFontSize}pt)</span>
                <input type="range" min={6} max={16} value={hfFontSize} onChange={(e) => setHfFontSize(+e.target.value)} />
              </label>
              <label className="signdlg__field pf-check">
                <input type="checkbox" checked={hfSkipFirst} onChange={(e) => setHfSkipFirst(e.target.checked)} />
                <span>Skip first page</span>
              </label>
            </div>
          </div>
        )}

        {tab === 'bates' && (
          <div className="pf-panel">
            <div className="pf-row">
              <label className="signdlg__field">
                <span>Prefix</span>
                <input ref={firstRef} value={bPrefix} onChange={(e) => setBPrefix(e.target.value)} placeholder="CASE-" />
              </label>
              <label className="signdlg__field">
                <span>Start number</span>
                <input type="number" min={0} value={bStart} onChange={(e) => setBStart(Math.max(0, +e.target.value))} />
              </label>
            </div>
            <div className="pf-row">
              <label className="signdlg__field">
                <span>Digits (zero-padded)</span>
                <input type="number" min={1} max={12} value={bDigits} onChange={(e) => setBDigits(Math.max(1, +e.target.value))} />
              </label>
              <label className="signdlg__field">
                <span>Font size ({bFontSize}pt)</span>
                <input type="range" min={6} max={16} value={bFontSize} onChange={(e) => setBFontSize(+e.target.value)} />
              </label>
            </div>
            <label className="signdlg__field">
              <span>Position</span>
              <select value={bPosition} onChange={(e) => setBPosition(e.target.value as typeof bPosition)}>
                <option value="bottom-right">Bottom right</option>
                <option value="bottom-left">Bottom left</option>
                <option value="top-right">Top right</option>
                <option value="top-left">Top left</option>
              </select>
            </label>
            <p className="pf-hint">
              Preview: <code>{bPrefix}{String(bStart).padStart(bDigits, '0')}</code>
            </p>
          </div>
        )}

        {error && <p className="signdlg__error" role="alert">{error}</p>}

        <div className="signdlg__actions">
          <button type="button" className="signdlg__btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="signdlg__btn signdlg__btn--primary" onClick={apply} disabled={busy}>
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
