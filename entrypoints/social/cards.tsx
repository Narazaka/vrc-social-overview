import { For, Show } from 'solid-js';
import { img, inWorld, instanceType, ownerIdOf, sizeClass, STATUS_COLOR, worldStatus, type Friend } from '@/lib/vrchat';
import { byLoc, instanceOf, ownerOf, state } from './state';

const Dot = (p: { f: Friend }) => <span class="dot" style={{ background: STATUS_COLOR[p.f.status] ?? '#999' }} />;

export function Member(p: { f: Friend }) {
  return (
    <div class="member" title={p.f.statusDescription}>
      <img loading="lazy" src={img(p.f.currentAvatarImageUrl, 64)} />
      <Dot f={p.f} />
      <span>{p.f.displayName}</span>
    </div>
  );
}

function Capacity(p: { n: number; cap: number }) {
  const ratio = () => Math.min(p.n / p.cap, 1);
  return (
    <span class="cap" title={`${p.n} / ${p.cap} 人`}>
      <span>
        <b class={sizeClass(p.n)}>{p.n}</b>/<b class={sizeClass(p.cap)}>{p.cap}</b>
      </span>
      <span class="bar">
        <i style={{ width: `${ratio() * 100}%` }} classList={{ full: ratio() >= 1, busy: ratio() >= 0.75 && ratio() < 1 }} />
      </span>
    </span>
  );
}

function InstanceHead(p: { loc: string; compact?: boolean }) {
  const type = () => instanceType(p.loc);
  const ownerId = () => ownerIdOf(p.loc);
  const inst = () => instanceOf(p.loc);
  const title = () => {
    const i = state.instances[p.loc];
    return !i ? '読み込み中…' : 'error' in i ? `取得失敗 (${i.error})` : i.world.name;
  };
  return (
    <div class="head" classList={{ compact: p.compact }}>
      <img class="thumb" loading="lazy" src={img(inst()?.world.thumbnailImageUrl, 128)} />
      <div>
        <div class="title">{title()}</div>
        <div class="meta">
          <span class={`badge ${type()[1]}`}>{type()[0]}</span>
          <Show when={inst()}>{i => <Capacity n={i().userCount} cap={i().capacity} />}</Show>
          <Show when={inst() && worldStatus(inst()!.world)}>{ws => <span class="wstat" title={ws()[1]}>{ws()[0]}</span>}</Show>
          <Show when={ownerId() ? ownerOf(ownerId()!) : undefined}>
            {o => (
              <span class="member owner">
                <img loading="lazy" src={img(o().image, 64)} />
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
    <section class="card">
      <div class="subject">
        <img loading="lazy" src={img(p.f.currentAvatarImageUrl, 128)} />
        <div>
          <div class="name">
            <Dot f={p.f} />
            {p.f.displayName}
          </div>
          <div class="meta">{[inWorld(p.f) ? '' : p.f.location, p.f.statusDescription].filter(Boolean).join(' / ')}</div>
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
