// Wilco's mark: two overlapping chevrons, electric blue and pink, that read
// as a W -- the overlap is where they meet, the way separate accounts meet
// in one inbox. Same geometry as docs/brand/wilco-mark.svg and the favicon /
// app icons in client/public/. The overlap colour is the two strokes
// screen-blended, drawn explicitly so it renders the same everywhere.
import { useId } from "preact/hooks";
import type { JSX } from "preact";

export interface MarkProps {
  size?: number;
  class?: string;
}

const LEFT = "10,18 22,46 34,18";
const RIGHT = "30,18 42,46 54,18";

export function Mark({ size = 22, class: cls }: MarkProps): JSX.Element {
  const mask = `wilco-mark-${useId()}`;
  const stroke = { fill: "none", "stroke-width": 8, "stroke-linejoin": "round", "stroke-linecap": "round" } as const;
  return (
    <svg class={cls} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <mask id={mask}>
        <rect width="64" height="64" fill="#000" />
        <polyline points={RIGHT} {...stroke} stroke="#fff" />
      </mask>
      <rect width="64" height="64" rx="14" fill="#16181c" />
      <polyline points={LEFT} {...stroke} stroke="#2f6bff" />
      <polyline points={RIGHT} {...stroke} stroke="#ff4d8d" />
      <polyline points={LEFT} {...stroke} stroke="#ff98ff" mask={`url(#${mask})`} />
    </svg>
  );
}
