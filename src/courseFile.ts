import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { db, type Course } from './db';
import { isNative } from './native';

// Course folders (name, subject, language, key terms) as a small JSON file, so they can be written on
// one device (e.g. the Mac, with a keyboard) and brought to another (AirDrop / Files). PDFs, ink and
// recordings are not included.

interface CourseFile {
  app: 'lecture-notes';
  kind: 'courses';
  version: 1;
  exportedAt: number;
  courses: Course[];
}

/** Shares (iPad/Mac app) or downloads (browser) a file with every course folder. Returns how many. */
export async function exportCourses(): Promise<number> {
  const courses = await db.courses.orderBy('createdAt').toArray();
  const file: CourseFile = { app: 'lecture-notes', kind: 'courses', version: 1, exportedAt: Date.now(), courses };
  const json = JSON.stringify(file, null, 2);
  const name = `강의노트-폴더-${new Date().toISOString().slice(0, 10)}.json`;
  if (isNative) {
    const { uri } = await Filesystem.writeFile({ path: name, data: json, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: name, files: [uri] });
  } else {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return courses.length;
}

/**
 * Adds the folders from an exported file. A folder that already exists (same id, or same name) is
 * updated: language and subject from the file, key terms merged. Returns counts for a message.
 */
export async function importCourses(file: Blob): Promise<{ added: number; updated: number }> {
  let data: CourseFile;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('강의노트 폴더 파일이 아니에요 (JSON을 읽을 수 없어요)');
  }
  if (data?.app !== 'lecture-notes' || data.kind !== 'courses' || !Array.isArray(data.courses)) {
    throw new Error('강의노트에서 내보낸 폴더 파일이 아니에요');
  }
  const existing = await db.courses.toArray();
  const byName = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c]));
  let added = 0;
  let updated = 0;
  await db.transaction('rw', db.courses, async () => {
    for (const c of data.courses) {
      if (!c?.name?.trim()) continue;
      const match = existing.find((e) => e.id === c.id) ?? byName.get(c.name.trim().toLowerCase());
      const vocab = Array.isArray(c.vocab) ? c.vocab.filter((t) => typeof t === 'string') : [];
      const lang = c.lang === 'ko-KR' ? 'ko-KR' : 'en-US';
      if (match) {
        await db.courses.update(match.id, {
          name: c.name.trim(),
          subject: c.subject?.trim() || match.subject,
          lang,
          vocab: [...new Set([...match.vocab, ...vocab])],
        });
        updated++;
      } else {
        await db.courses.put({
          id: c.id || crypto.randomUUID(),
          name: c.name.trim(),
          subject: c.subject ?? '',
          lang,
          vocab,
          createdAt: c.createdAt || Date.now(),
        });
        added++;
      }
    }
  });
  return { added, updated };
}
