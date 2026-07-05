// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * AcroForm read + fill via pdf-lib — pure bytes in, bytes out (like merge/redact),
 * so it runs in the browser or Node and is unit-testable. The EmbedPDF form
 * plugin renders fields interactively but is render-only; this is the writer the
 * AI form-fill tools need (docs/AI.md §3). pdf-lib is lazy-loaded (shared chunk).
 */

export interface FormFieldInfo {
  name: string;
  /** 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionlist' | 'button' | 'signature' | 'unknown' */
  type: string;
  /** Current value: text string, checkbox boolean, or selected option(s); null if empty. */
  value: string | boolean | string[] | null;
  /** Allowed options for radio / dropdown / option-list fields. */
  options?: string[];
}

export interface FillValue {
  name: string;
  value: string | boolean;
}

/** List the AcroForm fields with their type, current value, and options. */
export async function listFormFields(bytes: Uint8Array): Promise<FormFieldInfo[]> {
  const lib = await import('pdf-lib');
  const doc = await lib.PDFDocument.load(bytes);
  const form = doc.getForm();
  return form.getFields().map((f) => describeField(f, lib));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeField(f: any, lib: any): FormFieldInfo {
  const name = f.getName();
  if (f instanceof lib.PDFTextField) {
    return { name, type: 'text', value: f.getText() ?? null };
  }
  if (f instanceof lib.PDFCheckBox) {
    return { name, type: 'checkbox', value: f.isChecked() };
  }
  if (f instanceof lib.PDFRadioGroup) {
    return { name, type: 'radio', value: f.getSelected() ?? null, options: f.getOptions() };
  }
  if (f instanceof lib.PDFDropdown) {
    return { name, type: 'dropdown', value: f.getSelected()?.[0] ?? null, options: f.getOptions() };
  }
  if (f instanceof lib.PDFOptionList) {
    return { name, type: 'optionlist', value: f.getSelected() ?? [], options: f.getOptions() };
  }
  if (f instanceof lib.PDFButton) return { name, type: 'button', value: null };
  if (f instanceof lib.PDFSignature) return { name, type: 'signature', value: null };
  return { name, type: 'unknown', value: null };
}

/**
 * Fill AcroForm fields by name and return the new bytes. Text fields take the
 * string; checkboxes take a boolean; radio/dropdown take the option to select.
 * Unknown or missing fields are skipped and reported in `skipped`.
 */
export async function fillFormFields(
  bytes: Uint8Array,
  values: FillValue[],
): Promise<{ bytes: Uint8Array; filled: string[]; skipped: string[] }> {
  const lib = await import('pdf-lib');
  const doc = await lib.PDFDocument.load(bytes);
  const form = doc.getForm();
  const filled: string[] = [];
  const skipped: string[] = [];
  for (const { name, value } of values) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let field: any;
    try {
      field = form.getFieldMaybe ? form.getFieldMaybe(name) : form.getField(name);
    } catch {
      field = undefined;
    }
    if (!field) {
      skipped.push(name);
      continue;
    }
    try {
      if (field instanceof lib.PDFTextField) field.setText(String(value));
      else if (field instanceof lib.PDFCheckBox) (value ? field.check() : field.uncheck());
      else if (field instanceof lib.PDFRadioGroup || field instanceof lib.PDFDropdown) field.select(String(value));
      else if (field instanceof lib.PDFOptionList) field.select(String(value));
      else {
        skipped.push(name);
        continue;
      }
      filled.push(name);
    } catch {
      skipped.push(name);
    }
  }
  const out = await doc.save();
  return { bytes: out, filled, skipped };
}
