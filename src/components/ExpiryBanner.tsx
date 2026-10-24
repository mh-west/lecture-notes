import { useEffect, useState } from 'react';
import { isNative, LectureAudio } from '../native';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Development builds stop opening when their provisioning profile expires (7 days with a free Apple ID).
 * Always show the date on the library screen; warn everywhere in the last two days.
 */
export default function ExpiryBanner({ quiet = false }: { quiet?: boolean }) {
  const [expires, setExpires] = useState<number | null>(null);

  useEffect(() => {
    if (isNative) LectureAudio.signingInfo().then((r) => setExpires(r.expires ?? null), () => {});
  }, []);

  if (!expires) return null;
  const days = Math.floor((expires - Date.now()) / DAY);
  const date = new Date(expires).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
  const urgent = days < 2;
  if (quiet && !urgent) return null;
  return (
    <div className={urgent ? 'warn expiry' : 'hint expiry'}>
      {urgent
        ? `⚠️ 이 앱은 ${date}까지만 열려요 (${days <= 0 ? '오늘' : `${days}일 남음`}). iPad를 Mac에 연결해 다시 설치하세요.`
        : `앱 사용 기한: ${date} (${days}일 남음) · 그 전에 iPad를 Mac에 연결하면 다시 설치돼요.`}
    </div>
  );
}
