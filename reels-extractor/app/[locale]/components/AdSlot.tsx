type Size = "leaderboard" | "rectangle";

// Fixed heights reserve space up front so ads loading later never shift layout.
const SIZE_CLASSES: Record<Size, string> = {
  leaderboard: "min-h-[90px] max-w-3xl",
  rectangle: "min-h-[250px] max-w-sm",
};

export default function AdSlot({
  label,
  size = "leaderboard",
}: {
  label: string;
  size?: Size;
}) {
  return (
    <aside
      aria-label={label}
      className={`mt-10 flex w-full items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.02] ${SIZE_CLASSES[size]}`}
    >
      <span className="text-[10px] font-medium uppercase tracking-widest text-zinc-600">
        {label}
      </span>
    </aside>
  );
}
