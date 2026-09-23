import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { resolveImage } from '@/lib/cache';
import {
  img,
  inWorld,
  instanceType,
  ownerIdOf,
  sizeClass,
  STATUS_COLOR,
  worldStatus,
  type Friend,
  outsideGame,
  placeIcon,
} from '@/lib/vrchat';
import { byLoc, favClass, instanceOf, openProfile, ownerOf, state, worldOf } from './state';

const OWNER_KIND_LABEL = {
  friend: 'オーナー（フレンド）',
  stranger: 'オーナー（フレンドではないユーザー）',
  'group-member': 'オーナー（加入しているグループ）',
  group: 'オーナー（加入していないグループ）',
};

// 画面に近づいてから画像 URL を解決して表示する（画像 API へのアクセスを見えるものだけに絞る）
export function Img(p: { src: string | undefined; class?: string }) {
  const [visible, setVisible] = createSignal(false);
  const [src, setSrc] = createSignal<string>();
  const observe = (el: HTMLImageElement) => {
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    io.observe(el);
    onCleanup(() => io.disconnect());
  };
  createEffect(() => {
    const url = p.src;
    if (!visible() || !url) return;
    let live = true;
    // 解決に失敗したら画像 API の URL をそのまま使う
    resolveImage(url).then(
      u => live && setSrc(u),
      () => live && setSrc(url),
    );
    onCleanup(() => (live = false));
  });
  return <img ref={observe} class={p.class} src={src()} />;
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
      onClick={() => openProfile(p.f.id)}
    >
      <Img src={img(p.f.currentAvatarImageUrl, 64)} />
      <Dot f={p.f} />
      <span>{p.f.displayName}</span>
    </div>
  );
}

// cap はワールド情報がまだ無いと不明。stale は前回の人数を取り直し中
function Capacity(p: { n: number; cap: number | undefined; stale?: boolean }) {
  const ratio = () => (p.cap ? Math.min(p.n / p.cap, 1) : 0);
  return (
    <span
      class="cap"
      classList={{ stale: p.stale }}
      title={`${p.n} / ${p.cap ?? '?'} 人${p.stale ? '（前回の人数・更新中）' : ''}`}
    >
      <span>
        <b class={sizeClass(p.n)}>{p.n}</b>/<b class={p.cap ? sizeClass(p.cap) : ''}>{p.cap ?? '?'}</b>
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
  const title = () => {
    const i = state.instances[p.loc];
    return i && 'error' in i ? `取得失敗 (${i.error})` : (world()?.name ?? '読み込み中…');
  };
  return (
    <div class="head" classList={{ compact: p.compact }}>
      <Img class="thumb" src={img(world()?.thumbnailImageUrl, 128)} />
      <div>
        <div class="title">
          <Show when={world() && worldStatus(world()!)}>
            {ws => (
              <span class="wstat" title={ws()[1]}>
                {ws()[0]}
              </span>
            )}
          </Show>
          {title()}
        </div>
        <div class="meta">
          <span class={`badge ${type()[1]}`}>{type()[0]}</span>
          <Show when={inst()}>{i => <Capacity n={i().userCount} cap={world()?.capacity} stale={i().stale} />}</Show>
          <Show when={ownerId() ? ownerOf(ownerId()!) : undefined}>
            {o => (
              <span
                class={`member owner owner-${o().kind} ${o().kind === 'friend' ? favClass(ownerId()!) : ''}`}
                classList={{ clickable: !o().kind.startsWith('group') }}
                title={OWNER_KIND_LABEL[o().kind]}
                onClick={() => !o().kind.startsWith('group') && openProfile(ownerId()!)}
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

export function InstanceCard(p: { loc: string }) {
  const members = () => {
    const ownerId = ownerIdOf(p.loc);
    return (byLoc().get(p.loc) ?? []).toSorted((a, b) => +(b.id === ownerId) - +(a.id === ownerId));
  };
  return (
    <section class="card">
      <InstanceHead loc={p.loc} />
      <div class="members">
        <For each={members()}>{f => <Member f={f} />}</For>
      </div>
    </section>
  );
}

// 起点のフレンドを大きく出し、同じインスタンスにいる他のフレンドは付随情報として小さく出す
export function FriendCard(p: { f: Friend }) {
  const others = () => (inWorld(p.f) ? (byLoc().get(p.f.location) ?? []).filter(m => m.id !== p.f.id) : []);
  return (
    <section class="card" classList={{ outside: outsideGame(p.f) }}>
      <div class="subject">
        <span class="clickable" onClick={() => openProfile(p.f.id)}>
          <Img src={img(p.f.currentAvatarImageUrl, 128)} />
        </span>
        <div>
          <div class="name clickable" onClick={() => openProfile(p.f.id)}>
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
          <Show when={others().length}>
            <div class="members small">
              <For each={others()}>{f => <Member f={f} />}</For>
            </div>
          </Show>
        </div>
      </Show>
    </section>
  );
}
