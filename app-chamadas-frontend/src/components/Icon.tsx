import type { ReactNode } from 'react';
const paths = {
  hash: <path d="M10 3 8 21M16 3l-2 18M4 9h17M3 15h17" />,
  video: <><rect x="3" y="5" width="12" height="14" rx="3" /><path d="m15 10 6-3v10l-6-3" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" /></>,
  screen: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4m-3-11 3-3 3 3M12 7v7" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  call: <path d="M3 14c6-5 12-5 18 0v4l-5-1v-3M8 14v3l-5 1" />,
  send: <path d="m21 3-7 18-3-8-8-3 18-7ZM11 13 21 3" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
  edit: <><path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15l-1 5Z" /></>,
  users: <><circle cx="9" cy="8" r="3" /><path d="M2 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 4 4v2" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  enter: <><path d="M14 8l4 4-4 4M18 12H7" /><path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5" /></>,
  logout: <><path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M14 8l4 4-4 4M18 12H8" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  maximize: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></>,
  minimize: <><path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5" /></>,
  hand: <path d="M7 11V6a1.5 1.5 0 0 1 3 0v4-6a1.5 1.5 0 0 1 3 0v6-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v5c0 5-3 8-8 8h-1c-3 0-5-2-7-5l-1-2a1.6 1.6 0 0 1 2.7-1.7L7 15" />,
  leaf: <><path d="M20 4C11 4 5 8 5 15c0 3 2 5 5 5 7 0 10-7 10-16Z" /><path d="M4 21c2-5 6-9 12-12" /></>,
  pin: <><path d="m15 4 5 5-3 1-4 4 1 4-1 1-8-8 1-1 4 1 4-4 1-3Z" /><path d="m9 15-5 5" /></>,
  paperclip: <path d="m20 11-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" />,
  star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7L10.5 2h-3l-.7 2-1.7.7-1.9-.9L1.1 5.9l.9 1.9-.7 1.7L0 10.5v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2.3h3l.7-2.3 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7 2-.7Z" transform="translate(2 -1) scale(.83)" /></>,
  file: <><path d="M6 2h8l4 4v16H6Z" /><path d="M14 2v5h5" /></>,
  archive: <><path d="M4 7h16v14H4Z" /><path d="M3 3h18v4H3m6 5h6" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 15-5-5L5 20" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  warning: <><path d="M12 3 2 21h20L12 3Z" /><path d="M12 9v5m0 3v.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" /></>,
} satisfies Record<string, ReactNode>;
export function Icon({ name, size = 20, off = false }: { name: keyof typeof paths; size?: number; off?: boolean }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {paths[name]}{off && <path d="m3 3 18 18" strokeWidth="2.5" />}
  </svg>;
}
