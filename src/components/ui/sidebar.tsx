// The canvas page's SidebarInset with T3 Code's classes (apps/web/src/components/ui/sidebar.tsx).
import type * as React from "react";
import { cn } from "~/lib/utils";

export function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      className={cn(
        "relative flex min-w-0 w-full flex-1 flex-col bg-background surface-grain md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2 md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm/5",
        className,
      )}
      data-slot="sidebar-inset"
      {...props}
    />
  );
}
