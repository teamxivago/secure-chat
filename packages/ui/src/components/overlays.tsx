"use client";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion, useDragControls } from "framer-motion";
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { haptic } from "../lib/native";
import { Button } from "./primitives";

const spring = { type: "spring", stiffness: 420, damping: 36, mass: 0.9 } as const;

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  wide,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content asChild forceMount aria-describedby={description ? undefined : undefined}>
              <motion.div
                className={cn(
                  "fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[calc(100vw-32px)] overflow-y-auto rounded-[20px] bg-elevated p-5 shadow-float ring-1 ring-border focus:outline-none",
                  wide ? "max-w-xl" : "max-w-md",
                  className,
                )}
                initial={{ opacity: 0, scale: 0.94, x: "-50%", y: "-46%" }}
                animate={{ opacity: 1, scale: 1, x: "-50%", y: "-50%" }}
                exit={{ opacity: 0, scale: 0.96, x: "-50%", y: "-48%" }}
                transition={spring}
              >
                {title ? (
                  <div className="mb-4 flex items-start justify-between gap-4">
                    <div>
                      <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
                      {description && <DialogPrimitive.Description className="mt-1 text-sm text-muted">{description}</DialogPrimitive.Description>}
                    </div>
                    <DialogPrimitive.Close className="rounded-full p-1.5 text-muted hover:bg-surface" aria-label="Close">
                      <X className="h-5 w-5" />
                    </DialogPrimitive.Close>
                  </div>
                ) : (
                  <DialogPrimitive.Title className="sr-only">Dialog</DialogPrimitive.Title>
                )}
                {children}
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

/** Mobile-first bottom sheet with drag-to-dismiss; renders as a centered dialog on desktop. */
export function Sheet({ open, onOpenChange, title, children, className }: { open: boolean; onOpenChange: (o: boolean) => void; title?: ReactNode; children: ReactNode; className?: string }) {
  const drag = useDragControls();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div className="fixed inset-0 z-50 bg-black/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content
              forceMount
              aria-describedby={undefined}
              className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center focus:outline-none md:items-center"
              onPointerDownOutside={() => onOpenChange(false)}
            >
              <div className="absolute inset-0 pointer-events-auto" onClick={() => onOpenChange(false)} />
              <motion.div
                className={cn(
                  "safe-bottom pointer-events-auto relative max-h-[90vh] w-full overflow-hidden rounded-t-[20px] bg-elevated shadow-float ring-1 ring-border md:w-[440px] md:rounded-[20px]",
                  className,
                )}
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={spring}
                drag="y"
                dragListener={false}
                dragControls={drag}
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={{ top: 0, bottom: 0.6 }}
                onDragEnd={(_, i) => {
                  if (i.offset.y > 120 || i.velocity.y > 600) {
                    void haptic("light");
                    onOpenChange(false);
                  }
                }}
              >
                <div className="flex cursor-grab touch-none justify-center pb-1 pt-2.5 md:hidden" onPointerDown={(e) => drag.start(e)}>
                  <div className="h-1.5 w-10 rounded-full bg-surface-2" />
                </div>
                <DialogPrimitive.Title className={title ? "px-5 pb-2 pt-1 text-lg font-semibold md:pt-5" : "sr-only"}>{title ?? "Sheet"}</DialogPrimitive.Title>
                <div className="max-h-[80vh] overflow-y-auto">{children}</div>
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
}

export function Menu({
  trigger,
  items,
  align = "end",
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  return (
    <Dropdown.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align={align}
          sideOffset={6}
          className="z-50 min-w-[200px] overflow-hidden rounded-2xl bg-elevated/95 p-1.5 shadow-float ring-1 ring-border backdrop-blur-xl data-[state=open]:animate-in"
        >
          {items
            .filter((i) => !i.hidden)
            .map((i) => (
              <Dropdown.Item
                key={i.label}
                onSelect={() => {
                  void haptic("light");
                  i.onSelect();
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] outline-none data-[highlighted]:bg-surface",
                  i.danger && "text-danger",
                )}
              >
                {i.icon && <span className={cn("h-5 w-5", i.danger ? "text-danger" : "text-muted")}>{i.icon}</span>}
                {i.label}
              </Dropdown.Item>
            ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/* ------------------------------ confirm / prompt ------------------------------ */

interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  confirm?: string;
  danger?: boolean;
  checkbox?: string;
}
type Resolver = (v: { ok: boolean; checked: boolean }) => void;
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<{ ok: boolean; checked: boolean }>>(async () => ({ ok: false, checked: false }));

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: Resolver }) | null>(null);
  const [checked, setChecked] = useState(false);
  const confirm = useCallback(
    (o: ConfirmOpts) =>
      new Promise<{ ok: boolean; checked: boolean }>((resolve) => {
        setChecked(false);
        setState({ ...o, resolve });
      }),
    [],
  );
  const close = (ok: boolean) => {
    state?.resolve({ ok, checked });
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog open={!!state} onOpenChange={(o) => !o && close(false)} title={state?.title}>
        {state?.body && <div className="mb-4 text-[15px] text-muted">{state.body}</div>}
        {state?.checkbox && (
          <label className="mb-4 flex cursor-pointer items-center gap-3 text-[15px]">
            <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            {state.checkbox}
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button variant={state?.danger ? "danger" : "primary"} onClick={() => close(true)}>
            {state?.confirm ?? "OK"}
          </Button>
        </div>
      </Dialog>
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);
