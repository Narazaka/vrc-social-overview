import { createMemo, createRoot, createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { connectPipeline } from '@/lib/pipeline';
import {
  setAuthLostHandler,
  fetchAvatarImage,
  fetchFavoriteGroups,
  fetchFavorites,
  fetchFriends,
  fetchInstance,
  fetchWorld,
  fetchMe,
  fetchMyGroupIds,
  fetchOwner,
  inWorld,
  ownerIdOf,
  worldIdOf,
  type FavoriteGroup,
  type Friend,
  type Owner,
  type World,
} from '@/lib/vrchat';
import { ttlStore } from '@/lib/cache';

// 再取得を抑えるための保存先と TTL
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
// ワールド情報は変わることがまれ。期限切れでも保存した値を出しつつ取り直す（stale-while-revalidate）
const WORLD_TTL = DAY;
const worldCache = ttlStore<World>('worlds', 2000);
// 人数は流動的なので短時間だけ使い回す。members は取得時にそのインスタンスにいたフレンドで、
// 顔ぶれが変わっていたら人数も変わっているはずなので TTL 内でも取り直す
const INSTANCE_TTL = MINUTE;
const instanceCache = ttlStore<{ userCount: number; members: string }>('instances', 500);
// オーナーの名前・アイコンは変わることがまれ
const OWNER_TTL = DAY;
const ownerCache = ttlStore<Owner>('owners', 2000);

// 表示に使う項目だけ残して保存量を抑える（タグは正式公開かどうかの判定にだけ使う）
const slimWorld = (w: World): World => ({
  name: w.name,
  authorId: w.authorId,
  authorName: w.authorName,
  thumbnailImageUrl: w.thumbnailImageUrl,
  releaseStatus: w.releaseStatus,
  capacity: w.capacity,
  tags: w.tags.filter(t => t === 'system_approved'),
});

// loc: 居場所が関係するイベントの移動先。text: それ以外の内容の要約
export type LogEntry = { at: number; type: string; userId: string; name: string; loc?: string; text?: string };
const MAX_LOG = 500;

// stale: 人数が未確定（前回の値や推定値を出していて、取り直し中または取り直し待ち）
export type InstanceState = { userCount: number; stale?: boolean };

export const [state, setState] = createStore({
  me: undefined as string | undefined,
  error: undefined as string | undefined,
  loginRequired: false,
  friends: [] as Friend[],
  favTags: {} as Record<string, string[]>,
  favGroups: [] as FavoriteGroup[],
  // location / ユーザー・グループ ID ごとに、取得でき次第埋まる
  instances: {} as Record<string, InstanceState | { error: string }>,
  owners: {} as Record<string, Owner>,
  // インスタンス・オーナー・ワールドの取得の進み具合（画面上の簡易表示用）
  progress: { done: 0, total: 0 },
  // worldId ごと。前回までに保存したものから始まり、インスタンス取得のたびに更新する
  worlds: worldCache.all(),
  // Pipeline（リアルタイム更新）に繋がっているか。繋ぐ前は undefined
  live: undefined as boolean | undefined,
  // Pipeline で居場所が変わったのを受け取った時刻（ページを開いてから分のみ）
  movedAt: {} as Record<string, number>,
  // Pipeline で受け取ったイベント（新しい順、ページを開いてからの分のみ）
  eventLog: [] as LogEntry[],
});

// 詳細パネルで表示中のユーザー（usr_）またはワールド（wrld_）
export const [drawerId, setDrawerId] = createSignal<string>();
export const openDrawer = (id: string) => setDrawerId(id);

export const byLoc = createRoot(() => createMemo(() => Map.groupBy(state.friends.filter(inWorld), f => f.location)));
export const friendsById = createRoot(() => createMemo(() => new Map(state.friends.map(f => [f.id, f]))));

export const instanceOf = (loc: string) => {
  const i = state.instances[loc];
  return i && !('error' in i) ? i : undefined;
};

// 定員は通常ワールドで決まるので、インスタンスではなくワールドの値を使う
export const worldOf = (loc: string): World | undefined => state.worlds[worldIdOf(loc)];

export function setWorld(worldId: string, w: World) {
  const slim = slimWorld(w);
  setState('worlds', worldId, slim);
  worldCache.set(worldId, slim);
}

function track<T>(p: Promise<T>): Promise<T> {
  setState('progress', 'total', n => n + 1);
  return p.finally(() => setState('progress', 'done', n => n + 1));
}

const memberKey = (fs: Friend[]) =>
  fs
    .map(f => f.id)
    .sort()
    .join(',');

// 取得中のインスタンス。取得中に顔ぶれが変わっても重ねて取らない
const inFlight = new Set<string>();

// 人数を取り直す（インスタンスの応答に含まれるワールド情報も更新する）。取り直すまでは前回の値を古い値として出す
function refreshInstance(loc: string, members: string) {
  const old = instanceCache.any(loc);
  if (old) setState('instances', loc, { userCount: old.userCount, stale: true });
  inFlight.add(loc);
  track(fetchInstance(loc).finally(() => inFlight.delete(loc))).then(
    i => {
      // ストアの setState はオブジェクトをマージするので stale を明示して消す
      setState('instances', loc, { userCount: i.userCount, stale: false });
      instanceCache.set(loc, { userCount: i.userCount, members });
      setWorld(worldIdOf(loc), i.world);
    },
    e => setState('instances', loc, { error: (e as Error).message }),
  );
}

// お気に入りグループごとの色分け用クラス。複数グループに入っている場合は最初のグループの色
export const favClass = (id: string) => {
  const group = state.favTags[id]?.[0];
  return group ? `fav fav-${group}` : '';
};

// オフラインを含む全フレンドと、加入しているグループ。読み込み時に一度だけ設定する
let allFriendIds = new Set<string>();
let myGroupIds = new Set<string>();
export const isMyGroup = (id: string) => myGroupIds.has(id);

// kind: オーナーとの関係。friend はオンラインなら friend に本人の情報が入る
export type OwnerView = Owner & { kind: 'friend' | 'stranger' | 'group-member' | 'group'; friend?: Friend };

export function ownerOf(id: string): OwnerView | undefined {
  const f = friendsById().get(id);
  if (f) return { name: f.displayName, image: f.currentAvatarImageUrl, kind: 'friend', friend: f };
  const o = state.owners[id];
  if (!o) return undefined;
  if (id.startsWith('grp_')) return { ...o, kind: myGroupIds.has(id) ? 'group-member' : 'group' };
  return { ...o, kind: allFriendIds.has(id) ? 'friend' : 'stranger' };
}

// 同じインスタンスの人数はこの間隔より頻繁には取り直さない（フレンドの出入りが続いても 1 回にまとめる）
const REFRESH_INTERVAL = 30 * 1000;
const refreshScheduled = new Set<string>();

// 保存してある人数から今の人数を出す。顔ぶれが同じで新しければそのまま確定値として使い（true を返す）、
// そうでなければ前回の人数にフレンドの増減だけを反映した未確定の値を出す
function applyCachedCount(loc: string, members: Friend[], key: string): boolean {
  const cached = instanceCache.fresh(loc, INSTANCE_TTL);
  if (cached?.members === key) {
    setState('instances', loc, { userCount: cached.userCount, stale: false });
    return true;
  }
  const old = instanceCache.any(loc);
  if (old) {
    const estimate = old.userCount + members.length - old.members.split(',').length;
    setState('instances', loc, { userCount: Math.max(estimate, members.length), stale: true });
  }
  return false;
}

// 人数を必要なら取り直す。取り直すと応答に含まれるワールド情報も新しくなるので true を返す
function syncInstance(loc: string, members: Friend[]): boolean {
  const key = memberKey(members);
  if (applyCachedCount(loc, members, key)) return false;
  if (inFlight.has(loc) || instanceCache.fresh(loc, REFRESH_INTERVAL)) {
    if (!refreshScheduled.has(loc)) {
      refreshScheduled.add(loc);
      setTimeout(() => {
        refreshScheduled.delete(loc);
        syncLoc(loc);
      }, REFRESH_INTERVAL);
    }
    return false;
  }
  refreshInstance(loc, key);
  return true;
}

const worldRequested = new Set<string>();
// ワールド情報が古ければ取り直す（同じページを開いている間は一度だけ）
function syncWorld(worldId: string) {
  if (worldRequested.has(worldId) || worldCache.fresh(worldId, WORLD_TTL)) return;
  worldRequested.add(worldId);
  track(fetchWorld(worldId)).then(
    w => setWorld(worldId, w),
    () => {},
  );
}

const ownerRequested = new Set<string>();
function syncOwner(loc: string) {
  const ownerId = ownerIdOf(loc);
  if (!ownerId || friendsById().has(ownerId) || ownerRequested.has(ownerId)) return;
  ownerRequested.add(ownerId);
  const owner = ownerCache.fresh(ownerId, OWNER_TTL);
  if (owner) setState('owners', ownerId, owner);
  else
    track(fetchOwner(ownerId)).then(
      o => {
        setState('owners', ownerId, o);
        ownerCache.set(ownerId, o);
      },
      () => setState('owners', ownerId, { name: ownerId, image: '' }),
    );
}

// インスタンスの人数・ワールド・オーナーは、画面に見えている（近い）ものだけ取る。
// 見えていない間は保存値からの推定だけ出しておき、見えたときに取る。ページが隠れている間も取らない
const shownCount = new Map<string, number>();
const pendingLocs = new Set<string>();
const isShown = (loc: string) => !document.hidden && (shownCount.get(loc) ?? 0) > 0;

// 同じインスタンスが一覧に複数回出ることがあるので、見えている表示の数を数える
export function setShown(loc: string, shown: boolean) {
  const n = (shownCount.get(loc) ?? 0) + (shown ? 1 : -1);
  if (n > 0) shownCount.set(loc, n);
  else shownCount.delete(loc);
  if (shown && n === 1 && pendingLocs.has(loc)) syncLoc(loc);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) for (const loc of pendingLocs) if (isShown(loc)) syncLoc(loc);
});

