const FEATURES: { icon: string; title: string; body: string }[] = [
  {
    icon: '🎙',
    title: '실시간 영어 자막 + 한국어 번역',
    body: '녹음을 켜면 교수님 말씀이 바로 영어 자막으로 나오고 한국어 번역이 붙어요. 음성 인식은 iPad 안에서 처리돼서 인터넷이 없어도 되고, 녹음 파일도 함께 저장돼요.',
  },
  {
    icon: '✨',
    title: '보고 있는 슬라이드를 아는 AI 번역',
    body: '몇 문장마다 AI가 지금 보고 있는 페이지와 앞뒤 페이지 내용을 참고해서 번역을 다시 다듬어요. "어…", "you know" 같은 추임새는 빼고, 잘못 들린 용어(martindale → martingale)는 바로잡아요. martingale처럼 보통 영어로 쓰는 전문 용어는 영어로 남겨요.',
  },
  {
    icon: '📝',
    title: '강의 요약 자동 생성',
    body: '녹음이 끝나면 한 줄 요약, 다룬 내용(시간·페이지), 교수님이 강조한 점, 복습할 것을 정리해 줘요. 수식도 깨지지 않고 보여요.',
  },
  {
    icon: '⭕',
    title: '모르는 부분 동그라미 → 바로 AI에게 질문',
    body: '질문 도구로 PDF에서 모르는 곳을 동그라미 치면, 그 부분 이미지와 그때 교수님이 한 말, 페이지 내용을 묶어서 Claude나 ChatGPT에 보낼 질문을 만들어요. 받은 답은 AI 질문 탭에 모아 둘 수 있어요.',
  },
  {
    icon: '⏱',
    title: '필기마다 강의 시간 기록',
    body: '녹음 중에 쓴 필기를 손가락으로 탭하면 그때 강의가 재생돼요. 필기 순서 번호와 타임라인으로 무엇을 어떤 순서로 썼는지 보고, "필기 재생"으로 강의를 들으며 필기가 다시 그려지는 걸 볼 수 있어요.',
  },
  {
    icon: '📂',
    title: '굿노트 녹음도 가져와서 자막·번역·요약',
    body: '이미 굿노트로 녹음해 둔 강의도 녹음 파일을 가져오면 자막과 번역, 요약을 만들 수 있어요.',
  },
  {
    icon: '▦',
    title: '필기 앱으로서의 기본기',
    body: '펜·형광펜·지우개, Apple Pencil 두 번 탭으로 지우개 전환, 축소판·목차 개요, 빈 페이지 추가, 마지막으로 보던 위치 기억.',
  },
];

/** What this app does that a plain note-taking app doesn't — for people coming from Goodnotes or Notability. */
export default function Features({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal features">
        <header>
          <h2>강의노트로 할 수 있는 것</h2>
          <button onClick={onClose}>닫기</button>
        </header>
        <p className="muted">
          굿노트·노터빌리티처럼 PDF에 필기하는 건 똑같아요. 여기에 더해, 영어 강의를 듣는 동안 자막·번역·요약·질문까지
          한 화면에서 해결하도록 만들었어요.
        </p>
        <ul className="feature-list">
          {FEATURES.map((f) => (
            <li key={f.title}>
              <span className="feature-icon">{f.icon}</span>
              <div>
                <b>{f.title}</b>
                <p>{f.body}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="muted">AI 번역·요약은 툴바의 ✨ AI에서 기기 내 AI(무료) 또는 Claude(내 API 키) 중에서 고를 수 있어요.</p>
      </div>
    </div>
  );
}
