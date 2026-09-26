import { createLimiter } from './vrchat';

// API への負荷を抑えるため、取得結果を TTL 付きで拡張機能内に保存する。
// 保存するのは変わりにくい項目だけを明示的に選んだもの。ステータス・居場所・人数などの流動的な項目は
// 保存しないか、流動性に見合った短い TTL を別に設ける（誤った古い情報を出さないため）

type Entry<T> = { v: T; at: number };

// localStorage に保存する小さなキャッシュ。上限件数を超えたら古い順に捨てる
export function ttlStore<T>(name: string, max: number) {
  let data: Record<string, Entry<T>> = {};
  try {
    data = JSON.parse(localStorage.getItem(name) ?? '{}');
  } catch {
    // 壊れていたら空から始める
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      data = Object.fromEntries(
        Object.entries(data)
          .sort(([, a], [, b]) => b.at - a.at)
          .slice(0, max),
      );
      try {
        localStorage.setItem(name, JSON.stringify(data));
      } catch {
        // 保存できなくても表示には影響しない
      }
    }, 1000);
  };
  return {
    // ttlMs 以内に保存されたものだけ返す
    fresh: (key: string, ttlMs: number) => {
      const e = data[key];
      return e && Date.now() - e.at < ttlMs ? e.v : undefined;
    },
    // 古さを問わず返す
    any: (key: string) => data[key]?.v,
    all: () => Object.fromEntries(Object.entries(data).map(([k, e]) => [k, e.v])),
    set: (key: string, v: T) => {
      data[key] = { v, at: Date.now() };
      save();
    },
  };
}

// 画像 API は CDN の署名付き URL へリダイレクトする。署名 URL は期限（数日〜2 週間、日付単位）まで変わらず、
// その間はブラウザの HTTP キャッシュが効く。リダイレクト先を期限まで保存して img に直接渡し、画像 API へのアクセスを減らす。
// 1 件が約 700 文字と大きく件数も多いので、localStorage ではなく IndexedDB に置く。起動時に全件をメモリへ読み込み、
// 読み出しはメモリから、書き込みはまとめて行う。上限を超えたら、使われていない順に捨てる
type ImageEntry = { url: string; exp: number; at: number };
const IMAGE_MAX = 10000;
const EXPIRY_MARGIN = 60 * 60 * 1000;
// 署名 URL に期限が付いていない場合の保存期間
const DEFAULT_IMAGE_TTL = 24 * 60 * 60 * 1000;
// 使った時刻の更新で書き込みが増えすぎないよう、前回の更新から間が空いたときだけ更新する
const TOUCH_INTERVAL = 24 * 60 * 60 * 1000;
const imageLimited = createLimiter(6);
// 応答が返ってこない取得で同時取得の枠が埋まり、後の画像が止まらないよう打ち切る
const IMAGE_TIMEOUT = 15 * 1000;
const resolving = new Map<string, Promise<string>>();
const images = new Map<string, ImageEntry>();

// 画像 API の URL（…/api/1/image/file_…/版/サイズ）は、キーとして file_…/版/サイズ だけ持つ
const imageKey = (url: string) => url.match(/\/(file_[^/]+\/\d+\/\d+)$/)?.[1] ?? url;

const STORE = 'imageUrls';
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
// 使えない環境（プライベートウィンドウ等）ではメモリだけで動く
const db = new Promise<IDBDatabase | undefined>(resolve => {
  try {
    const open = indexedDB.open('vrc-social-overview', 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => resolve(undefined);
  } catch {
    resolve(undefined);
  }
});

const pendingWrites = new Map<string, ImageEntry | undefined>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
// 書き込み（undefined は削除）を少しためて 1 回のトランザクションで行う
function persist(key: string, entry: ImageEntry | undefined) {
  pendingWrites.set(key, entry);
  flushTimer ??= setTimeout(() => void flush(), 1000);
}
async function flush() {
  flushTimer = undefined;
  const d = await db;
  const writes = [...pendingWrites];
  pendingWrites.clear();
  if (!d || !writes.length) return;
  try {
    const store = d.transaction(STORE, 'readwrite').objectStore(STORE);
    for (const [key, entry] of writes) {
      if (entry) store.put(entry, key);
      else store.delete(key);
    }
  } catch {
    // 保存できなくても表示には影響しない
  }
}

// 上限を超えたら、使われていない順に捨てて上限の 9 割まで減らす（毎回並べ替えないよう余裕を持たせる）
function evict() {
  if (images.size <= IMAGE_MAX) return;
  const oldest = [...images].sort(([, a], [, b]) => a.at - b.at).slice(0, images.size - IMAGE_MAX * 0.9);
  for (const [key] of oldest) {
    images.delete(key);
    persist(key, undefined);
  }
}

const loaded = (async () => {
  const d = await db;
  if (d) {
    try {
      const store = d.transaction(STORE, 'readonly').objectStore(STORE);
      const [keys, values] = await Promise.all([
        request(store.getAllKeys()),
        request(store.getAll() as IDBRequest<ImageEntry[]>),
      ]);
      keys.forEach((key, i) => images.set(String(key), values[i]!));
    } catch {
      // 読めなければ空から始める
    }
  }
  // 以前 localStorage に保存していた分を移し、localStorage からは消す
  try {
    const old = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, { v: ImageEntry; at: number }>;
    for (const [url, e] of Object.entries(old)) {
      const key = imageKey(url);
      if (images.has(key) || !e?.v?.url) continue;
      const entry = { url: e.v.url, exp: e.v.exp, at: e.at };
      images.set(key, entry);
      persist(key, entry);
    }
    localStorage.removeItem(STORE);
  } catch {
    // 移せなくても取り直すだけ
  }
  evict();
})();

export async function resolveImage(url: string): Promise<string> {
  await loaded;
  const key = imageKey(url);
  const hit = images.get(key);
  if (hit && hit.exp - EXPIRY_MARGIN > Date.now()) {
    if (Date.now() - hit.at > TOUCH_INTERVAL) {
      hit.at = Date.now();
      persist(key, hit);
    }
    return hit.url;
  }
  let p = resolving.get(key);
  if (!p) {
    // 画像 API は認証不要で、リダイレクト先の CDN に Cookie を送ると CORS で弾かれるので送らない。
    // CDN は HEAD に CORS ヘッダーを付けないので GET で取る。img が CORS なしで読んだ応答がキャッシュにあると
    // CORS で失敗するのでキャッシュは読まず（reload）、取った応答はキャッシュに入るので続く img 表示はそれを使う
    p = imageLimited(() =>
      fetch(url, { credentials: 'omit', cache: 'reload', signal: AbortSignal.timeout(IMAGE_TIMEOUT) }),
    )
      .then(res => {
        if (!res.ok) throw new Error(`${res.status} ${url}`);
        const expires = Number(new URL(res.url).searchParams.get('Expires')) * 1000;
        const entry = { url: res.url, exp: expires || Date.now() + DEFAULT_IMAGE_TTL, at: Date.now() };
        images.set(key, entry);
        persist(key, entry);
        evict();
        return res.url;
      })
      .finally(() => resolving.delete(key));
    resolving.set(key, p);
  }
  return p;
}

// 保存したリダイレクト先が表示できなかったときに捨てる
export function forgetImage(url: string) {
  const key = imageKey(url);
  images.delete(key);
  persist(key, undefined);
}
