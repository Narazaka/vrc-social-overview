import { createEffect, createSignal, For, onCleanup, Show, untrack } from 'solid-js';
import { forgetImage, resolveImage } from '@/lib/cache';
import {
  img,
  inWorld,
  instanceType,
  ownerIdOf,
  sizeClass,
  STATUS_COLOR,
  worldIdOf,
  worldStatus,
  type Friend,
  outsideGame,
  placeIcon,
  openInGame,
} from '@/lib/vrchat';
import { canAnimate, Reorder } from './motion';
import { byLoc, favClass, instanceOf, openDrawer, ownerOf, requestAvatar, setShown, state, worldOf } from './state';

const OWNER_KIND_LABEL = {
  friend: 'オーナー（フレンド）',
  stranger: 'オーナー（フレンドではないユーザー）',
  'group-member': 'オーナー（加入しているグループ）',
  group: 'オーナー（加入していないグループ）',
};

// 要素が画面に近づいた・離れたことを知らせる。要素ごとに作ると数百個になるので 1 つを共有する
const onVisibility = new Map<Element, (visible: boolean) => void>();
const visibilityObserver = new IntersectionObserver(
  entries => {
    for (const e of entries) onVisibility.get(e.target)?.(e.isIntersecting);
  },
  { rootMargin: '300px' },
);
function watchVisibility(el: Element, fn: (visible: boolean) => void) {
  onVisibility.set(el, fn);
  visibilityObserver.observe(el);
  onCleanup(() => {
    visibilityObserver.unobserve(el);
    onVisibility.delete(el);
  });
}

const LAUNCH_TITLE = 'クリックでゲームで開く（招待は送りません）';

// インスタンス種別の表示が無い詳細パネル用
export const LaunchButton = (p: { loc: string }) => (
  <button class="launch" title={LAUNCH_TITLE} onClick={() => void openInGame(p.loc)}>
    ▶ ゲームで開く
  </button>
);

// 画面に近づいてから画像 URL を解決して表示する（画像 API へのアクセスを見えるものだけに絞る）。
// 画像 URL がまだ分からなければ onMissing で取得を頼む
export function Img(p: { src: string | undefined; class?: string; onMissing?: () => void }) {
  const [visible, setVisible] = createSignal(false);
  const [src, setSrc] = createSignal<string>();
  // どの段階にあるか（表示されないときに開発者ツールで data-img を見て切り分けるため）
  const [phase, setPhase] = createSignal('offscreen');
  const observe = (el: HTMLImageElement) => watchVisibility(el, v => v && setVisible(true));
  createEffect(() => {
    const url = p.src;
    if (!visible()) return;
    if (!url) {
      setPhase('no-url');
      return p.onMissing?.();
    }
    setPhase('resolving');
    let live = true;
    // 解決に失敗したら画像 API の URL をそのまま使う
    resolveImage(url).then(
      u => {
        if (!live) return;
        setPhase('resolved');
        setSrc(u);
      },
      () => {
        if (!live) return;
        setPhase('direct');
        setSrc(url);
      },
    );
    onCleanup(() => (live = false));
  });
  // 保存していたリダイレクト先が表示できなければ（署名 URL が使えなくなった等）、保存を捨てて画像 API の URL で取り直す
  const retry = () => {
    const url = p.src;
    if (!url || src() === url) return setPhase('error');
    setPhase('retry');
    forgetImage(url);
    setSrc(url);
  };
  return (
    <img
      ref={observe}
      class={p.class}
      src={src()}
      data-img={phase()}
      onLoad={() => setPhase('loaded')}
      onError={retry}
    />
  );
}

// ゲーム外（Web・モバイル）のフレンドは VRChat の慣例どおり輪郭だけの丸にする
export const Dot = (p: { f: Friend }) => (
  <span
    class="dot"
    classList={{ outside: outsideGame(p.f) }}
    style={{ '--status': STATUS_COLOR[p.f.status] ?? '#999' }}
  />
);

