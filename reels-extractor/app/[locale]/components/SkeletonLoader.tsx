export default function SkeletonLoader({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="glass mt-6 w-full max-w-md rounded-2xl p-4"
    >
      <div className="flex gap-4">
        <div className="skeleton h-32 w-24 shrink-0 animate-shimmer rounded-xl" />
        <div className="flex-1 space-y-3 py-1">
          <div className="skeleton h-4 w-3/4 animate-shimmer rounded" />
          <div className="skeleton h-4 w-1/2 animate-shimmer rounded" />
          <div className="skeleton h-9 w-full animate-shimmer rounded-lg" />
        </div>
      </div>
      <p className="mt-3 text-center text-xs text-zinc-500">{label}</p>
    </div>
  );
}
