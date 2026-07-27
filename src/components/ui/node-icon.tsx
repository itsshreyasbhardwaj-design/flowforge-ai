'use client';

import { createElement } from 'react';
import {
  Binary,
  Bot,
  Box,
  Braces,
  CalendarClock,
  Circle,
  Code,
  FileCode,
  FileText,
  GitBranch,
  GitPullRequest,
  Globe,
  Library,
  LogOut,
  Merge,
  MessageSquare,
  MessagesSquare,
  Play,
  Plug,
  Repeat,
  Rows3,
  Scissors,
  Search,
  Send,
  Split,
  Sparkles,
  Table,
  Telescope,
  Timer,
  UserCheck,
  Webhook,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

/**
 * Icons available to node definitions, keyed by the `icon` string a definition
 * declares.
 *
 * This is an explicit allow-list rather than `import * as Icons from 'lucide-react'`
 * on purpose: the namespace import defeats tree-shaking and drags the entire
 * ~1,500-icon library into the client bundle. A plugin that wants a glyph not
 * listed here falls back to `Box`; adding one is a single line.
 */
const ICONS: Record<string, LucideIcon> = {
  Binary,
  Bot,
  Box,
  Braces,
  CalendarClock,
  Circle,
  Code,
  FileCode,
  FileText,
  GitBranch,
  GitPullRequest,
  Globe,
  Library,
  LogOut,
  Merge,
  MessageSquare,
  MessagesSquare,
  Play,
  Plug,
  Repeat,
  Rows3,
  Scissors,
  Search,
  Send,
  Split,
  Sparkles,
  Table,
  Telescope,
  Timer,
  UserCheck,
  Webhook,
  Workflow,
};

/**
 * Renders a node's glyph by name.
 *
 * Uses `createElement` rather than binding the looked-up component to a local
 * and rendering `<Icon />`: a component identity that changes between renders
 * remounts its subtree and resets state.
 */
export function NodeIcon({ name, className }: { name?: string; className?: string }) {
  return createElement(ICONS[name ?? ''] ?? Box, { className, 'aria-hidden': true });
}
