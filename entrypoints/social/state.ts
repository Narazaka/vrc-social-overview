import { createMemo, createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import {
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
  thumbnailImageUrl: w.thumbnailImageUrl,
  releaseStatus: w.releaseStatus,
  capacity: w.capacity,
  tags: w.tags.filter(t => t === 'system_approved'),
});

// stale: 期限切れの保存値を取り直し中
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
  // worldId ごと。前回までに保存したものから始まり、インスタンス取得のたびに更新する
  worlds: worldCache.all(),
});

export const byLoc = createRoot(() => createMemo(() => Map.groupBy(state.friends.filter(inWorld), f => f.location)));
export const friendsById = createRoot(() => createMemo(() => new Map(state.friends.map(f => [f.id, f]))));

export const instanceOf = (loc: string) => {
  const i = state.instances[loc];
  return i && !('error' in i) ? i : undefined;
};

// 定員は通常ワールドで決まるので、インスタンスではなくワールドの値を使う
export const worldOf = (loc: string): World | undefined => state.worlds[worldIdOf(loc)];

function setWorld(worldId: string, w: World) {
  const slim = slimWorld(w);
  setState('worlds', worldId, slim);
  worldCache.set(worldId, slim);
}

const memberKey = (fs: Friend[]) =>
  fs
    .map(f => f.id)
    .sort()
    .join(',');

// 人数を取り直す（インスタンスの応答に含まれるワールド情報も更新する）。取り直すまでは前回の値を古い値として出す
export function refreshInstance(loc: string, members: string) {
  const old = instanceCache.any(loc);
  if (old) setState('instances', loc, { userCount: old.userCount, stale: true });
  fetchInstance(loc).then(
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

const ownerRequested = new Set<string>();

export async function load() {
  try {
    const me = await fetchMe();
    allFriendIds = new Set(me.friends);
    myGroupIds = new Set(await fetchMyGroupIds(me.id));
    setState('me', me.displayName);
  } catch (e) {
    setState({ loginRequired: true, error: (e as Error).message });
    return;
  }
  const [friends, favs, favGroups] = await Promise.all([fetchFriends(), fetchFavorites(), fetchFavoriteGroups()]);
  setState({ friends, favGroups, favTags: Object.fromEntries(favs.map(f => [f.favoriteId, f.tags])) });

  // よく見る場所から先に埋まるよう、お気に入りのフレンドが多い順、次にフレンドが多い順に取得する
  const favIds = new Set(favs.map(f => f.favoriteId));
  const groups = Map.groupBy(friends.filter(inWorld), f => f.location);
  const locs = [...groups]
    .map(([loc, fs]) => ({ loc, fav: fs.filter(f => favIds.has(f.id)).length, n: fs.length }))
    .sort((a, b) => b.fav - a.fav || b.n - a.n)
    .map(x => x.loc);

  const worldsRefreshed = new Set<string>();
  for (const loc of locs) {
    const members = memberKey(groups.get(loc)!);
    const cached = instanceCache.fresh(loc, INSTANCE_TTL);
    if (cached?.members === members) setState('instances', loc, { userCount: cached.userCount, stale: false });
    else {
      refreshInstance(loc, members);
      worldsRefreshed.add(worldIdOf(loc));
    }

    const ownerId = ownerIdOf(loc);
    if (ownerId && !friendsById().has(ownerId) && !ownerRequested.has(ownerId)) {
      ownerRequested.add(ownerId);
      const owner = ownerCache.fresh(ownerId, OWNER_TTL);
      if (owner) setState('owners', ownerId, owner);
      else
        fetchOwner(ownerId).then(
          o => {
            setState('owners', ownerId, o);
            ownerCache.set(ownerId, o);
          },
          () => setState('owners', ownerId, { name: ownerId, image: '' }),
        );
    }
  }

  // インスタンスを取り直さなかったワールドは、期限切れのものだけワールド単体で取り直す
  for (const worldId of new Set(locs.map(worldIdOf))) {
    if (!worldsRefreshed.has(worldId) && !worldCache.fresh(worldId, WORLD_TTL))
      fetchWorld(worldId).then(
        w => setWorld(worldId, w),
        () => {},
      );
  }
}
