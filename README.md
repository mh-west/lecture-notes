# 강의 노트 (Lecture Notes)

영어 강의를 들으며 PDF에 필기하고, 실시간 영어 자막·한국어 번역을 보고, 모르는 부분을 동그라미 쳐서 Claude / ChatGPT에 바로 묻는 iPad 앱.
Capacitor로 감싼 React 웹앱 + 음성인식·번역용 Swift 플러그인. **설치 방법은 [INSTALL.md](INSTALL.md).**

## 로드맵
- [x] **1단계** PDF 필기(펜·형광펜·지우개, Apple Pencil 필압), 녹음, 필기별 타임스탬프, 필기 순서 타임라인, 필기 탭 → 녹음 재생, 필기 재생
- [x] **2단계** 실시간 영어 자막 + 한국어 번역 (Apple 기기 내 음성인식·번역, 무료)
- [x] **3단계** ⭕ 올가미로 선택 → 자막·페이지 텍스트와 함께 Claude / ChatGPT 앱으로 공유
- [ ] **4단계** 복습: 수업 요약, PDF 내보내기, 동기화

## 개발
```bash
npm install
npm run dev        # http://localhost:5173
npm run build
```
데이터(PDF·필기·녹음·자막)는 기기 IndexedDB에만 저장됩니다.
브라우저에서는 MediaRecorder + Web Speech API로 대체 동작(번역 없음), iPad 앱에서는 `ios/App/App/LectureAudioPlugin.swift`가 녹음·자막·번역을 담당합니다.

## 구조
- `src/components/PageView.tsx` — PDF 페이지 렌더링, 펜/형광/지우개/⭕ 입력
- `src/store.ts` — 상태, 녹음·자막 연결, 질문 저장
- `src/ask.ts` — 선택 영역 캡처, 프롬프트 생성, 공유
- `src/vocab.ts` — 음성인식에 힌트로 주는 SDE 용어 목록
- `ios/App/App/LectureAudioPlugin.swift` — SpeechAnalyzer(iPadOS 26+) / SFSpeechRecognizer, Translation
