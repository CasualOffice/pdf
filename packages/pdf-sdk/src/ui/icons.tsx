/**
 * SVG icon set for the viewer chrome. Per the project's design language: inline
 * SVG only (no emoji, no icon font), with a `filled` variant used to signal an
 * active/selected toggle and an outline variant for the inactive state. Icons
 * inherit `currentColor` so the button controls their color, and use a 24-unit
 * viewBox sized down via the `size` prop.
 */
import type { SVGProps } from 'react';

export type IconName =
  | 'chevron-left'
  | 'chevron-right'
  | 'zoom-in'
  | 'zoom-out'
  | 'fit-width'
  | 'fit-page'
  | 'rotate'
  | 'search'
  | 'thumbnails'
  | 'outline'
  | 'hand'
  | 'fullscreen-enter'
  | 'fullscreen-exit'
  | 'spread'
  | 'sun'
  | 'moon'
  | 'close'
  | 'eye'
  | 'pencil'
  | 'suggest'
  | 'chevron-down'
  | 'check'
  | 'scroll-h';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Use the solid variant to indicate an active toggle. Outline otherwise. */
  filled?: boolean;
  size?: number;
}

// Outline defaults: no fill, 1.8 stroke, round joins. Filled icons set fill.
const OUTLINE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
const SOLID = { fill: 'currentColor', stroke: 'none' };

