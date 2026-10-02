/**
 * Branch naming. Pure, so the awkward inputs — emoji, a title that is all
 * punctuation, a 90-character question — are covered by tests rather than
 * discovered when `git checkout -b` rejects one.
 */

const MAX_SLUG = 40;

export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return slug;
}

/** `YYYY-MM-DD` in the given IANA zone. */
export function localDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * `<prefix>/<date>-<slug>-<id>`. The id suffix is what guarantees uniqueness —
 * two threads opened on the same day with the same first words are common
 * ("morning brief"), and the date and slug are only there for the human
 * reading `git branch`.
 */
export function branchName(input: {
  readonly prefix: string;
  readonly title: string;
  readonly sessionId: string;
  readonly at: Date;
  readonly timeZone: string;
}): string {
  const slug = slugify(input.title);
  const id = input.sessionId.replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase();
  const middle = slug.length > 0 ? `${slug}-` : "";
  return `${input.prefix}/${localDate(input.at, input.timeZone)}-${middle}${id}`;
}