function syncLoc(loc: string) {
  const members = byLoc().get(loc);
  if (!members) {
    pendingLocs.delete(loc);
    return;
  }
  if (!isShown(loc)) {
    applyCachedCount(loc, members, memberKey(members));
    pendingLocs.add(loc);
    return;
  }
  pendingLocs.delete(loc);
  if (!syncInstance(loc, members)) syncWorld(worldIdOf(loc));
  syncOwner(loc);
}

// フレンド一覧を取り直して、各インスタンスの人数・オーナー・ワールドを埋める
async function syncFriends(friends?: Friend[]) {
  // 同じ人のカードを作り直さないよう、ID で突き合わせて差分だけ反映する
  setState('friends', reconcile(friends ?? (await fetchFriends()), { key: 'id' }));
  for (const loc of byLoc().keys()) syncLoc(loc);
}

// Pipeline の user には表示に使う項目のうちこれらだけが入っている（アバター画像は入らない）
type PipelineUser = { displayName?: string; status?: string; statusDescription?: string };
const pickUser = (u: PipelineUser | undefined): Partial<Friend> =>
  Object.fromEntries(
    (['displayName', 'status', 'statusDescription'] as const).filter(k => u?.[k] !== undefined).map(k => [k, u![k]]),
  );

function patchFriend(id: string, patch: Partial<Friend>) {
  const i = state.friends.findIndex(f => f.id === id);
  const oldLoc = state.friends[i]?.location;
  if (i >= 0) setState('friends', i, patch);
  else {
    const f: Friend = {
      id,
      displayName: '',
      status: '',
      statusDescription: '',
      location: 'offline',
      platform: '',
      currentAvatarImageUrl: knownAvatars.get(id) ?? '',
      ...patch,
    };
    setState('friends', fs => [...fs, f]);
  }
  if (patch.location === undefined || patch.location === oldLoc) return;
  setState('movedAt', id, Date.now());
  // 抜けた先と入った先のインスタンスは人数が変わっている
  for (const loc of [oldLoc, patch.location]) if (loc?.startsWith('wrld_')) syncLoc(loc);
}