function paths(name: IconName, filled: boolean) {
  switch (name) {
    case 'chevron-left':
      return <polyline points="15 5 8 12 15 19" {...OUTLINE} />;
    case 'chevron-right':
      return <polyline points="9 5 16 12 9 19" {...OUTLINE} />;
    case 'zoom-in':
      return (
        <g {...OUTLINE}>
          <circle cx="11" cy="11" r="7" />
          <line x1="11" y1="8" x2="11" y2="14" />
          <line x1="8" y1="11" x2="14" y2="11" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </g>
      );
    case 'zoom-out':
      return (
        <g {...OUTLINE}>
          <circle cx="11" cy="11" r="7" />
          <line x1="8" y1="11" x2="14" y2="11" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </g>
      );
    case 'fit-width':
      return (
        <g {...(filled ? SOLID : OUTLINE)}>
          {filled ? <rect x="3" y="6" width="18" height="12" rx="2" /> : <rect x="3" y="6" width="18" height="12" rx="2" />}
          <g {...OUTLINE} stroke={filled ? 'var(--color-text-on-accent, #fff)' : 'currentColor'}>
            <polyline points="8 9 5 12 8 15" />
            <polyline points="16 9 19 12 16 15" />
          </g>
        </g>
      );
    case 'fit-page':
      return (
        <g>
          <rect x="5" y="3" width="14" height="18" rx="2" {...(filled ? SOLID : OUTLINE)} />
          <g {...OUTLINE} stroke={filled ? 'var(--color-text-on-accent, #fff)' : 'currentColor'}>
            <polyline points="9 8 12 5 15 8" />
            <polyline points="9 16 12 19 15 16" />
          </g>
        </g>
      );
    case 'rotate':
      return (
        <g {...OUTLINE}>
          <path d="M20 11a8 8 0 1 0-2.3 5.7" />
          <polyline points="20 5 20 11 14 11" />
        </g>
      );
    case 'search':
      return filled ? (
        <g>
          <circle cx="11" cy="11" r="7" {...SOLID} />
          <line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </g>
      ) : (
        <g {...OUTLINE}>
          <circle cx="11" cy="11" r="7" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </g>
      );
    case 'thumbnails':
      return (
        <g {...(filled ? SOLID : OUTLINE)}>
          <rect x="4" y="4" width="7" height="7" rx="1.5" />
          <rect x="13" y="4" width="7" height="7" rx="1.5" />
          <rect x="4" y="13" width="7" height="7" rx="1.5" />
          <rect x="13" y="13" width="7" height="7" rx="1.5" />
        </g>
      );
    case 'outline':
      return filled ? (
        <g {...SOLID}>
          <circle cx="5" cy="6" r="1.6" />
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="5" cy="18" r="1.6" />
          <rect x="9" y="5" width="11" height="2" rx="1" />
          <rect x="9" y="11" width="11" height="2" rx="1" />
          <rect x="9" y="17" width="11" height="2" rx="1" />
        </g>
      ) : (
        <g {...OUTLINE}>
          <line x1="9" y1="6" x2="20" y2="6" />
          <line x1="9" y1="12" x2="20" y2="12" />
          <line x1="9" y1="18" x2="20" y2="18" />
          <circle cx="5" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="5" cy="18" r="1" fill="currentColor" stroke="none" />
        </g>
      );
    case 'hand':
      return (
        <path
          d="M8 11V5.5a1.5 1.5 0 0 1 3 0V11V4.5a1.5 1.5 0 0 1 3 0V11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a5 5 0 0 1-4.3-2.5L3 14.5a1.6 1.6 0 0 1 2.6-1.8L8 15"
          {...(filled ? { ...SOLID, stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' as const } : OUTLINE)}
        />
      );
    case 'fullscreen-enter':
      return (
        <g {...OUTLINE}>
          <polyline points="4 9 4 4 9 4" />
          <polyline points="20 9 20 4 15 4" />
          <polyline points="4 15 4 20 9 20" />
          <polyline points="20 15 20 20 15 20" />
        </g>
      );
    case 'fullscreen-exit':
      return (
        <g {...OUTLINE}>
          <polyline points="9 4 9 9 4 9" />
          <polyline points="15 4 15 9 20 9" />
          <polyline points="9 20 9 15 4 15" />
          <polyline points="15 20 15 15 20 15" />
        </g>
      );
    case 'spread':
      return (
        <g {...(filled ? SOLID : OUTLINE)}>
          <rect x="4" y="5" width="7.2" height="14" rx="1.5" />
          <rect x="12.8" y="5" width="7.2" height="14" rx="1.5" />
        </g>
      );
    case 'sun':
      return (
        <g {...OUTLINE}>
          <circle cx="12" cy="12" r="4" />
          <line x1="12" y1="2.5" x2="12" y2="5" />
          <line x1="12" y1="19" x2="12" y2="21.5" />
          <line x1="2.5" y1="12" x2="5" y2="12" />
          <line x1="19" y1="12" x2="21.5" y2="12" />
          <line x1="5.2" y1="5.2" x2="7" y2="7" />
          <line x1="17" y1="17" x2="18.8" y2="18.8" />
          <line x1="5.2" y1="18.8" x2="7" y2="17" />
          <line x1="17" y1="7" x2="18.8" y2="5.2" />
        </g>
      );
    case 'moon':
      return <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" {...OUTLINE} />;
    case 'close':
      return (
        <g {...OUTLINE}>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </g>
      );
    case 'eye':
      return filled ? (
        <g>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" {...SOLID} />
          <circle cx="12" cy="12" r="2.6" fill="var(--color-surface-raised, #fff)" />
        </g>
      ) : (
        <g {...OUTLINE}>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </g>
      );
    case 'pencil':
      return filled ? (
        <path d="M14.8 4.9 19.1 9.2 8.3 20H4v-4.3zM16.2 3.5l1.6-1.6a1.5 1.5 0 0 1 2.1 0l2.2 2.2a1.5 1.5 0 0 1 0 2.1l-1.6 1.6z" {...SOLID} />
      ) : (
        <g {...OUTLINE}>
          <path d="M14.5 5.2 18.8 9.5 8 20.3H3.7V16z" />
          <path d="M16 3.7 18 1.7a1 1 0 0 1 1.4 0l2.9 2.9a1 1 0 0 1 0 1.4l-2 2z" />
        </g>
      );
    case 'suggest':
      // pencil with a small accent mark — "tracked change" feel
      return (
        <g>
          <path
            d="M13.5 6.2 17.8 10.5 7 21.3H2.7V17z"
            {...(filled ? SOLID : OUTLINE)}
          />
          <path d="M15 4.7 17 2.7a1 1 0 0 1 1.4 0L21.3 5.6a1 1 0 0 1 0 1.4l-2 2z" {...(filled ? SOLID : OUTLINE)} />
          <circle cx="19.5" cy="18.5" r="2.6" fill="currentColor" />
          <line x1="19.5" y1="16.8" x2="19.5" y2="20.2" stroke="var(--color-surface-raised, #fff)" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="17.8" y1="18.5" x2="21.2" y2="18.5" stroke="var(--color-surface-raised, #fff)" strokeWidth="1.4" strokeLinecap="round" />
        </g>
      );
    case 'chevron-down':
      return <polyline points="6 9 12 15 18 9" {...OUTLINE} />;
    case 'scroll-h':
      // horizontal page layout: two side-by-side sheets with a left-right arrow
      return (
        <g {...(filled ? SOLID : OUTLINE)}>
          <rect x="3" y="6" width="7" height="12" rx="1.5" />
          <rect x="14" y="6" width="7" height="12" rx="1.5" />
        </g>
      );
    case 'check':
      return <polyline points="5 12.5 10 17.5 19 6.5" {...OUTLINE} />;
  }
}

export function Icon({ name, filled = false, size = 20, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="presentation"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths(name, filled)}
    </svg>
  );
}
