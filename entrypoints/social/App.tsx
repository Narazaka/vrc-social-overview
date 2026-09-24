import { For, onMount, Show } from 'solid-js';
import { inPrivate, inWorld, outsideGame, type Friend } from '@/lib/vrchat';
import { FriendCard, InstanceCard, Member } from './cards';
import { LogTab } from './log';
import { Drawer } from './drawer';
import { persisted } from './settings';
import { byLoc, instanceOf, load, setState, state } from './state';

type SortKey<T> = (x: T) => number;

// 大きい順。キーが同じものは元の順（API が返した順）を保つ
const sortBy = <T,>(list: T[], key: SortKey<T>, reverse: boolean) => {
  const sorted = list.toSorted((a, b) => key(b) - key(a));
  return reverse ? sorted.toReversed() : sorted;
};

const usersIn = (loc: string) => instanceOf(loc)?.userCount ?? -1;

const FRIEND_SORTS = {
  default: ['既定', () => 0],
  cohabit: ['同居フレンド数', f => (inWorld(f) ? byLoc().get(f.location)!.length : 0)],
  users: ['インスタンス人数', f => (inWorld(f) ? usersIn(f.location) : -1)],
  // ページを開いてから移動・オンラインになった順。開いた時点の居場所に居続けている人は後ろ
  moved: ['最近の移動', f => state.movedAt[f.id] ?? 0],
} satisfies Record<string, [string, SortKey<Friend>]>;
const INSTANCE_SORTS = {
  friends: ['フレンド数', loc => byLoc().get(loc)!.length],
  users: ['現在人数', usersIn],
} satisfies Record<string, [string, SortKey<string>]>;

const keysOf = <K extends string>(o: Record<K, unknown>) => Object.keys(o) as K[];

// 表示設定（開き直しても保つ）
const [tab, setTab] = persisted<'friends' | 'instances' | 'log'>('tab', 'friends', ['friends', 'instances', 'log']);
// ゲーム外（Web・モバイル）のフレンドを別の行に分けて出すか、隠すか
const [outsideMode, setOutsideMode] = persisted<'separate' | 'hidden'>('outsideMode', 'separate', [
  'separate',
  'hidden',
]);
const showOutside = () => outsideMode() === 'separate';
const [favMode, setFavMode] = persisted<'grouped' | 'mixed'>('favMode', 'grouped', ['grouped', 'mixed']);
const [friendSort, setFriendSort] = persisted('friendSort', 'default', keysOf(FRIEND_SORTS));
const [friendReverse, setFriendReverse] = persisted<boolean>('friendReverse', false);
const [instanceSort, setInstanceSort] = persisted('instanceSort', 'friends', keysOf(INSTANCE_SORTS));
const [instanceReverse, setInstanceReverse] = persisted<boolean>('instanceReverse', false);

function SortControl<K extends string>(p: {
  sorts: Record<K, [string, unknown]>;
  key: K;
  setKey: (k: K) => void;
  reverse: boolean;
  setReverse: (r: boolean) => void;
}) {
  // 選択肢を並べて 1 クリックで切り替えられるようにする
  return (
    <span class="seg-group">
      並び:
      <span class="seg">
        <For each={Object.entries(p.sorts) as [K, [string, unknown]][]}>
          {([k, [label]]) => (
            <button aria-pressed={p.key === k} onClick={() => p.setKey(k)}>
              {label}
            </button>
          )}
        </For>
      </span>
      <label>
        <input type="checkbox" checked={p.reverse} onChange={e => p.setReverse(e.currentTarget.checked)} /> 逆順
      </label>
    </span>
  );
}

// ワールドにいる人・ゲーム内で private の人・ゲーム外（Web・モバイル）の人は別の行から並べる
function FriendSection(p: { title: string; group?: string; list: Friend[]; sort: SortKey<Friend>; reverse: boolean }) {
  const visible = () => (showOutside() ? p.list : p.list.filter(f => !outsideGame(f)));
  const grid = (list: () => Friend[]) => (
    <Show when={list().length}>
      <div class="grid">
        <For each={sortBy(list(), p.sort, p.reverse)}>{f => <FriendCard f={f} />}</For>
      </div>
    </Show>
  );
  return (
    <section>
      <h2 class={p.group ? `fav-${p.group}` : undefined}>
        {p.title} ({visible().length})
      </h2>
      {grid(() => p.list.filter(inWorld))}
      {grid(() => p.list.filter(inPrivate))}
      <Show when={showOutside()}>{grid(() => p.list.filter(outsideGame))}</Show>
    </section>
  );
}

