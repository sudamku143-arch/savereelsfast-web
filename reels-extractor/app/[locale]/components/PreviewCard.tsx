import Image from "next/image";

export type ReelResult = {
  videoUrl: string;
  thumbnailUrl: string;
  caption: string | null;
  author: string | null;
  durationSeconds: number | null;
};

type Dict = {
  title: string;
  author: string;
  duration: string;
  downloadButton: string;
  newSearch: string;
};

export default function PreviewCard({
  result,
  dict,
  onReset,
}: {
  result: ReelResult;
  dict: Dict;
  onReset: () => void;
}) {
  const durationLabel =
    result.durationSeconds != null
      ? `${Math.floor(result.durationSeconds / 60)}:${String(
          Math.round(result.durationSeconds % 60)
        ).padStart(2, "0")}`
      : null;

  return (
    <div className="mt-6 w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <p className="mb-3 text-sm font-semibold text-zinc-900">{dict.title}</p>
      <div className="flex gap-4">
        <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-xl bg-zinc-100">
          {result.thumbnailUrl && (
            <Image
              src={result.thumbnailUrl}
              alt={result.caption ?? "Reel thumbnail"}
              fill
              className="object-cover"
              unoptimized
            />
          )}
        </div>
        <div className="flex-1 space-y-1 text-sm">
          {result.author && (
            <p className="text-zinc-700">
              <span className="text-zinc-400">{dict.author}:</span>{" "}
              <span className="font-medium">@{result.author}</span>
            </p>
          )}
          {durationLabel && (
            <p className="text-zinc-700">
              <span className="text-zinc-400">{dict.duration}:</span>{" "}
              {durationLabel}
            </p>
          )}
          {result.caption && (
            <p className="line-clamp-2 text-zinc-500">{result.caption}</p>
          )}
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <a
          href={result.videoUrl}
          download
          className="flex-1 rounded-xl bg-brand-500 px-4 py-2.5 text-center text-sm font-semibold text-white shadow-sm transition hover:bg-brand-600"
        >
          {dict.downloadButton}
        </a>
        <button
          onClick={onReset}
          className="rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-50"
        >
          {dict.newSearch}
        </button>
      </div>
    </div>
  );
}
