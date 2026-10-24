import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'kr.ac.snu.lecturenotes',
  appName: '강의노트',
  webDir: 'dist',
  // The page scrolls inside its own panes; the web view's outer scroll view only competes with the pencil.
  ios: { contentInset: 'never', scrollEnabled: false },
};

export default config;
