const DATABASE_NAME = "answerly-study-library";
const DATABASE_VERSION = 1;
export const MAX_STUDY_FILES = 10;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("modules")) database.createObjectStore("modules", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the local study-file library."));
  });
}

export async function listStudyFiles() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("modules", "readonly");
    const request = transaction.objectStore("modules").getAll();
    const files = await requestResult(request);
    return files.sort((left, right) => left.addedAt - right.addedAt);
  } finally {
    database.close();
  }
}

export async function saveStudyFile(file) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("modules", "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore("modules");
    const existing = await requestResult(store.getAll());
    if (existing.length >= MAX_STUDY_FILES) {
      transaction.abort();
      await done.catch(() => {});
      throw new Error(`You can attach up to ${MAX_STUDY_FILES} study files.`);
    }
    await requestResult(store.add(file));
    await done;
  } finally {
    database.close();
  }
}

export async function removeStudyFile(id) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("modules", "readwrite");
    transaction.objectStore("modules").delete(id);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function clearStudyFiles() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("modules", "readwrite");
    transaction.objectStore("modules").clear();
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function findRelevantPassages(question, maxPassages = 5, maxCharacters = 8_000) {
  const files = await listStudyFiles();
  if (!files.length) return { hasFiles: false, passages: [] };
  const queryTerms = new Set([...tokenize(question).keys()].filter((token) => token.length > 2 && !STOP_WORDS.has(token)));
  if (!queryTerms.size) return { hasFiles: true, passages: [] };
  const scored = [];
  for (const file of files) {
    for (const section of file.sections || []) {
      const text = String(section.text || "");
      const sectionTerms = tokenize(`${section.location || ""} ${text}`);
      let score = 0;
      for (const term of queryTerms) {
        if (sectionTerms.has(term)) score += sectionTerms.get(term) > 1 ? 1.5 : 1;
      }
      if (score > 0) scored.push({ file: file.name, location: section.location, text, score });
    }
  }
  scored.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));
  const passages = [];
  let used = 0;
  for (const item of scored) {
    if (passages.length >= maxPassages || used >= maxCharacters) break;
    const text = item.text.slice(0, Math.min(1_600, maxCharacters - used));
    if (!text) continue;
    passages.push({ file: item.file, location: item.location, text });
    used += text.length;
  }
  return { hasFiles: true, passages };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Local file storage failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Local file storage failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Local file storage was cancelled."));
  });
}

function tokenize(text) {
  const counts = new Map();
  for (const token of String(text).toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

const STOP_WORDS = new Set("the and for are was were what which when where with from into about that this these those have has had does did can could would should will their there then than them they you your our out use using used how why who whom its it's a an is be to of in on or as at by it if not no yes on we i he she each both per via via file page section answer question choices option correct determine choose select best explain".split(" "));
