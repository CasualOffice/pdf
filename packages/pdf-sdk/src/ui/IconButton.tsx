/**
 * Accessible icon button for the viewer chrome.
 *
 * Design language: rounded, no border — state is shown by background color
 * separation + icon fill, not outlines. WCAG 2.2: ≥36px target (> the 24px
 * minimum of 2.5.8), always has an accessible name (`label`), exposes toggle
 * state via `aria-pressed`, and keeps a visible focus ring (2.4.7).
 */
import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

interface IconButtonProps {
  icon: IconName;
  /** Accessible name — required because the button is icon-only. */
  label: string;
  onClick?: () => void;
  /** When set, the button is a toggle: `aria-pressed` + the filled icon variant. */
  active?: boolean;
  disabled?: boolean;
  /** Optional adornment (e.g. a count badge) rendered after the icon. */
  children?: ReactNode;
}

export function IconButton({ icon, label, onClick, active, disabled, children }: IconButtonProps) {
  const isToggle = active !== undefined;
  return (
    <button
      type="button"
      className="cpdf-iconbtn"
      data-active={active ? 'true' : undefined}
      aria-label={label}
      aria-pressed={isToggle ? !!active : undefined}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} filled={!!active} />
      {children}
    </button>
  );
}
