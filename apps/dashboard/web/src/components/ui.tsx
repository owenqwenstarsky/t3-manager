import { AlertTriangle, Check, CheckCircle2, CircleDashed, Copy, Info, Loader2, X, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
export function Button({
  variant = "secondary",
  size = "md",
  loading,
  icon,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean; icon?: ReactNode }) {
  const styles: Record<Variant, string> = {
    primary: "bg-accent text-accent-ink hover:brightness-110 shadow-sm",
    secondary: "bg-surface text-ink border border-line hover:bg-surface-2",
    ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
    danger: "bg-critical text-white hover:brightness-110",
  };
  return (
    <button
      {...rest}
      type={rest.type ?? "button"}
      disabled={rest.disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap",
        size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm",
        styles[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("card", className)}>{children}</div>;
}

export function SectionTitle({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-3">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {subtitle && <p className="text-[13px] text-ink-3 mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral" | "info";
const toneIcon: Record<Tone, ReactNode> = {
  good: <CheckCircle2 className="size-3.5" style={{ color: "var(--good)" }} />,
  warning: <AlertTriangle className="size-3.5" style={{ color: "var(--warning)" }} />,
  serious: <AlertTriangle className="size-3.5" style={{ color: "var(--serious)" }} />,
  critical: <XCircle className="size-3.5" style={{ color: "var(--critical)" }} />,
  neutral: <CircleDashed className="size-3.5 text-ink-3" />,
  info: <Loader2 className="size-3.5 animate-spin" style={{ color: "var(--accent)" }} />,
};

/** Status badge: icon + label, never color alone. */
export function StatusBadge({ tone, label, icon }: { tone: Tone; label: string; icon?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2">
      {icon ?? toneIcon[tone]}
      {label}
    </span>
  );
}

export function Notice({ tone = "info", title, children, action }: { tone?: "info" | "warning" | "critical"; title?: string; children?: ReactNode; action?: ReactNode }) {
  const color = tone === "critical" ? "var(--critical)" : tone === "warning" ? "var(--warning)" : "var(--accent)";
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div className="flex gap-3 rounded-xl border border-line bg-surface p-3.5 text-sm" style={{ borderLeft: `3px solid ${color}` }}>
      <Icon className="size-4 mt-0.5 shrink-0" style={{ color }} />
      <div className="flex-1 min-w-0">
        {title && <div className="font-medium text-ink">{title}</div>}
        {children && <div className="text-ink-2 mt-0.5 leading-relaxed">{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 overflow-y-auto">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div role="dialog" aria-modal="true" className={cx("relative w-full card shadow-2xl my-8", width)}>
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div>
            <h3 className="text-base font-semibold">{title}</h3>
            {subtitle && <p className="text-[13px] text-ink-3 mt-1">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[13px] font-medium text-ink mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-3 mt-1.5 leading-relaxed">{hint}</span>}
    </label>
  );
}

const fieldBase =
  "h-9 rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-3 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20";
export const inputClass = `w-full ${fieldBase}`;

export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
  label?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={cx(fieldBase, "pr-8 cursor-pointer", className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-7 rounded-md px-2.5 text-[13px] font-medium transition",
            value === o.value ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx("relative h-5 w-9 rounded-full transition", checked ? "bg-accent" : "bg-surface-3")}
    >
      <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition", checked ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

export function CopyButton({ text, label = "Copy", size = "sm" }: { text: string; label?: string; size?: "sm" | "md" }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number>(undefined);
  return (
    <Button
      size={size}
      icon={done ? <Check className="size-4" /> : <Copy className="size-4" />}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "Copied" : label}
    </Button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-4 animate-spin text-ink-3", className)} />;
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center text-center px-6 py-14">
      <div className="mb-3 rounded-2xl bg-accent-wash p-3 text-accent">{icon}</div>
      <h3 className="font-semibold">{title}</h3>
      {children && <p className="mt-1.5 max-w-md text-sm text-ink-3 leading-relaxed">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Menu({ trigger, items }: { trigger: ReactNode; items: ({ label: string; icon?: ReactNode; onClick: () => void; danger?: boolean } | null)[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div className="absolute right-0 z-30 mt-1 min-w-44 card p-1 shadow-xl">
          {items.filter(Boolean).map((item) => (
            <button
              key={item!.label}
              onClick={() => {
                setOpen(false);
                item!.onClick();
              }}
              className={cx(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2",
                item!.danger ? "text-critical-ink" : "text-ink",
              )}
            >
              {item!.icon}
              {item!.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
