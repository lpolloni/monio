"use client";

import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** bottom sheet on small screens, side panel on large screens */
  side?: "responsive" | "right" | "center";
  className?: string;
  closeLabel?: string;
}

/**
 * Modal sheet with purposeful motion: slides up from the bottom on phones,
 * from the right (or centered) on larger screens. Focus trap, Escape and
 * scroll locking come from Radix Dialog.
 */
export function Sheet({ open, onOpenChange, title, description, children, side = "responsive", className, closeLabel = "Close" }: SheetProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] dark:bg-black/55"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={description ? undefined : undefined}>
              <motion.div
                className={cn(
                  "fixed z-50 flex flex-col bg-bg-elevated shadow-float hairline outline-none",
                  side === "center"
                    ? "inset-x-4 top-[10vh] mx-auto max-h-[80vh] max-w-lg rounded-[2rem]"
                    : side === "right"
                      ? "inset-y-3 right-3 w-[min(30rem,calc(100vw-1.5rem))] rounded-[2rem]"
                      : "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-[2rem] md:inset-x-auto md:inset-y-3 md:right-3 md:bottom-3 md:max-h-none md:w-[30rem] md:rounded-[2rem]",
                  className,
                )}
                initial={side === "center" ? { opacity: 0, scale: 0.96, y: 12 } : { opacity: 0, y: 40 }}
                animate={{ opacity: 1, scale: 1, y: 0, x: 0 }}
                exit={side === "center" ? { opacity: 0, scale: 0.97, y: 8 } : { opacity: 0, y: 40 }}
                transition={{ type: "spring", stiffness: 380, damping: 36 }}
              >
                <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-border-strong md:hidden" aria-hidden />
                <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-2">
                  <div>
                    <Dialog.Title className="font-display text-[1.9rem] leading-tight text-fg">{title}</Dialog.Title>
                    {description ? (
                      <Dialog.Description className="mt-1 text-sm text-fg-muted">{description}</Dialog.Description>
                    ) : (
                      <Dialog.Description className="sr-only">{title}</Dialog.Description>
                    )}
                  </div>
                  <Dialog.Close
                    className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-fg-muted transition hover:text-fg"
                    aria-label={closeLabel}
                  >
                    <X className="size-4" />
                  </Dialog.Close>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-8">{children}</div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}
