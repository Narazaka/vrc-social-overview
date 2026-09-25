import { createEffect, createMemo, For, onCleanup, onMount, Show } from 'solid-js';
import { img, inPrivate, inWorld, outsideGame, ownerIdOf, type Friend } from '@/lib/vrchat';
import { FriendCard, Img, InstanceCard, Member } from './cards';
import { LogTab } from './log';
import { Drawer } from './drawer';
import { animationsOn, motion, persisted, setMotion } from './settings';
import { byLoc, instanceOf, load, loadGroupInstances, openDrawer, ownerOf, setState, state, worldOf } from './state';

type SortKey<T> = (x: T) => number | string;

// 数値は大きい順、文字列は名前順（数字は数値として比べる）。キーが同じものは元の順（API が返した順）を保つ
const collator = new Intl.Collator('ja', { numeric: true });
const compare = (a: number | string, b: number | string) =>
  typeof a === 'string' && typeof b === 'string' ? collator.compare(a, b) : Number(b) - Number(a);
const sortBy = <T,>(list: T[], key: SortKey<T>, reverse: boolean) => {
  const sorted = list.toSorted((a, b) => compare(key(a), key(b)));
  return reverse ? sorted.toReversed() : sorted;
};

const usersIn = (loc: string) => instanceOf(loc)?.userCount ?? -1;
// ワールド情報がまだ無いものは名前順の最後に回す
const worldNameOf = (loc: string) => worldOf(loc)?.name ?? '\uffff';

const FRIEND_SORTS = {
  default: ['既定', () => 0],
  cohabit: ['同居フレンド数', f => (inWorld(f) ? byLoc().get(f.location)!.length : 0)],
  users: ['インスタンス人数', f => (inWorld(f) ? usersIn(f.location) : -1)],
  // ページを開いてから移動・オンラインになった順。開いた時点の居場所に居続けている人は後ろ
  moved: ['最近の移動', f => state.movedAt[f.id] ?? 0],
  name: ['名前', f => f.displayName],
  world: ['ワールド名', f => (inWorld(f) ? worldNameOf(f.location) : '')],
} satisfies Record<string, [string, SortKey<Friend>]>;
const INSTANCE_SORTS = {
  friends: ['フレンド数', loc => byLoc().get(loc)!.length],
  users: ['現在人数', usersIn],
  world: ['ワールド名', worldNameOf],
} satisfies Record<string, [string, SortKey<string>]>;
// グループタブ（グループの中のインスタンスの並び）
const GROUP_SORTS = {
  users: ['現在人数', usersIn],
  world: ['ワールド名', worldNameOf],
} satisfies Record<string, [string, SortKey<string>]>;

const keysOf = <K extends string>(o: Record<K, unknown>) => Object.keys(o) as K[];

// 表示設定（開き直しても保つ）
const [tab, setTab] = persisted<'friends' | 'instances' | 'groups' | 'log'>('tab', 'friends', [
  'friends',
  'instances',
  'groups',
  'log',
]);
// ゲーム外（Web・モバイル）のフレンドを別の行に分けて出すか、隠すか
const [outsideMode, setOutsideMode] = persisted<'separate' | 'hidden'>('outsideMode', 'separate', [
  'separate',
  'hidden',
]);
const showOutside = () => outsideMode() === 'separate';
// 配色。自動は OS の設定に従う
const THEMES = { dark: 'ダーク', light: 'ライト', system: '自動' };
const [theme, setTheme] = persisted('theme', 'dark', keysOf(THEMES));
const [favMode, setFavMode] = persisted<'grouped' | 'mixed'>('favMode', 'grouped', ['grouped', 'mixed']);
const [friendSort, setFriendSort] = persisted('friendSort', 'default', keysOf(FRIEND_SORTS));
const [friendReverse, setFriendReverse] = persisted<boolean>('friendReverse', false);
const [instanceSort, setInstanceSort] = persisted('instanceSort', 'friends', keysOf(INSTANCE_SORTS));
const [instanceReverse, setInstanceReverse] = persisted<boolean>('instanceReverse', false);
const [groupSort, setGroupSort] = persisted('groupSort', 'users', keysOf(GROUP_SORTS));
const [groupReverse, setGroupReverse] = persisted<boolean>('groupReverse', false);

// 並びが変わったとき（増減・並べ替え・移動）に、各要素を前の位置から今の位置へ滑らかに動かし（FLIP）、
// 新しく現れた要素はふわっと出し、消えた要素はその場でふわっと消す。変化がどこで起きたか目で追えるようにするため。
// 前の位置は、前回の変化の直後と、入れ物の大きさが変わったとき（折り返し位置の変化など）に測っておく
const REORDER_DURATION = 300;
type Box = { x: number; y: number; w: number; h: number };

