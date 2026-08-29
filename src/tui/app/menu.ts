/**
 * The navigation model: grouped, ordered menu items that each map to a screen
 * id. This is the map of "every feature the CLI has", surfaced as one place
 * to move around.
 */
export interface MenuItem {
  id: string;
  label: string;
  icon: string;
}

export interface MenuGroup {
  title: string;
  items: MenuItem[];
}

export const MENU: MenuGroup[] = [
  {
    title: 'Play',
    items: [
      { id: 'today', label: 'Today', icon: '◎' },
      { id: 'bets', label: 'My bets', icon: '✎' },
      { id: 'place', label: 'Place bets', icon: '✦' },
      { id: 'bonus', label: 'Bonus bets', icon: '?' },
      { id: 'suggest', label: 'Suggestions', icon: '✨' },
    ],
  },
  {
    title: 'Standings',
    items: [
      { id: 'leaderboard', label: 'Leaderboard', icon: '≣' },
      { id: 'overview', label: 'Season overview', icon: '▦' },
      { id: 'table', label: 'League table', icon: '⚑' },
      { id: 'schedule', label: 'Schedule', icon: '◷' },
      { id: 'deadline', label: 'Deadlines', icon: '⏳' },
    ],
  },
  {
    title: 'Analytics',
    items: [
      { id: 'stats', label: 'Stats', icon: '∿' },
      { id: 'rival', label: 'Rival watch', icon: '⚔' },
      { id: 'scenario', label: 'Scenarios', icon: '⎇' },
      { id: 'whatif', label: 'What-if replay', icon: '↺' },
    ],
  },
  {
    title: 'Data',
    items: [
      { id: 'sync', label: 'Sync season', icon: '⟲' },
      { id: 'cache', label: 'Cache', icon: '▤' },
      { id: 'rules', label: 'Rules', icon: '§' },
      { id: 'log', label: 'Audit log', icon: '≡' },
      { id: 'guide', label: 'Guide', icon: 'ℹ' },
    ],
  },
  {
    title: 'Community',
    items: [
      { id: 'communities', label: 'Communities', icon: '⬡' },
      { id: 'players', label: 'Players', icon: '☰' },
      { id: 'setcommunity', label: 'Set community', icon: '⊚' },
      { id: 'setplayer', label: 'Set player', icon: '☑' },
      { id: 'profiles', label: 'Profiles', icon: '⌘' },
    ],
  },
  {
    title: 'Settings',
    items: [
      { id: 'notify', label: 'Notifications', icon: '✉' },
      { id: 'account', label: 'Account', icon: '⚿' },
    ],
  },
  {
    title: 'Admin',
    items: [
      { id: 'members', label: 'Members', icon: '♟' },
      { id: 'memberbets', label: 'Member bets', icon: '⊞' },
    ],
  },
];

/** Flat list of item ids in display order, for wrap-around navigation. */
export function flatItems(): MenuItem[] {
  return MENU.flatMap((group) => group.items);
}

export function findItem(id: string): MenuItem | undefined {
  return flatItems().find((item) => item.id === id);
}
