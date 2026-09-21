/** Telegram's paper plane, drawn in the current text colour. */
export default function TelegramIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M21.4 3.6 2.9 10.7c-.9.4-.9 1.1-.2 1.3l4.7 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.4l2.3-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8L22.6 5c.3-1.2-.5-1.8-1.2-1.4Zm-3.3 3.6-8.6 7.8-.3 3.7-1.5-4.8 10.4-6.7Z" />
    </svg>
  );
}
