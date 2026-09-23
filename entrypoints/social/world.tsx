import { createResource, For, Show } from 'solid-js';
import { ttlStore } from '@/lib/cache';
import { fetchWorld, img, worldStatus, type WorldDetail } from '@/lib/vrchat';
import { Img } from './cards';
import { Loaded } from './drawer';
import { openDrawer, setWorld } from './state';

// 現在人数のような流動的な項目は持たない。お気に入り数・訪問数はゆっくり増えるだけなので 1 日古くてよい
const WORLD_DETAIL_TTL = 24 * 60 * 60 * 1000;
type Detail = Omit<WorldDetail, 'unityPackages'> & { platforms: string[] };
const detailCache = ttlStore<Detail>('worldBodies', 300);

// 保存・表示に使う項目だけ残す
const pickDetail = (w: WorldDetail): Detail => ({
  id: w.id,
  name: w.name,
  description: w.description,
  authorId: w.authorId,
  authorName: w.authorName,
  capacity: w.capacity,
  recommendedCapacity: w.recommendedCapacity,
  imageUrl: w.imageUrl,
  thumbnailImageUrl: w.thumbnailImageUrl,
  releaseStatus: w.releaseStatus,
  tags: w.tags,
  publicationDate: w.publicationDate,
  labsPublicationDate: w.labsPublicationDate,
  updated_at: w.updated_at,
  platforms: [...new Set(w.unityPackages.map(u => u.platform))],
  favorites: w.favorites,
  visits: w.visits,
});

async function loadWorld(id: string) {
  const cached = detailCache.fresh(id, WORLD_DETAIL_TTL);
  if (cached) return cached;
  const w = await fetchWorld(id);
  // 一覧側のワールド情報も新しくなる
  setWorld(id, w);
  const d = pickDetail(w);
  detailCache.set(id, d);
  return d;
}

const PLATFORM_LABEL: Record<string, string> = { standalonewindows: 'PC', android: 'Android', ios: 'iOS' };

// 未公開だと日付の代わりに "none" が入る
const date = (s: string) => {
  const d = new Date(s);
  return isNaN(+d) ? undefined : d.toLocaleDateString('ja-JP');
};

export function WorldInfo(p: { id: string }) {
  const [data] = createResource(() => p.id, loadWorld);
  return (
    <>
      <Loaded data={data}>
        {d => (
          <>
            <Img class="world-image" src={img(d().imageUrl, 512)} />
            <div class="drawer-head">
              <div>
                <div class="name">
                  <Show when={worldStatus(d())}>{ws => <span title={ws()[1]}>{ws()[0]} </span>}</Show>
                  {d().name}
                </div>
                <div class="meta">
                  作者:{' '}
                  <span class="clickable" onClick={() => openDrawer(d().authorId)}>
                    {d().authorName}
                  </span>
                </div>
                <div class="meta">
                  <For each={d().platforms}>{pf => <span class="lang">{PLATFORM_LABEL[pf] ?? pf}</span>}</For>
                  <For each={d().tags.filter(t => t.startsWith('author_tag_'))}>
                    {t => <span class="lang">{t.slice('author_tag_'.length)}</span>}
                  </For>
                </div>
              </div>
            </div>
            <Show when={d().description}>
              <section class="drawer-section">
                <p>{d().description}</p>
              </section>
            </Show>
            <section class="drawer-section">
              <div>
                定員 {d().capacity} 人・推奨 {d().recommendedCapacity} 人
              </div>
              <div>
                お気に入り {d().favorites.toLocaleString()}・訪問 {d().visits.toLocaleString()}
              </div>
              <div class="meta">
                <Show when={date(d().publicationDate)}>{s => <>公開 {s()}・</>}</Show>
                <Show when={date(d().labsPublicationDate)}>{s => <>Labs {s()}・</>}</Show>
                更新 {date(d().updated_at)}
              </div>
            </section>
          </>
        )}
      </Loaded>
      <p>
        <a href={`https://vrchat.com/home/world/${p.id}`} target="_blank" rel="noopener noreferrer">
          vrchat.com でワールドを開く
        </a>
      </p>
    </>
  );
}
