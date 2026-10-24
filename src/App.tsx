import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import AskDialog from './components/AskDialog';
import Library from './components/Library';
import PdfViewer from './components/PdfViewer';
import SidePanel from './components/SidePanel';
import ExpiryBanner from './components/ExpiryBanner';
import Toolbar from './components/Toolbar';
import { db } from './db';
import { useStore } from './store';

export default function App() {
  const [docId, setDocId] = useState<string | null>(() => localStorageGet('lastDoc'));
  const openDoc = useStore((s) => s.openDoc);
  const doc = useLiveQuery(() => (docId ? db.docs.get(docId) : undefined), [docId]);

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
        <SidePanel />
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
