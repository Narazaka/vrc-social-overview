import { createSignal, For, onMount, Show } from 'solid-js';
import { inPrivate, inWorld, outsideGame, type Friend } from '@/lib/vrchat';
import { FriendCard, InstanceCard, Member } from './cards';
import { byLoc, instanceOf, load, setState, state } from './state';

type SortKey<T> = (x: T) => number;

// ゲーム外（Web・モバイル）のフレンドを別の行に分けて出すか、隠すか。開くたびに選び直さずに済むよう保存する
const OUTSIDE_KEY = 'outsideMode';
const [outsideMode, setOutsideModeSignal] = createSignal<'separate' | 'hidden'>(
  localStorage.getItem(OUTSIDE_KEY) === 'hidden' ? 'hidden' : 'separate',
);
const setOutsideMode = (mode: 'separate' | 'hidden') => {
  setOutsideModeSignal(mode);
  try {
    localStorage.setItem(OUTSIDE_KEY, mode);
  } catch {
    // 保存できなくても表示の切り替えはできる
  }
};
const showOutside = () => outsideMode() === 'separate';

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
} satisfies Record<string, [string, SortKey<Friend>]>;
const INSTANCE_SORTS = {
  friends: ['フレンド数', loc => byLoc().get(loc)!.length],
  users: ['現在人数', usersIn],
} satisfies Record<string, [string, SortKey<string>]>;

function SortControl<K extends string>(p: {
  sorts: Record<K, [string, unknown]>;
  key: K;
  setKey: (k: K) => void;
  reverse: boolean;
  setReverse: (r: boolean) => void;
}) {
  return (
    <span>
      並び:{' '}
      <select value={p.key} onChange={e => p.setKey(e.currentTarget.value as K)}>
        <For each={Object.entries(p.sorts) as [K, [string, unknown]][]}>
          {([k, [label]]) => <option value={k}>{label}</option>}
        </For>
      </select>{' '}
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
  const [favMode, setFavMode] = createSignal<'grouped' | 'mixed'>('grouped');
  const [key, setKey] = createSignal<keyof typeof FRIEND_SORTS>('default');
  const [reverse, setReverse] = createSignal(false);
  const favs = () => state.friends.filter(f => f.id in state.favTags);
  const sort = () => FRIEND_SORTS[key()][1];
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
        <SortControl sorts={FRIEND_SORTS} key={key()} setKey={setKey} reverse={reverse()} setReverse={setReverse} />
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
  const [key, setKey] = createSignal<keyof typeof INSTANCE_SORTS>('friends');
  const [reverse, setReverse] = createSignal(false);
  const locs = () => sortBy([...byLoc().keys()], INSTANCE_SORTS[key()][1], reverse());
  const privates = () => state.friends.filter(inPrivate);
  const outside = () => state.friends.filter(outsideGame);
  return (
    <>
      <div class="modes">
        <SortControl sorts={INSTANCE_SORTS} key={key()} setKey={setKey} reverse={reverse()} setReverse={setReverse} />
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
  const [tab, setTab] = createSignal<'friends' | 'instances'>('friends');
  onMount(() => load().catch(e => setState('error', (e as Error).message)));
  const header = () => {
    if (!state.me) return '読み込み中…';
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
        </div>
      </Show>
      <Show when={!state.loginRequired}>
        <header>{state.error ? `エラー: ${state.error}` : header()}</header>
        <nav>
          <button aria-pressed={tab() === 'friends'} onClick={() => setTab('friends')}>
            フレンド
          </button>
          <button aria-pressed={tab() === 'instances'} onClick={() => setTab('instances')}>
            インスタンス
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
          <Show when={tab() === 'friends'} fallback={<InstancesTab />}>
            <FriendsTab />
          </Show>
        </main>
      </Show>
    </>
  );
}
