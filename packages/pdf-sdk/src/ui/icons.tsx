// Copyright (c) 2026 Casual Office
// SPDX-License-Identifier: Apache-2.0

/**
 * Icon set for the viewer chrome, backed by **Lucide** (lucide-react) — matching
 * the Casual Office neobrutalist system used across Drive/Docs/Sheets.
 *
 * Design language: Lucide is a single stroke style (no filled variants), which
 * suits neobrutalist — the ACTIVE/selected state is signalled by the violet
 * background + color the button applies, plus a slightly heavier stroke here
 * (`filled` → bolder stroke). Icons inherit `currentColor`, so the button controls
 * color. Default render size is 20px (the desktop-toolbar standard).
 *
 * License: Lucide is ISC (permissive, in-policy).
 */
import type { ComponentType } from 'react';
import {
  Lock,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ZoomIn,
  ZoomOut,
  MoveHorizontal,
  Scaling,
  RotateCw,
  Search,
  LayoutGrid,
  List,
  Hand,
  Maximize,
  Minimize,
  BookOpen,
  Sun,
  Moon,
  X,
  Eye,
  Pencil,
  MessageSquareText,
  Check,
  Columns2,
  MousePointer2,
  Highlighter,
  Underline,
  Strikethrough,
  Waves,
  Paintbrush,
  Type,
  AlignLeft,
  AlignCenter,
  AlignRight,
  StickyNote,
  MessageSquare,
  Copy,
  LayoutDashboard,
  Square,
  Circle,
  ArrowRight,
  Undo2,
  Redo2,
  Trash2,
  Menu,
  Download,
  Printer,
  FolderOpen,
  Info,
  TriangleAlert,
  Signature,
  PenTool,
  Keyboard,
  RefreshCw,
  Image,
  RectangleHorizontal,
  type LucideProps,
} from 'lucide-react';

export type IconName =
  | 'lock'
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

type Glyph = ComponentType<LucideProps>;

/** One Lucide glyph per icon name (call sites are unchanged). */
const MAP: Record<IconName, Glyph> = {
  lock: Lock,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  'zoom-in': ZoomIn,
  'zoom-out': ZoomOut,
  'fit-width': MoveHorizontal,
  'fit-page': Scaling,
  rotate: RotateCw,
  search: Search,
  thumbnails: LayoutGrid,
  outline: List,
  hand: Hand,
  'fullscreen-enter': Maximize,
  'fullscreen-exit': Minimize,
  spread: BookOpen,
  sun: Sun,
  moon: Moon,
  close: X,
  eye: Eye,
  pencil: Pencil,
  suggest: MessageSquareText,
  check: Check,
  'scroll-h': Columns2,
  cursor: MousePointer2,
  marker: Highlighter,
  underline: Underline,
  strikeout: Strikethrough,
  squiggly: Waves,
  ink: Paintbrush,
  'text-tool': Type,
  'align-left': AlignLeft,
  'align-center': AlignCenter,
  'align-right': AlignRight,
  note: StickyNote,
  comments: MessageSquare,
  copy: Copy,
  organize: LayoutDashboard,
  square: Square,
  circle: Circle,
  arrow: ArrowRight,
  undo: Undo2,
  redo: Redo2,
  trash: Trash2,
  menu: Menu,
  download: Download,
  print: Printer,
  open: FolderOpen,
  info: Info,
  warning: TriangleAlert,
  sign: Signature,
  draw: PenTool,
  keyboard: Keyboard,
  refresh: RefreshCw,
  image: Image,
  redact: RectangleHorizontal,
};

interface IconProps {
  name: IconName;
  /** Active/selected toggle → a slightly heavier stroke (the violet bg cues state too). */
  filled?: boolean;
  /** Rendered glyph size in px. Default 20 (desktop-toolbar standard). */
  size?: number;
  className?: string;
}

export function Icon({ name, filled, size = 20, className }: IconProps) {
  const Glyph = MAP[name];
  return <Glyph size={size} strokeWidth={filled ? 2.4 : 1.9} className={className} aria-hidden />;
}
