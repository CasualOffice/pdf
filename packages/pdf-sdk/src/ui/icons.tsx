// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Icon set for the viewer chrome, backed by Material Icons (Google) via
 * react-icons/md.
 *
 * Design language: the FILLED style signals an active/selected toggle, the
 * OUTLINE style the inactive state. Icons without a distinct outline variant
 * use the same glyph for both (the active background already cues state).
 * Icons inherit `currentColor`, so the button controls color. Default render
 * size is 20px (the desktop-toolbar standard); set `size` for dense/inline use.
 *
 * License: Material Icons are Apache-2.0 (in-policy); react-icons is MIT.
 */
import type { IconType } from 'react-icons';
import {
  MdChevronLeft,
  MdChevronRight,
  MdKeyboardArrowDown,
  MdZoomIn,
  MdOutlineZoomIn,
  MdZoomOut,
  MdFitScreen,
  MdOutlineFitScreen,
  MdSwapHoriz,
  MdRotateRight,
  MdOutlineRotateRight,
  MdSearch,
  MdOutlineSearch,
  MdGridView,
  MdOutlineGridView,
  MdFormatListBulleted,
  MdPanTool,
  MdOutlinePanTool,
  MdFullscreen,
  MdFullscreenExit,
  MdMenuBook,
  MdOutlineMenuBook,
  MdLightMode,
  MdOutlineLightMode,
  MdDarkMode,
  MdOutlineDarkMode,
  MdClose,
  MdVisibility,
  MdOutlineVisibility,
  MdEdit,
  MdOutlineEdit,
  MdRateReview,
  MdOutlineRateReview,
  MdCheck,
  MdViewColumn,
  MdNearMe,
  MdOutlineNearMe,
  MdBrush,
  MdOutlineBrush,
  MdHighlight,
  MdOutlineHighlight,
  MdFormatUnderlined,
  MdStrikethroughS,
  MdWaves,
  MdTitle,
  MdFormatAlignLeft,
  MdFormatAlignCenter,
  MdFormatAlignRight,
  MdStickyNote2,
  MdOutlineStickyNote2,
  MdComment,
  MdOutlineComment,
  MdContentCopy,
  MdDashboardCustomize,
  MdCropSquare,
  MdCircle,
  MdRadioButtonUnchecked,
  MdArrowRightAlt,
  MdUndo,
  MdRedo,
  MdDelete,
  MdOutlineDelete,
  MdMenu,
  MdDownload,
  MdPrint,
  MdFolderOpen,
  MdOutlineFolderOpen,
  MdInfo,
  MdInfoOutline,
  MdError,
  MdErrorOutline,
  MdHistoryEdu,
  MdGesture,
  MdKeyboard,
  MdRefresh,
  MdImage,
  MdOutlineImage,
  MdRectangle,
} from 'react-icons/md';

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
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'ink'
  | 'text-tool'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'note'
  | 'comments'
  | 'copy'
  | 'organize'
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
  | 'info'
  | 'warning'
  | 'sign'
  | 'draw'
  | 'keyboard'
  | 'refresh'
  | 'image'
  | 'redact';

/** filled (active) + optional outline (inactive) glyph per icon. */
const MAP: Record<IconName, { filled: IconType; outline?: IconType }> = {
  'chevron-left': { filled: MdChevronLeft },
  'chevron-right': { filled: MdChevronRight },
  'chevron-down': { filled: MdKeyboardArrowDown },
  'zoom-in': { filled: MdZoomIn, outline: MdOutlineZoomIn },
  'zoom-out': { filled: MdZoomOut },
  'fit-width': { filled: MdSwapHoriz },
  'fit-page': { filled: MdFitScreen, outline: MdOutlineFitScreen },
  rotate: { filled: MdRotateRight, outline: MdOutlineRotateRight },
  search: { filled: MdSearch, outline: MdOutlineSearch },
  thumbnails: { filled: MdGridView, outline: MdOutlineGridView },
  outline: { filled: MdFormatListBulleted },
  hand: { filled: MdPanTool, outline: MdOutlinePanTool },
  'fullscreen-enter': { filled: MdFullscreen },
  'fullscreen-exit': { filled: MdFullscreenExit },
  spread: { filled: MdMenuBook, outline: MdOutlineMenuBook },
  sun: { filled: MdLightMode, outline: MdOutlineLightMode },
  moon: { filled: MdDarkMode, outline: MdOutlineDarkMode },
  close: { filled: MdClose },
  eye: { filled: MdVisibility, outline: MdOutlineVisibility },
  pencil: { filled: MdEdit, outline: MdOutlineEdit },
  suggest: { filled: MdRateReview, outline: MdOutlineRateReview },
  check: { filled: MdCheck },
  'scroll-h': { filled: MdViewColumn },
  cursor: { filled: MdNearMe, outline: MdOutlineNearMe },
  marker: { filled: MdHighlight, outline: MdOutlineHighlight },
  underline: { filled: MdFormatUnderlined },
  strikeout: { filled: MdStrikethroughS },
  squiggly: { filled: MdWaves },
  ink: { filled: MdBrush, outline: MdOutlineBrush },
  'text-tool': { filled: MdTitle },
  'align-left': { filled: MdFormatAlignLeft },
  'align-center': { filled: MdFormatAlignCenter },
  'align-right': { filled: MdFormatAlignRight },
  note: { filled: MdStickyNote2, outline: MdOutlineStickyNote2 },
  comments: { filled: MdComment, outline: MdOutlineComment },
  copy: { filled: MdContentCopy },
  organize: { filled: MdDashboardCustomize },
  square: { filled: MdCropSquare },
  circle: { filled: MdCircle, outline: MdRadioButtonUnchecked },
  arrow: { filled: MdArrowRightAlt },
  undo: { filled: MdUndo },
  redo: { filled: MdRedo },
  trash: { filled: MdDelete, outline: MdOutlineDelete },
  menu: { filled: MdMenu },
  download: { filled: MdDownload },
  print: { filled: MdPrint },
  open: { filled: MdFolderOpen, outline: MdOutlineFolderOpen },
  info: { filled: MdInfo, outline: MdInfoOutline },
  warning: { filled: MdError, outline: MdErrorOutline },
  sign: { filled: MdHistoryEdu },
  draw: { filled: MdGesture },
  keyboard: { filled: MdKeyboard },
  refresh: { filled: MdRefresh },
  image: { filled: MdImage, outline: MdOutlineImage },
  redact: { filled: MdRectangle },
};

interface IconProps {
  name: IconName;
  /** Filled variant when true (active toggle); outline otherwise. */
  filled?: boolean;
  /** Rendered glyph size in px. Default 20 (desktop-toolbar standard). */
  size?: number;
  className?: string;
}

export function Icon({ name, filled, size = 20, className }: IconProps) {
  const entry = MAP[name];
  const Glyph = !filled && entry.outline ? entry.outline : entry.filled;
  return <Glyph size={size} className={className} aria-hidden />;
}
