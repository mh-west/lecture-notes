import { App as CapApp } from '@capacitor/app';
import { Filesystem } from '@capacitor/filesystem';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import AskDialog from './components/AskDialog';
import Library from './components/Library';
import PdfViewer from './components/PdfViewer';
import SidePanel from './components/SidePanel';
import CaptionBar from './components/CaptionBar';
import ExpiryBanner from './components/ExpiryBanner';
import Toolbar from './components/Toolbar';
import { db, importPdf } from './db';
import { isNative, nativeFileBlob } from './native';
import { useStore } from './store';

export default function App() {
  const [docId, setDocId] = useState<string | null>(() => localStorageGet('lastDoc'));
  const openDoc = useStore((s) => s.openDoc);
  const doc = useLiveQuery(() => (docId ? db.docs.get(docId) : undefined), [docId]);
  const sideOpen = useStore((s) => s.sideOpen);
  const [waiting, setWaiting] = useState<string | null>(null); // PDF to open once a recording has wrapped up

  // A recording keeps going in the library and in its own PDF; only opening another PDF ends it, if asked.
  const open = async (id: string) => {
    const st = useStore.getState();
    if (st.activeRec && st.activeRec.docId !== id) {
      if (!confirm('지금 녹음 중이에요. 녹음을 멈추고 이 PDF를 열까요?')) return;
      await st.stopRecording();
    }
    const after = useStore.getState();
    if (after.finishing && after.docId !== id) {
      // Its last captions, translation and summary need that PDF's data in the app.
      setWaiting(id);
      await after.waitFinished();
      setWaiting((w) => {
        if (w === id) setDocId(id);
        return null;
      });
      return;
    }
    setDocId(id);
  };

  // PDFs shared to the app ("강의노트에 복사" in the share sheet) arrive as file URLs in Documents/Inbox.
  useEffect(() => {
    if (!isNative) return;
    const seen = new Set<string>();
    const handle = async (url?: string) => {
      if (!url || seen.has(url)) return;
      const name = decodeURIComponent(url.split('?')[0].split('/').pop() ?? '');
      if (!/\.pdf$/i.test(name)) return;
      seen.add(url);
      try {
        const id = await importPdf(await nativeFileBlob(url), name);
        Filesystem.deleteFile({ path: url }).catch(() => {});
        // Don't yank the user out of a lecture that's being recorded; it'll be in the library.
        if (!useStore.getState().activeRec) setDocId(id);
      } catch (e) {
        alert(`PDF를 가져오지 못했어요: ${e instanceof Error ? e.message : e}`);
      }
    };
    CapApp.getLaunchUrl().then((r) => handle(r?.url)).catch(() => {});
    const sub = CapApp.addListener('appUrlOpen', (e) => handle(e.url));
    return () => {
      sub.then((h) => h.remove());
    };
  }, []);

  useEffect(() => {
    openDoc(docId);
    localStorageSet('lastDoc', docId);
  }, [docId, openDoc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) useStore.getState().redo();
      else useStore.getState().undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!docId) {
    return (
      <>
        <Library onOpen={open} />
        {waiting && (
          <div className="modal-backdrop">
            <div className="modal share-modal">
              <h2>녹음 마무리 중…</h2>
              <div className="muted">녹음은 저장됐어요. 남은 자막·번역·요약을 끝내고 PDF를 열게요.</div>
              <button
                onClick={() => {
                  setDocId(waiting);
                  setWaiting(null);
                }}
              >
                기다리지 않고 열기 (남은 번역·요약은 나중에 직접)
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="app">
      <Toolbar title={doc?.name ?? ''} onBack={() => setDocId(null)} />
      <ExpiryBanner quiet />
      <div className="main">
        <PdfViewer key={docId} docId={docId} onMissing={() => setDocId(null)} />
        {sideOpen ? <SidePanel /> : <CaptionBar />}
        {!sideOpen && (
          <button className="panel-open" onClick={() => useStore.getState().setSideOpen(true)} title="패널 열기">
            ◂ 패널
          </button>
        )}
      </div>
      <AskDialog />
    </div>
  );
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string | null) {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* private mode */
  }
}
