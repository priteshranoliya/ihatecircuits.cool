/** Original stroke icons drawn on a 20×20 grid. */
const paths: Record<string, string> = {
  undo: 'M7 5 3 9l4 4 M3 9h9a5 5 0 0 1 0 10h-3',
  redo: 'M13 5l4 4-4 4 M17 9H8a5 5 0 0 0 0 10h3',
  rotate: 'M15.5 7A6.5 6.5 0 1 0 16.5 12 M16 3v4h-4',
  trash: 'M4 6h12 M8 6V4h4v2 M6 6l1 11h6l1-11',
  play: 'M6 4l10 6-10 6z',
  pause: 'M6 4v12 M14 4v12',
  step: 'M4 4l8 6-8 6z M15 4v12',
  reset: 'M4 10a6 6 0 1 0 2-4.5 M4 3v4h4',
  table: 'M3 4h14v12H3z M3 8h14 M9 4v12',
  zoomIn: 'M9 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10z M13 13l4 4 M9 7v4 M7 9h4',
  zoomOut: 'M9 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10z M13 13l4 4 M7 9h4',
  fit: 'M3 7V3h4 M13 3h4v4 M17 13v4h-4 M7 17H3v-4',
  sun: 'M10 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M10 1v2 M10 17v2 M1 10h2 M17 10h2 M3.6 3.6l1.4 1.4 M15 15l1.4 1.4 M3.6 16.4 5 15 M15 5l1.4-1.4',
  moon: 'M16 12.5A7 7 0 0 1 7.5 4 7 7 0 1 0 16 12.5z',
  help: 'M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M7.5 7.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V12 M10 14.5v.5',
  file: 'M5 2h7l4 4v12H5z M12 2v4h4',
  open: 'M2 5h6l2 2h8v9H2z',
  save: 'M10 3v10 M6 9l4 4 4-4 M3 15v2h14v-2',
  export: 'M10 13V3 M6 7l4-4 4 4 M3 13v4h14v-4',
  book: 'M3 4h5a2 2 0 0 1 2 2v11a2 2 0 0 0-2-2H3z M17 4h-5a2 2 0 0 0-2 2v11a2 2 0 0 1 2-2h5z',
  parts: 'M3 3h6v6H3z M11 3h6v6h-6z M3 11h6v6H3z M11 11h6v6h-6z',
  sliders: 'M4 5h12 M4 10h12 M4 15h12 M8 3v4 M13 8v4 M6 13v4',
  close: 'M5 5l10 10 M15 5 5 15',
  copy: 'M7 7h10v10H7z M3 13V3h10',
  wave: 'M2 13h3V6h4v8h4V6h3v7h2',
  chevron: 'M6 8l4 4 4-4',
  search: 'M9 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10z M13 13l4 4',
  more: 'M5 10h.01 M10 10h.01 M15 10h.01',
  plus: 'M10 4v12 M4 10h12',
  pencil: 'M13.5 3.5l3 3L7 16H4v-3z',
  star: 'M10 2.5l2.3 4.8 5.2.7-3.8 3.7.9 5.2L10 14.4l-4.6 2.5.9-5.2L2.5 8l5.2-.7z',
  check: 'M4 10.5l4 4 8-9',
  layers: 'M10 3l7 4-7 4-7-4z M3 11l7 4 7-4',
  chip: 'M6 5h8v10H6z M3 8h3 M3 12h3 M14 8h3 M14 12h3 M10 2v3 M10 15v3',
  grid: 'M4 4h5v5H4z M11 4h5v5h-5z M4 11h5v5H4z M11 11h5v5h-5z',
  chevronRight: 'M8 5l5 5-5 5',
  chevronLeft: 'M12 5l-5 5 5 5',
  pointer: 'M5 3l10 6-4.5 1.2L13 15l-2 1-2.5-4.8L5 14z',
  hand: 'M7 10V5a1.3 1.3 0 0 1 2.6 0v4 M9.6 9V3.8a1.3 1.3 0 0 1 2.6 0V9 M12.2 9V5a1.3 1.3 0 0 1 2.6 0v6c0 3.6-2.3 6-5.6 6-2.4 0-3.6-1.2-5-3.3L2.8 11a1.3 1.3 0 0 1 2.1-1.5L7 12',
  text: 'M4 5V3.5h12V5 M10 3.5V16.5 M7.5 16.5h5',
  focus: 'M3 7V3h4 M13 3h4v4 M17 13v4h-4 M7 17H3v-4 M8 8h4v4H8z',
  info: 'M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M10 9v5 M10 6.5v.5',
  warn: 'M10 3l8 14H2z M10 8v4 M10 14.5v.5',
  target: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  arrowUp: 'M10 16V4 M5 9l5-5 5 5',
  menu: 'M3 6h14 M3 10h14 M3 14h14',
  memory: 'M4 6h12v8H4z M7 6v8 M10 6v8 M13 6v8',
  test: 'M7 3h6 M8 3v5l-4 8a1 1 0 0 0 1 1.5h10a1 1 0 0 0 1-1.5l-4-8V3',
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
