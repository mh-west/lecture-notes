import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'kr.ac.snu.lecturenotes',
  appName: '강의노트',
  webDir: 'dist',
  ios: { contentInset: 'never' },
};

export default config;