export function Member(p: { f: Friend }) {
  return (
    <div
      class={`member clickable ${favClass(p.f.id)}`}
      title={p.f.statusDescription}
      onClick={() => openDrawer(p.f.id)}
    >
      <Img src={img(p.f.currentAvatarImageUrl, 64)} onMissing={() => requestAvatar(p.f.id)} />
      <Dot f={p.f} />
      <span>{p.f.displayName}</span>
    </div>
  );
}

// cap はワールド情報がまだ無いと不明。stale は人数が未確定（前回の値やフレンドの増減からの推定で、取り直し待ち）
function Capacity(p: { n: number; cap: number | undefined; stale?: boolean }) {
  const ratio = () => (p.cap ? Math.min(p.n / p.cap, 1) : 0);
  // 人数が変わったら、増えたか減ったかの色で数字を一瞬大きくして知らせる
  let count: HTMLElement | undefined;
  let prev: number | undefined;
  createEffect(() => {
    const n = p.n;
    if (prev !== undefined && n !== prev && untrack(canAnimate))
      count?.animate([{ transform: 'scale(1.6)', color: n > prev ? '#43a047' : '#e53935' }, { transform: 'none' }], {
        duration: 900,
        easing: 'ease-out',
      });
    prev = n;
  });
  return (
    <span
      class="cap"
      classList={{ stale: p.stale }}
      title={`${p.n} / ${p.cap ?? '?'} 人${p.stale ? '（未確定・更新待ち）' : ''}`}
    >
      <span>
        <b ref={el => (count = el)} class={sizeClass(p.n)}>
          {p.n}
        </b>
        /<b class={p.cap ? sizeClass(p.cap) : ''}>{p.cap ?? '?'}</b>
      </span>
      <span class="bar">
        <i
          style={{ width: `${ratio() * 100}%` }}
          classList={{ full: ratio() >= 1, busy: ratio() >= 0.75 && ratio() < 1 }}
        />
      </span>
    </span>
  );
}

