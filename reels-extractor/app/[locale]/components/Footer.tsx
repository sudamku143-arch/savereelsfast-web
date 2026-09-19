import { localePath, type Locale } from "@/lib/i18n-config";
import { SITE_NAME } from "@/lib/site";

type Dict = {
  disclaimer: string;
  rights: string;
  links: {
    privacy: string;
    terms: string;
    contact: string;
  };
};

export default function Footer({
  locale,
  dict,
}: {
  locale: Locale;
  dict: Dict;
}) {
  const links = [
    { href: localePath(locale, "/privacy-policy"), label: dict.links.privacy },
    { href: localePath(locale, "/terms-of-service"), label: dict.links.terms },
    { href: localePath(locale, "/contact"), label: dict.links.contact },
  ];

  return (
    <footer className="mt-8 border-t border-white/10 px-4 py-10">
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-5 text-center">
        <nav aria-label="Footer">
          <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm">
            {links.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className="rounded text-zinc-400 outline-none transition hover:text-brand-300 focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <p className="text-xs leading-relaxed text-zinc-500">{dict.disclaimer}</p>
        <p className="text-xs text-zinc-600">
          © {new Date().getFullYear()} {SITE_NAME}. {dict.rights}
        </p>
      </div>
    </footer>
  );
}
