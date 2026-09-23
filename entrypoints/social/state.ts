import { createMemo, createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import {
  fetchFavoriteGroups,
  fetchFavorites,
  fetchFriends,
  fetchInstance,
  fetchMe,
  fetchMyGroupIds,
  fetchOwner,
  inWorld,
  ownerIdOf,
  worldIdOf,
  type FavoriteGroup,
  type Friend,
  type Instance,
  type Owner,
  type World,
} from '@/lib/vrchat';
import { ttlStore } from '@/lib/cache';

// 再取得を抑えるための保存先と TTL
const MINUTE = 60 * 1000;
// ワールド情報は変わることがまれなので期限なしで保存し、次回はインスタンス取得前から名前とサムネイルを出す
const worldCache = ttlStore<World>('worlds', 2000);
// 人数は変わるが、開き直しを繰り返したときの連続取得を防ぐため短時間だけ使い回す
const INSTANCE_TTL = 3 * MINUTE;
const instanceCache = ttlStore<Instance>('instances', 500);
// オーナーの名前・アイコンは変わることがまれ
const OWNER_TTL = 24 * 60 * MINUTE;
const ownerCache = ttlStore<Owner>('owners', 2000);

// 表示に使う項目だけ残して保存量を抑える（タグは正式公開かどうかの判定にだけ使う）
const slimWorld = (w: World): World => ({
  name: w.name,
  thumbnailImageUrl: w.thumbnailImageUrl,
  releaseStatus: w.releaseStatus,
  tags: w.tags.filter(t => t === 'system_approved'),
});
const slimInstance = (i: Instance): Instance => ({
  userCount: i.userCount,
  capacity: i.capacity,
  world: slimWorld(i.world),
});

export const [state, setState] = createStore({
  me: undefined as string | undefined,
  error: undefined as string | undefined,
  loginRequired: false,
  friends: [] as Friend[],
  favTags: {} as Record<string, string[]>,
  favGroups: [] as FavoriteGroup[],
  // location / ユーザー・グループ ID ごとに、取得でき次第埋まる
  instances: {} as Record<string, Instance | { error: string }>,
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

export const worldOf = (loc: string): World | undefined => instanceOf(loc)?.world ?? state.worlds[worldIdOf(loc)];

function setInstance(loc: string, i: Instance) {
  setState('instances', loc, i);
  setState('worlds', worldIdOf(loc), i.world);
  worldCache.set(worldIdOf(loc), i.world);
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
  const locs = [...Map.groupBy(friends.filter(inWorld), f => f.location)]
    .map(([loc, fs]) => ({ loc, fav: fs.filter(f => favIds.has(f.id)).length, n: fs.length }))
    .sort((a, b) => b.fav - a.fav || b.n - a.n)
    .map(x => x.loc);

  for (const loc of locs) {
    const cached = instanceCache.fresh(loc, INSTANCE_TTL);
    if (cached) setInstance(loc, cached);
    else
      fetchInstance(loc).then(
        i => {
          const slim = slimInstance(i);
          setInstance(loc, slim);
          instanceCache.set(loc, slim);
        },
        e => setState('instances', loc, { error: (e as Error).message }),
      );

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
}
