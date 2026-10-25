"use client";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "../lib/cn";
import { haptic } from "../lib/native";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-all duration-200 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 select-none",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-contrast hover:bg-accent-strong shadow-soft",
        secondary: "bg-surface text-text hover:bg-surface-2",
        ghost: "text-text hover:bg-surface",
        outline: "border border-border text-text hover:bg-surface",
        danger: "bg-danger text-white hover:opacity-90",
        link: "text-accent hover:underline px-0",
      },
      size: {
        sm: "h-9 px-3 text-sm rounded-xl",
        md: "h-11 px-4 text-[15px] rounded-xl",
        lg: "h-12 px-6 text-base rounded-2xl",
        icon: "h-10 w-10 rounded-full",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
  noHaptic?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, loading, children, onClick, noHaptic, disabled, ...props }, ref) => (
  <button
    ref={ref}
    className={cn(buttonVariants({ variant, size }), className)}
    disabled={disabled || loading}
    onClick={(e) => {
      if (!noHaptic) void haptic("light");
      onClick?.(e);
    }}
    {...props}
  >
    {loading && <Loader2 className="h-4 w-4 animate-spin" />}
    {children}
  </button>
));
Button.displayName = "Button";

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(({ label, className, variant = "ghost", ...p }, ref) => (
  <Button ref={ref} aria-label={label} title={label} variant={variant} size="icon" className={cn("text-muted hover:text-text", className)} {...p} />
));
IconButton.displayName = "IconButton";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { leading?: ReactNode; trailing?: ReactNode }>(
  ({ className, leading, trailing, ...p }, ref) => (
    <div className={cn("flex h-11 items-center gap-2 rounded-xl bg-surface px-3 ring-accent/40 transition focus-within:ring-2", className)}>
      {leading && <span className="text-muted">{leading}</span>}
      <input ref={ref} className="h-full w-full min-w-0 bg-transparent text-[15px] text-text outline-none placeholder:text-subtle" {...p} />
      {trailing}
    </div>
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} className={cn("w-full resize-none rounded-xl bg-surface px-3 py-2.5 text-[15px] text-text outline-none ring-accent/40 placeholder:text-subtle focus:ring-2", className)} {...p} />
));
Textarea.displayName = "Textarea";

export function Switch({ checked, onCheckedChange, disabled, label }: { checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <SwitchPrimitive.Root
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(v) => {
        void haptic("light");
        onCheckedChange(v);
      }}
      className="relative h-[26px] w-[44px] shrink-0 cursor-pointer rounded-full bg-surface-2 transition-colors duration-200 data-[state=checked]:bg-accent disabled:opacity-50"
    >
      <SwitchPrimitive.Thumb className="block h-[22px] w-[22px] translate-x-[2px] rounded-full bg-white shadow-md transition-transform duration-200 will-change-transform data-[state=checked]:translate-x-[20px]" />
    </SwitchPrimitive.Root>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-5 w-5 animate-spin text-accent", className)} />;
}

export function Badge({ children, muted, className }: { children: ReactNode; muted?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums", muted ? "bg-subtle/60 text-white" : "bg-accent text-white", className)}>
      {children}
    </span>
  );
}

export function Section({ title, children, footer, className }: { title?: string; children: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <section className={cn("mb-5", className)}>
      {title && <h3 className="mb-1.5 px-4 text-[13px] font-medium uppercase tracking-wide text-muted">{title}</h3>}
      <div className="overflow-hidden rounded-2xl bg-elevated shadow-soft ring-1 ring-border">{children}</div>
      {footer && <p className="mt-1.5 px-4 text-[13px] text-muted">{footer}</p>}
    </section>
  );
}

export function Row({
  icon,
  title,
  subtitle,
  trailing,
  onClick,
  danger,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  className?: string;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={
        onClick
          ? () => {
              void haptic("light");
              onClick();
            }
          : undefined
      }
      className={cn(
        "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors [&+&]:border-t [&+&]:border-border",
        onClick && "hover:bg-surface active:bg-surface-2",
        className,
      )}
    >
      {icon && <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", danger ? "text-danger" : "text-accent")}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[15px]", danger && "text-danger")}>{title}</span>
        {subtitle && <span className="block truncate text-[13px] text-muted">{subtitle}</span>}
      </span>
      {trailing}
    </Comp>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="flex rounded-xl bg-surface p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => {
            void haptic("selection");
            onChange(o.value);
          }}
          className={cn("flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-all", value === o.value ? "bg-elevated text-text shadow-soft" : "text-muted hover:text-text")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-accent-soft text-accent">{icon}</div>
      <h3 className="text-lg font-semibold">{title}</h3>
      {body && <p className="max-w-xs text-sm text-muted">{body}</p>}
      {action}
    </div>
  );
}
