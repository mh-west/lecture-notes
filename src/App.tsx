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

  if (!docId) return <Library onOpen={setDocId} />;

  return (
    <div className="app">
      <Toolbar title={doc?.name ?? ''} onBack={() => setDocId(null)} />
      <ExpiryBanner quiet />
      <div className="main">
        <PdfViewer key={docId} docId={docId} onMissing={() => setDocId(null)} />
        {sideOpen ? <SidePanel /> : <CaptionBar />}
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
