export default function SkeletonLoader({ label }: { label: string }) {
  return (
    <div className="mt-6 w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex gap-4">
        <div className="skeleton h-24 w-24 shrink-0 animate-shimmer rounded-xl" />
        <div className="flex-1 space-y-3 py-1">
          <div className="skeleton h-4 w-3/4 animate-shimmer rounded" />
          <div className="skeleton h-4 w-1/2 animate-shimmer rounded" />
          <div className="skeleton h-8 w-28 animate-shimmer rounded-lg" />
        </div>
      </div>
      <p className="mt-3 text-center text-xs text-zinc-400">{label}</p>
    </div>
  );
}
