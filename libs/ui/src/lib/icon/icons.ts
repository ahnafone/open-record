/**
 * Stroked line icon set (24x24 viewBox) taken from the design mockup sprite.
 * Every shape is drawn with `stroke: currentColor`, 1.8px, round caps/joins.
 */
export type IconShape =
  | { readonly kind: 'path'; readonly d: string }
  | {
      readonly kind: 'circle';
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
    }
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rx: number;
    };

const p = (d: string): IconShape => ({ kind: 'path', d });
const c = (cx: number, cy: number, r: number): IconShape => ({
  kind: 'circle',
  cx,
  cy,
  r,
});

export const OR_ICONS = {
  disc: [c(12, 12, 9), c(12, 12, 2.6)],
  search: [c(11, 11, 7), p('m20.5 20.5-4-4')],
  bookmark: [p('M6.5 4.5h11v15.4l-5.5-4.1-5.5 4.1z')],
  play: [p('M8 5.2 19.5 12 8 18.8z')],
  pause: [p('M7.4 5h3.6v14H7.4zM13 5h3.6v14H13z')],
  next: [p('M6 5.2 15.4 12 6 18.8z'), p('M17 5h2.2v14H17z')],
  prev: [p('M18 5.2 8.6 12 18 18.8z'), p('M4.8 5H7v14H4.8z')],
  shuffle: [
    p('M16 3.5h4.5V8'),
    p('M3.5 20.5 20.5 3.5'),
    p('M20.5 16v4.5H16'),
    p('m15 15 5.5 5.5'),
    p('M3.5 3.5 9 9'),
  ],
  back: [p('M15 5 8 12l7 7')],
  'chev-down': [p('M5 9.5 12 16.5l7-7')],
  plus: [p('M12 5.5v13M5.5 12h13')],
  close: [p('M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8')],
  trash: [
    p('M4 7h16'),
    p('M9.5 7V4.8h5V7'),
    p('M6.6 7l1 12.3h8.8L17.4 7'),
    p('M10.2 11v5.4M13.8 11v5.4'),
  ],
  users: [
    c(9, 8, 3.4),
    p('M3.6 20c0-3.2 2.4-5.5 5.4-5.5s5.4 2.3 5.4 5.5'),
    p('M16.2 5.3a3.3 3.3 0 0 1 0 6.2'),
    p('M17 14.8c2.1.6 3.5 2.5 3.5 5.2'),
  ],
  lock: [
    { kind: 'rect', x: 5, y: 10.5, width: 14, height: 9.5, rx: 2 },
    p('M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5'),
  ],
  globe: [
    c(12, 12, 8.6),
    p('M3.6 12h16.8'),
    p(
      'M12 3.4c2.5 2.4 3.8 5.4 3.8 8.6s-1.3 6.2-3.8 8.6c-2.5-2.4-3.8-5.4-3.8-8.6S9.5 5.8 12 3.4z',
    ),
  ],
  check: [p('M5 12.5 9.5 17 19 7.2')],
  more: [c(5, 12, 1.6), c(12, 12, 1.6), c(19, 12, 1.6)],
  settings: [
    p('M4 7h9M17.5 7H20M4 17h5M13.5 17H20'),
    c(15.2, 7, 2.3),
    c(11.2, 17, 2.3),
  ],
  repeat: [
    p('M4.5 11V9.5a3 3 0 0 1 3-3h12'),
    p('m16.5 3.5 3 3-3 3'),
    p('M19.5 13v1.5a3 3 0 0 1-3 3h-12'),
    p('m7.5 20.5-3-3 3-3'),
  ],
  'repeat-one': [
    p('M4.5 11V9.5a3 3 0 0 1 3-3h12'),
    p('m16.5 3.5 3 3-3 3'),
    p('M19.5 13v1.5a3 3 0 0 1-3 3h-12'),
    p('m7.5 20.5-3-3 3-3'),
    p('M11.2 10.6 12.6 9.6v4.8'),
  ],
  alert: [c(12, 12, 8.6), p('M12 7.6v5.2'), p('M12 16.4h.01')],
  spinner: [p('M12 3.6a8.4 8.4 0 1 1-8.4 8.4')],
  download: [
    p('M12 4.5v10.5'),
    p('m7.5 10.5 4.5 4.5 4.5-4.5'),
    p('M5 19.5h14'),
  ],
  link: [
    p('M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1.2 1.2'),
    p('M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2'),
  ],
  volume: [
    p('M4.5 9.5h3l4.5-4v13l-4.5-4h-3z'),
    p('M15.5 9a4.2 4.2 0 0 1 0 6'),
    p('M18.2 6.4a8 8 0 0 1 0 11.2'),
  ],
  'volume-off': [
    p('M4.5 9.5h3l4.5-4v13l-4.5-4h-3z'),
    p('m15.5 9.5 5 5M20.5 9.5l-5 5'),
  ],
  queue: [p('M4.5 6.5h15M4.5 12h15M4.5 17.5h9'), p('M16.5 15v5l4-2.5z')],
  eye: [p('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z'), c(12, 12, 3)],
  'eye-off': [
    p('M2.5 12S6 5.5 12 5.5c1.5 0 2.9.4 4.1 1.1M21.5 12S18 18.5 12 18.5c-1.500 0-2.900-.4-4.1-1.1'),
    p('M4 4l16 16'),
  ],
  upload: [
    p('M12 15.5V5'),
    p('m7.5 9.5 4.5-4.5 4.5 4.5'),
    p('M5 19.5h14'),
  ],
} as const satisfies Record<string, readonly IconShape[]>;

export type IconName = keyof typeof OR_ICONS;

export const OR_ICON_NAMES = Object.keys(OR_ICONS) as IconName[];