function FriendsTab() {
  const favs = () => state.friends.filter(f => f.id in state.favTags);
  const sort = () => FRIEND_SORTS[friendSort()][1];
  const reverse = friendReverse;
  return (
    <>
      <div class="modes">
        お気に入り:
        <label>
          <input type="radio" name="favmode" checked={favMode() === 'grouped'} onChange={() => setFavMode('grouped')} />{' '}
          グループ別
        </label>
        <label>
          <input type="radio" name="favmode" checked={favMode() === 'mixed'} onChange={() => setFavMode('mixed')} />{' '}
          まとめて
        </label>
        <SortControl
          sorts={FRIEND_SORTS}
          key={friendSort()}
          setKey={setFriendSort}
          reverse={friendReverse()}
          setReverse={setFriendReverse}
        />
      </div>
      <Show
        when={favMode() === 'grouped'}
        fallback={<FriendSection title="お気に入り" list={favs()} sort={sort()} reverse={reverse()} />}
      >
        <For each={state.favGroups}>
          {g => (
            <FriendSection
              title={g.displayName}
              group={g.name}
              list={favs().filter(f => state.favTags[f.id]?.includes(g.name))}
              sort={sort()}
              reverse={reverse()}
            />
          )}
        </For>
      </Show>
      <FriendSection
        title="その他のフレンド"
        list={state.friends.filter(f => !(f.id in state.favTags))}
        sort={sort()}
        reverse={reverse()}
      />
    </>
  );
}

function InstancesTab() {
  const locs = () => sortBy([...byLoc().keys()], INSTANCE_SORTS[instanceSort()][1], instanceReverse());
  const privates = () => state.friends.filter(inPrivate);
  const outside = () => state.friends.filter(outsideGame);
  return (
    <>
      <div class="modes">
        <SortControl
          sorts={INSTANCE_SORTS}
          key={instanceSort()}
          setKey={setInstanceSort}
          reverse={instanceReverse()}
          setReverse={setInstanceReverse}
        />
      </div>
      <div class="grid">
        <For each={locs()}>{loc => <InstanceCard loc={loc} />}</For>
      </div>
      <div class="others">
        <h2>private ({privates().length})</h2>
        <div class="members">
          <For each={privates()}>{f => <Member f={f} />}</For>
        </div>
        <Show when={showOutside()}>
          <h2>Web・モバイル ({outside().length})</h2>
          <div class="members outside">
            <For each={outside()}>{f => <Member f={f} />}</For>
          </div>
        </Show>
      </div>
    </>
  );
}

export function App() {
  onMount(() => load().catch(e => setState('error', (e as Error).message)));
  const loading = () => state.progress.done < state.progress.total;
  const header = () => {
    if (!state.me) return '読み込み中…';
    if (!state.friends.length) return `${state.me} / フレンド一覧を取得中…`;
    const outside = state.friends.filter(outsideGame).length;
    const favs = state.friends.filter(f => f.id in state.favTags).length;
    return `${state.me} / オンライン ${state.friends.length} 人（ゲーム内 ${state.friends.length - outside} / Web・モバイル ${outside}、お気に入り ${favs}）/ インスタンス ${byLoc().size} か所`;
  };
  return (
    <>
      <Show when={state.loginRequired}>
        <div class="login-required">
          <p class="headline">VRChat にログインしていません</p>
          <p>vrchat.com でログインしてから、このページを再読み込みしてください。</p>
          <p>
            <a class="button primary" href="https://vrchat.com/home/login" target="_blank">
              vrchat.com でログイン
            </a>
            <button class="button" onClick={() => location.reload()}>
              再読み込み
            </button>
          </p>
          <p class="detail">{state.error}</p>
          <div class="notice">
            <p class="notice-title">⚠ VRC Social Overview は VRChat の非公式ツールです</p>
            <p>VRChat Inc. とは関係がなく、承認も受けていません。</p>
            <p>ログイン情報を本拡張に入力することはありません。vrchat.com のログイン状態をそのまま使います。</p>
          </div>
        </div>
      </Show>
      <Show when={!state.loginRequired}>
        <header>
          {state.error ? `エラー: ${state.error}` : header()}
          <Show when={state.live !== undefined}>
            <span class="live" classList={{ on: state.live }}>
              {state.live ? ' ● リアルタイム更新中' : ' ○ 再接続中…'}
            </span>
          </Show>
          <Show when={loading()}>
            <span class="progress-text">
              {' '}
              / 取得中 {state.progress.done} / {state.progress.total}
            </span>
          </Show>
        </header>
        <div class="progress" classList={{ active: loading() }}>
          <i style={{ width: `${(state.progress.done / Math.max(state.progress.total, 1)) * 100}%` }} />
        </div>
        <nav>
          <button aria-pressed={tab() === 'friends'} onClick={() => setTab('friends')}>
            フレンド
          </button>
          <button aria-pressed={tab() === 'instances'} onClick={() => setTab('instances')}>
            インスタンス
          </button>
          <button aria-pressed={tab() === 'log'} onClick={() => setTab('log')}>
            イベント ({state.eventLog.length})
          </button>
          <span class="outside-mode">
            Web・モバイルのフレンド:
            <label>
              <input
                type="radio"
                name="outsideMode"
                checked={outsideMode() === 'separate'}
                onChange={() => setOutsideMode('separate')}
              />{' '}
              分けて表示
            </label>
            <label>
              <input
                type="radio"
                name="outsideMode"
                checked={outsideMode() === 'hidden'}
                onChange={() => setOutsideMode('hidden')}
              />{' '}
              非表示
            </label>
          </span>
        </nav>
        <main>
          <Show when={tab() === 'friends'}>
            <FriendsTab />
          </Show>
          <Show when={tab() === 'instances'}>
            <InstancesTab />
          </Show>
          <Show when={tab() === 'log'}>
            <LogTab />
          </Show>
        </main>
        <Drawer />
      </Show>
    </>
  );
}