// 消えた要素の複製を、消える前にあった位置へ重ねて薄れさせる（元の要素はもう DOM から外れている）
function fadeOutGhost(el: Element, at: Box) {
  const ghost = el.cloneNode(true) as HTMLElement;
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${at.x}px`,
    top: `${at.y}px`,
    width: `${at.w}px`,
    height: `${at.h}px`,
    margin: '0',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    zIndex: '5',
  });
  document.body.append(ghost);
  ghost.animate([{ opacity: 1 }, { opacity: 0 }], REORDER_DURATION);
  // 描画が止まっていてアニメーションが終わらなくても残らないよう、終わりはタイマーで決める
  setTimeout(() => ghost.remove(), REORDER_DURATION);
}

function animateReorder(container: HTMLElement) {
  let last = new Map<Element, Box>();
  const measure = () => {
    const base = container.getBoundingClientRect();
    last = new Map(
      [...container.children].map(el => {
        const r = el.getBoundingClientRect();
        return [el, { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }];
      }),
    );
  };
  // 画面外の要素は動かさない（数百枚あっても見えている分だけで済ませる）
  const onScreen = (y: number, h: number) => y < innerHeight && y + h > 0;
  const mutations = new MutationObserver(() => {
    const prev = last;
    // 動いている途中の要素は、その変位を含めずに今の位置を測る
    for (const el of container.children) for (const a of el.getAnimations()) a.cancel();
    measure();
    if (!animationsOn()) return;
    const base = container.getBoundingClientRect();
    for (const [el, before] of prev)
      if (!last.has(el) && onScreen(base.top + before.y, before.h))
        fadeOutGhost(el, { ...before, x: base.left + before.x, y: base.top + before.y });
    for (const [el, now] of last) {
      if (!onScreen(base.top + now.y, now.h)) continue;
      const before = prev.get(el);
      if (!before) el.animate([{ opacity: 0 }, { opacity: 1 }], REORDER_DURATION);
      else if (before.x !== now.x || before.y !== now.y)
        el.animate([{ transform: `translate(${before.x - now.x}px, ${before.y - now.y}px)` }, { transform: 'none' }], {
          duration: REORDER_DURATION,
          easing: 'ease-out',
        });
    }
  });
  mutations.observe(container, { childList: true });
  // 最初に表示されたときにも呼ばれるので、最初の位置もここで測る
  const resize = new ResizeObserver(measure);
  resize.observe(container);
  onCleanup(() => {
    mutations.disconnect();
    resize.disconnect();
  });
}

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
      <div class="grid" ref={animateReorder}>
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
      <div class="grid" ref={animateReorder}>
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

// グループのインスタンスの変化は Pipeline では届かないので、開き直したとき（前回から 1 分以上経っていれば）と、
// 開いている間は 5 分ごと（ページが隠れている間は除く）に取り直す
const GROUP_REOPEN_REFRESH = 60 * 1000;
const GROUP_AUTO_REFRESH = 5 * 60 * 1000;

function GroupsTab() {
  // ログイン直後に開いていた場合は自分の情報が取れてから取る
  createEffect(() => {
    if (state.me) void loadGroupInstances(GROUP_REOPEN_REFRESH);
  });
  const timer = setInterval(() => {
    if (!document.hidden) void loadGroupInstances(GROUP_AUTO_REFRESH);
  }, 60 * 1000);
  onCleanup(() => clearInterval(timer));
  return (
    <>
      <div class="modes">
        <button
          class="refresh"
          disabled={state.groupInstancesLoading || !state.me}
          onClick={() => void loadGroupInstances(0)}
        >
          {state.groupInstancesLoading ? '更新中…' : '更新'}
        </button>
        <SortControl
          sorts={GROUP_SORTS}
          key={groupSort()}
          setKey={setGroupSort}
          reverse={groupReverse()}
          setReverse={setGroupReverse}
        />
        <Show when={state.groupInstancesAt}>
          {at => <span>最終更新 {new Date(at()).toLocaleTimeString()}（開いている間は 5 分ごとに自動更新）</span>}
        </Show>
      </div>
      <GroupList />
    </>
  );
}

// 加入しているグループのインスタンスを、グループごとに人数の多い順で並べる
function GroupList() {
  const usersOf = (locs: string[]) => locs.reduce((n, loc) => n + Math.max(usersIn(loc), 0), 0);
  const locsOf = (groupId: string) =>
    sortBy(
      (state.groupInstances ?? []).filter(loc => ownerIdOf(loc) === groupId),
      GROUP_SORTS[groupSort()][1],
      groupReverse(),
    );
  const groups = createMemo(() =>
    [...new Set((state.groupInstances ?? []).map(loc => ownerIdOf(loc)!))].toSorted(
      (a, b) => usersOf(locsOf(b)) - usersOf(locsOf(a)),
    ),
  );
  return (
    <Show when={state.groupInstances} fallback={<p class="empty">読み込み中…</p>}>
      <Show when={groups().length} fallback={<p class="empty">加入しているグループのインスタンスはありません</p>}>
        <For each={groups()}>
          {groupId => (
            <section>
              <h2 class="group-title clickable" onClick={() => openDrawer(groupId)}>
                <Img src={img(ownerOf(groupId)?.image, 64)} />
                {ownerOf(groupId)?.name ?? groupId} ({locsOf(groupId).length})
              </h2>
              <div class="grid" ref={animateReorder}>
                <For each={locsOf(groupId)}>{loc => <InstanceCard loc={loc} />}</For>
              </div>
            </section>
          )}
        </For>
      </Show>
    </Show>
  );
}

export function App() {
  onMount(() => load().catch(e => setState('error', (e as Error).message)));
  createEffect(() => {
    const root = document.documentElement;
    if (theme() === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme();
  });
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
          <button aria-pressed={tab() === 'groups'} onClick={() => setTab('groups')}>
            グループ
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
          <label class="animation-toggle" title="並びの入れ替わりや人数の増減をアニメーションで見せる">
            <input type="checkbox" checked={motion()} onChange={e => setMotion(e.currentTarget.checked)} />{' '}
            変化のアニメーション
          </label>
          <span class="theme">
            テーマ:
            <span class="seg">
              <For each={keysOf(THEMES)}>
                {k => (
                  <button aria-pressed={theme() === k} onClick={() => setTheme(k)}>
                    {THEMES[k]}
                  </button>
                )}
              </For>
            </span>
          </span>
        </nav>
        <main>
          <Show when={tab() === 'friends'}>
            <FriendsTab />
          </Show>
          <Show when={tab() === 'instances'}>
            <InstancesTab />
          </Show>
          <Show when={tab() === 'groups'}>
            <GroupsTab />
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
