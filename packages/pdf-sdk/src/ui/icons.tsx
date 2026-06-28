/**
 * Icon set for the viewer chrome, backed by Font Awesome (free).
 *
 * Design language: the SOLID style signals an active/selected toggle (filled),
 * the REGULAR style the inactive state (unfilled). Icons that have no free
 * regular variant fall back to solid for both states. Icons inherit
 * `currentColor` so the button controls color. Default render size is 20px
 * (the desktop-toolbar standard); set `size` for dense/inline contexts.
 *
 * License: Font Awesome Free — icons CC BY 4.0, fonts SIL OFL 1.1, code MIT.
 * Attribution recorded in NOTICE.
 */
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faChevronLeft,
  faChevronRight,
  faChevronDown,
  faMagnifyingGlassPlus,
  faMagnifyingGlassMinus,
  faMagnifyingGlass,
  faArrowsLeftRightToLine,
  faArrowsLeftRight,
  faExpand,
  faCompress,
  faRotate,
  faRotateLeft,
  faRotateRight,
  faTableCellsLarge,
  faListUl,
  faHand as faHandSolid,
  faBookOpen,
  faSun as faSunSolid,
  faMoon as faMoonSolid,
  faXmark,
  faEye as faEyeSolid,
  faPen,
  faPenToSquare as faPenToSquareSolid,
  faCheck,
  faArrowPointer,
  faHighlighter,
  faPenNib,
  faFont,
  faNoteSticky as faNoteStickySolid,
  faSquare as faSquareSolid,
  faCircle as faCircleSolid,
  faArrowRightLong,
  faTrashCan as faTrashCanSolid,
  faBars,
  faDownload,
  faPrint,
  faFolderOpen,
  faCircleInfo,
} from '@fortawesome/free-solid-svg-icons';
import {
  faHand as faHandReg,
  faSun as faSunReg,
  faMoon as faMoonReg,
  faEye as faEyeReg,
  faPenToSquare as faPenToSquareReg,
  faNoteSticky as faNoteStickyReg,
  faSquare as faSquareReg,
  faCircle as faCircleReg,
  faTrashCan as faTrashCanReg,
} from '@fortawesome/free-regular-svg-icons';

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
  | 'scroll-h'
  | 'cursor'
  | 'marker'
  | 'ink'
  | 'text-tool'
  | 'note'
  | 'square'
  | 'circle'
  | 'arrow'
  | 'undo'
  | 'redo'
  | 'trash'
  | 'menu'
  | 'download'
  | 'print'
  | 'open'
  | 'info';

/** Each icon maps to a solid (filled) and, where a free regular exists, an outline. */
const MAP: Record<IconName, { solid: IconDefinition; regular?: IconDefinition }> = {
  'chevron-left': { solid: faChevronLeft },
  'chevron-right': { solid: faChevronRight },
  'chevron-down': { solid: faChevronDown },
  'zoom-in': { solid: faMagnifyingGlassPlus },
  'zoom-out': { solid: faMagnifyingGlassMinus },
  'fit-width': { solid: faArrowsLeftRightToLine },
  'fit-page': { solid: faExpand },
  rotate: { solid: faRotate },
  search: { solid: faMagnifyingGlass },
  thumbnails: { solid: faTableCellsLarge },
  outline: { solid: faListUl },
  hand: { solid: faHandSolid, regular: faHandReg },
  'fullscreen-enter': { solid: faExpand },
  'fullscreen-exit': { solid: faCompress },
  spread: { solid: faBookOpen },
  sun: { solid: faSunSolid, regular: faSunReg },
  moon: { solid: faMoonSolid, regular: faMoonReg },
  close: { solid: faXmark },
  eye: { solid: faEyeSolid, regular: faEyeReg },
  pencil: { solid: faPen },
  suggest: { solid: faPenToSquareSolid, regular: faPenToSquareReg },
  check: { solid: faCheck },
  'scroll-h': { solid: faArrowsLeftRight },
  cursor: { solid: faArrowPointer },
  marker: { solid: faHighlighter },
  ink: { solid: faPenNib },
  'text-tool': { solid: faFont },
  note: { solid: faNoteStickySolid, regular: faNoteStickyReg },
  square: { solid: faSquareSolid, regular: faSquareReg },
  circle: { solid: faCircleSolid, regular: faCircleReg },
  arrow: { solid: faArrowRightLong },
  undo: { solid: faRotateLeft },
  redo: { solid: faRotateRight },
  trash: { solid: faTrashCanSolid, regular: faTrashCanReg },
  menu: { solid: faBars },
  download: { solid: faDownload },
  print: { solid: faPrint },
  open: { solid: faFolderOpen },
  info: { solid: faCircleInfo },
};

interface IconProps {
  name: IconName;
  /** Solid variant when true (active toggle); regular/outline otherwise. */
  filled?: boolean;
  /** Rendered glyph size in px. Default 20 (desktop-toolbar standard). */
  size?: number;
  className?: string;
}

export function Icon({ name, filled, size = 20, className }: IconProps) {
  const entry = MAP[name];
  const def = !filled && entry.regular ? entry.regular : entry.solid;
  return <FontAwesomeIcon icon={def} className={className} style={{ fontSize: `${size}px` }} aria-hidden />;
}
