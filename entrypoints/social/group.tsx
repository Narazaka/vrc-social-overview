import { createResource, For, Show } from 'solid-js';
import { ttlStore } from '@/lib/cache';
import { fetchGroup, img, type Group } from '@/lib/vrchat';
import { Img } from './cards';
import { Loaded, safeUrl } from './drawer';
import { isMyGroup, openDrawer } from './state';

// 名前・説明・ルールなどは変わりにくく、メンバー数もゆっくりしか変わらないので 1 日使い回す。
// オンライン人数は流動的なので保存も表示もしない
const GROUP_TTL = 24 * 60 * 60 * 1000;
const groupCache = ttlStore<Group>('groupBodies', 300);

// 保存・表示に使う項目だけ残す
const pickGroup = (g: Group): Group => ({
  id: g.id,
  name: g.name,
  shortCode: g.shortCode,
  discriminator: g.discriminator,
  description: g.description,
  iconUrl: g.iconUrl,
  bannerUrl: g.bannerUrl,
  rules: g.rules,
  links: g.links,
  languages: g.languages,
  isVerified: g.isVerified,
  joinState: g.joinState,
  ownerId: g.ownerId,
  memberCount: g.memberCount,
});

async function loadGroup(id: string) {
  const cached = groupCache.fresh(id, GROUP_TTL);
  if (cached) return cached;
  const g = pickGroup(await fetchGroup(id));
  groupCache.set(id, g);
  return g;
}

const JOIN_STATE_LABEL: Record<string, string> = {
  open: '誰でも参加可',
  request: '申請制',
  invite: '招待制',
  closed: '募集停止',
};

export function GroupInfo(p: { id: string }) {
  const [data] = createResource(() => p.id, loadGroup);
  return (
    <>
      <Loaded data={data}>
        {g => (
          <>
            <Show when={g().bannerUrl}>
              <Img class="group-banner" src={img(g().bannerUrl, 512)} />
            </Show>
            <div class="drawer-head">
              <Img class="group-icon" src={img(g().iconUrl, 128)} />
              <div>
                <div class="name">
                  {g().name}
                  <Show when={g().isVerified}>
                    <span title="認証済みグループ"> ✔</span>
                  </Show>
                </div>
                <div class="meta">
                  {g().shortCode}.{g().discriminator}
                </div>
                <div class="meta">
                  メンバー {g().memberCount.toLocaleString()} 人・{JOIN_STATE_LABEL[g().joinState] ?? g().joinState}
                  <Show when={isMyGroup(g().id)}>・加入済み</Show>
                </div>
                <div class="meta">
                  <For each={g().languages}>{l => <span class="lang">{l.toUpperCase()}</span>}</For>
                </div>
                <div class="meta">
                  <span class="clickable" onClick={() => openDrawer(g().ownerId)}>
                    オーナーのプロフィール
                  </span>
                </div>
              </div>
            </div>
            <Show when={g().description}>
              <section class="drawer-section">
                <p>{g().description}</p>
              </section>
            </Show>
            <Show when={g().rules}>
              <section class="drawer-section">
                <h3>ルール</h3>
                <p>{g().rules}</p>
              </section>
            </Show>
            <Show when={g().links.length}>
              <section class="drawer-section">
                <h3>リンク</h3>
                <For each={g().links}>
                  {link => (
                    <Show when={safeUrl(link)} fallback={<div class="meta">{link}</div>}>
                      {u => (
                        <div>
                          <a href={u().href} target="_blank" rel="noopener noreferrer">
                            {u().host + u().pathname.replace(/\/$/, '')}
                          </a>
                        </div>
                      )}
                    </Show>
                  )}
                </For>
              </section>
            </Show>
          </>
        )}
      </Loaded>
      <p>
        <a href={`https://vrchat.com/home/group/${p.id}`} target="_blank" rel="noopener noreferrer">
          vrchat.com でグループを開く
        </a>
      </p>
    </>
  );
}
