'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Bot, FolderGit2, GitBranch, Settings, ChevronLeft, ChevronRight, Kanban, Bell } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const INTERNAL_NAV = [
  { label: 'Agents', href: '/agents', icon: Bot },
  { label: 'Repos', href: '/repos', icon: FolderGit2 },
  { label: 'Pipelines', href: '/pipelines', icon: GitBranch },
  { label: 'Settings', href: '/settings', icon: Settings },
];

const COLLAB_NAV = [
  { label: 'Board', href: '/board', icon: Kanban },
  { label: 'Needs attention', href: '/attention', icon: Bell },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('sidebar-collapsed');
    if (stored !== null) setCollapsed(stored === 'true');
  }, []);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('sidebar-collapsed', String(next));
  }

  // Internal GitHub users keep the legacy admin surfaces; collaboration-only
  // principals see the board and attention views. Both groups get the board.
  const isInternal = (session?.user.id ?? null) !== null || (session?.user.isSuperadmin ?? false);
  const navItems = isInternal ? [...COLLAB_NAV, ...INTERNAL_NAV] : COLLAB_NAV;

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          'flex flex-col border-r border-border bg-card/50 transition-all duration-200',
          collapsed ? 'w-14' : 'w-48',
        )}
      >
        <nav className="flex flex-1 flex-col gap-1 p-2 pt-3">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            const link = (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'border-l-2 border-primary bg-primary/10 text-primary-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                  collapsed && 'justify-center px-0',
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span>{item.label}</span>}
              </Link>
            );

            if (collapsed) {
              return (
                <Tooltip key={item.href}>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right">{item.label}</TooltipContent>
                </Tooltip>
              );
            }
            return link;
          })}
        </nav>
        <button
          onClick={toggle}
          className="flex items-center justify-center gap-1.5 border-t border-border p-2.5 text-xs text-muted-foreground hover:text-foreground"
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : (
            <>
              <ChevronLeft className="h-3.5 w-3.5" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </aside>
    </TooltipProvider>
  );
}