function InstanceHead(p: { loc: string; compact?: boolean }) {
  const type = () => instanceType(p.loc);
  const ownerId = () => ownerIdOf(p.loc);
  const inst = () => instanceOf(p.loc);
  // インスタンス取得前は保存済みのワールド情報で名前とサムネイルを出す
  const world = () => worldOf(p.loc);
  const openWorld = () => openDrawer(worldIdOf(p.loc));
  // 見えている間だけ人数などを取る対象にする（移動で loc が変われば付け替える）
  const [visible, setVisible] = createSignal(false);
  createEffect(() => {
    if (!visible()) return;
    const loc = p.loc;
    setShown(loc, true);
    onCleanup(() => setShown(loc, false));
  });
  const title = () => {
    const i = state.instances[p.loc];
    return i && 'error' in i ? `取得失敗 (${i.error})` : (world()?.name ?? '読み込み中…');
  };
  // サムネイルはゲームで開き、それ以外の部分はワールドの詳細を開く（作者・オーナーはそれぞれのプロフィール）
  return (
    <div
      class="head"
      classList={{ compact: p.compact }}
      ref={el => watchVisibility(el, setVisible)}
      onClick={openWorld}
    >
      <span
        class="clickable"
        title={LAUNCH_TITLE}
        onClick={e => {
          e.stopPropagation();
          void openInGame(p.loc);
        }}
      >
        <Img class={`thumb ws-${world() && worldStatus(world()!)?.[1]}`} src={img(world()?.thumbnailImageUrl, 128)} />
      </span>
      <div>
        <div class="title">
          {title()}
          <Show when={world()?.authorName}>
            {name => (
              <span
                class="author clickable"
                title="ワールドの作者"
                onClick={e => {
                  e.stopPropagation();
                  openDrawer(world()!.authorId!);
                }}
              >
                {name()}
              </span>
            )}
          </Show>
        </div>
        <div class="meta">
          <span class={`badge ${type()[1]}`}>{type()[0]}</span>
          <Show when={inst()}>{i => <Capacity n={i().userCount} cap={world()?.capacity} stale={i().stale} />}</Show>
          <Show when={ownerId() ? ownerOf(ownerId()!) : undefined}>
            {o => (
              <span
                class={`member owner clickable owner-${o().kind} ${o().kind === 'friend' ? favClass(ownerId()!) : ''}`}
                title={OWNER_KIND_LABEL[o().kind]}
                onClick={e => {
                  e.stopPropagation();
                  openDrawer(ownerId()!);
                }}
              >
                <Img src={img(o().image, 64)} />
                <Show when={o().kind === 'friend'}>
                  <Show when={o().friend} fallback={<span class="dot offline" title="オフライン" />}>
                    {f => <Dot f={f()} />}
                  </Show>
                </Show>
                {o().name}
              </span>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}

// インスタンスにいるフレンド以外の人数。人数を取得できていない間は出さない（自分がいれば自分も含む）
const nonFriendsIn = (loc: string) => {
  const i = instanceOf(loc);
  return i ? Math.max(i.userCount - (byLoc().get(loc)?.length ?? 0), 0) : 0;
};

function NonFriends(p: { loc: string }) {
  return (
    <Show when={nonFriendsIn(p.loc)}>
      {n => (
        <span class="non-friends" classList={{ stale: instanceOf(p.loc)?.stale }} title={`フレンド以外 ${n()} 人`}>
          他+{n()}
        </span>
      )}
    </Show>
  );
}

export function InstanceCard(p: { loc: string }) {
  const members = () => {
    const ownerId = ownerIdOf(p.loc);
    return (byLoc().get(p.loc) ?? []).toSorted((a, b) => +(b.id === ownerId) - +(a.id === ownerId));
  };
  return (
    <section class="card">
      <InstanceHead loc={p.loc} />
      {/* フレンドがいない（グループタブにだけ出る）インスタンスは人数だけで足りるので、他+N も出さない */}
      <Show when={members().length}>
        <div class="members">
          <Reorder>
            <For each={members()}>{f => <Member f={f} />}</For>
            <NonFriends loc={p.loc} />
          </Reorder>
        </div>
      </Show>
    </section>
  );
}

// 起点のフレンドを大きく出し、同じインスタンスにいる他のフレンドは付随情報として小さく出す
export function FriendCard(p: { f: Friend }) {
  const others = () => (inWorld(p.f) ? (byLoc().get(p.f.location) ?? []).filter(m => m.id !== p.f.id) : []);
  return (
    <section class="card" classList={{ outside: outsideGame(p.f) }}>
      {/* アバターはワールドにいればそのインスタンスをゲームで開き、それ以外の部分はプロフィールを開く */}
      <div class="subject" onClick={() => openDrawer(p.f.id)}>
        <span
          class="clickable"
          title={inWorld(p.f) ? LAUNCH_TITLE : undefined}
          onClick={e => {
            if (!inWorld(p.f)) return;
            e.stopPropagation();
            void openInGame(p.f.location);
          }}
        >
          <Img src={img(p.f.currentAvatarImageUrl, 128)} onMissing={() => requestAvatar(p.f.id)} />
        </span>
        <div>
          <div class="name">
            <Dot f={p.f} />
            {p.f.displayName}
          </div>
          <div class="meta">
            <Show when={!inWorld(p.f) && placeIcon(p.f)}>{icon => <span title={icon()[1]}>{icon()[0]}</span>}</Show>
            {p.f.statusDescription}
          </div>
        </div>
      </div>
      {/* 居場所（インスタンス情報と同居フレンド）は種別色の線を付けた枠にまとめ、起点フレンドの表示と混ざらないようにする */}
      <Show when={inWorld(p.f)}>
        <div class={`where ${instanceType(p.f.location)[1]}`}>
          <InstanceHead loc={p.f.location} compact />
          <Show when={others().length || nonFriendsIn(p.f.location)}>
            <div class="members small">
              <Reorder>
                <For each={others()}>{f => <Member f={f} />}</For>
                <NonFriends loc={p.f.location} />
              </Reorder>
            </div>
          </Show>
        </div>
      </Show>
    </section>
  );
}
