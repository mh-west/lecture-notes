# 강의 노트 (Lecture Notes)

영어 강의를 들으며 PDF에 필기하고, 필기마다 녹음 시간이 기록되는 iPad용 웹앱(PWA).

## 로드맵
- [x] **1단계** PDF 필기(펜·형광펜·지우개, Apple Pencil 필압), 녹음, 필기별 타임스탬프, 필기 순서 타임라인, 필기 탭 → 녹음 재생, 필기 재생
- [ ] **2단계** 실시간 영어 자막 + 한국어 번역
- [ ] **3단계** ⭕ 올가미로 선택 → 강의 맥락과 함께 AI 질문
- [ ] **4단계** 복습: 수업 요약, PDF 내보내기, 동기화

## 개발
```bash
npm install
npm run dev        # http://localhost:5173
npm run build
```
데이터(PDF·필기·녹음)는 브라우저 IndexedDB에만 저장됩니다.
iPad에서 마이크를 쓰려면 HTTPS 주소가 필요합니다 (Vercel 등에 배포).