// オフラインになったフレンドのアバター画像。またオンラインになったときに取り直さずに済むよう覚えておく
const knownAvatars = new Map<string, string>();
const avatarRequested = new Set<string>();

// Pipeline のイベントにはアバター画像が無いので、アバター画像が分からないフレンドが画面に見えたときに取る
export function requestAvatar(id: string) {
  if (avatarRequested.has(id)) return;
  avatarRequested.add(id);
  fetchAvatarImage(id).then(
    url => {
      knownAvatars.set(id, url);
      setState('friends', f => f.id === id, 'currentAvatarImageUrl', url);
    },
    () => {},
  );
}

function removeFriend(id: string) {
  const f = friendsById().get(id);
  if (f?.currentAvatarImageUrl) knownAvatars.set(id, f.currentAvatarImageUrl);
  setState('friends', fs => fs.filter(x => x.id !== id));
  if (f?.location.startsWith('wrld_')) syncLoc(f.location);
}

// イベントの種類と中身は https://vrchat.community/websocket
function onEvent(type: string, c: any) {
  const id: string | undefined = c?.userId ?? c?.userid;
  if (!id) return;
  logEvent(type, id, c);
  switch (type) {
    case 'friend-online':
    case 'friend-location':
      // 移動先のワールド情報が付いてくるので、取りに行かずに済む
      if (c.worldId && c.world?.name) setWorld(c.worldId, c.world);
      return patchFriend(id, { ...pickUser(c.user), location: c.location, platform: c.platform });
    case 'friend-active':
      // Web サイトやモバイルアプリからのオンライン
      return patchFriend(id, { ...pickUser(c.user), location: 'offline', platform: c.platform });
    case 'friend-update':
      if (friendsById().has(id)) patchFriend(id, pickUser(c.user));
      return;
    case 'friend-offline':
      return removeFriend(id);
    case 'friend-add':
      allFriendIds.add(id);
      return;
    case 'friend-delete':
      allFriendIds.delete(id);
      return removeFriend(id);
  }
}

