import { ICONS, ICON_VIEWBOX } from "../lib/icon-data";
import type { IconName } from "../lib/icon-data";

interface Props {
  name: IconName;
  className?: string;
}

/** Inline SVG in the current text colour, sized by the surrounding font size. */
export default function Icon({ name, className = "" }: Props) {
  return (
    <svg
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      fill="currentColor"
      aria-hidden="true"
      className={`inline-block h-[1em] w-[1em] shrink-0 ${className}`}
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