// 更新イベントで何が変わったかを比べるため、各ユーザーについて最後に受け取った user を覚えておく。
// まだ受け取っていない人は、フレンド一覧で取った値（API の応答の全項目が入っている）と比べる
type UserRecord = Record<string, unknown>;
const lastUser = new Map<string, UserRecord>();

// 変わった項目を「項目名: 新しい値」の形で並べる。タグは増減、長い値は項目名だけ
function describeChanges(before: UserRecord, after: UserRecord): string {
  const parts: string[] = [];
  for (const k of Object.keys(after)) {
    if (!(k in before) || JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    const [b, a] = [before[k], after[k]];
    if (Array.isArray(a) && Array.isArray(b)) {
      const diff = [
        ...a.filter(x => !b.includes(x)).map(x => `+${x}`),
        ...b.filter(x => !a.includes(x)).map(x => `-${x}`),
      ];
      parts.push(`${k}: ${diff.join(' ')}`);
    } else if (typeof a === 'string' && a.length <= 60) parts.push(`${k}: ${a || '（なし）'}`);
    else parts.push(k);
  }
  return parts.join(' / ');
}

// イベントの要約をログに残す。反映する前の状態と比べるので、反映より先に呼ぶ
function logEvent(type: string, id: string, c: any) {
  const prev = friendsById().get(id);
  const entry: LogEntry = { at: Date.now(), type, userId: id, name: c.user?.displayName ?? prev?.displayName ?? id };
  if (type === 'friend-online' || type === 'friend-location') entry.loc = c.location;
  else if (type === 'friend-update') {
    const before = lastUser.get(id) ?? (prev as UserRecord | undefined);
    entry.text = before
      ? describeChanges(before, c.user ?? {}) || '（比べられる項目に変化なし）'
      : '（前の値が無く比べられない）';
  }
  if (c.user) lastUser.set(id, c.user);
  setState('eventLog', log => [entry, ...log.slice(0, MAX_LOG - 1)]);
}

let stopPipeline: (() => void) | undefined;
// ログインが切れたら（開いた時点でも、使っている途中でも）接続をやめてログインを促す
setAuthLostHandler(() => {
  stopPipeline?.();
  setState({ loginRequired: true, live: undefined });
});

export async function load() {
  try {
    const me = await fetchMe();
    allFriendIds = new Set(me.friends);
    myGroupIds = new Set(await fetchMyGroupIds(me.id));
    setState('me', me.displayName);
  } catch (e) {
    // ログイン切れは上のハンドラーが表示を切り替える。それ以外（通信エラーなど）はエラーとして出す
    setState('error', (e as Error).message);
    return;
  }
  const [friends, favs, favGroups] = await Promise.all([fetchFriends(), fetchFavorites(), fetchFavoriteGroups()]);
  setState({ favGroups, favTags: Object.fromEntries(favs.map(f => [f.favoriteId, f.tags])) });
  await syncFriends(friends);
  // ponytail: 一覧の取得から接続までの間のイベントは取りこぼす。気になるなら接続してから一覧を取る
  stopPipeline = connectPipeline({
    onEvent,
    onReconnect: () => void syncFriends(),
    onStatus: live => setState('live', live),
  });
}
