import { createResource, For, onCleanup, onMount, Show } from 'solid-js';
import { ttlStore } from '@/lib/cache';
import { fetchNote, fetchProfile, img, trustRank, type Profile } from '@/lib/vrchat';
import { Dot, Img } from './cards';
import { friendsById, profileId, setProfileId } from './state';

// プロフィールは常時は出さず、ユーザーをクリックしたときだけ取得して右側のパネルに出す
const close = () => setProfileId(undefined);

// 自己紹介などの変わりにくい部分は、開くたびに取り直さないようしばらく使い回す
const PROFILE_TTL = 30 * 60 * 1000;
const profileCache = ttlStore<Profile>('profileBodies', 300);

// 保存するのは表示に使う変わりにくい項目だけ。API の応答を丸ごと保存すると、流動的な項目が紛れ込みうる
const stableProfile = (p: Profile): Profile => ({
  id: p.id,
  displayName: p.displayName,
  iconUrl: p.iconUrl,
  pronouns: p.pronouns,
  bio: p.bio,
  bioLinks: p.bioLinks,
  languages: p.languages,
  trustTags: p.trustTags,
  badges: p.badges.map(({ badgeName, badgeDescription, badgeImageUrl, showcased }) => ({
    badgeName,
    badgeDescription,
    badgeImageUrl,
    showcased,
  })),
  representedGroup: p.representedGroup && {
    id: p.representedGroup.id,
    name: p.representedGroup.name,
    iconUrl: p.representedGroup.iconUrl,
  },
});

// メモは短時間なら使い回してよい
const NOTE_TTL = 60 * 1000;
const noteCache = ttlStore<string>('notes', 300);

async function loadProfile(id: string) {
  const cachedProfile = profileCache.fresh(id, PROFILE_TTL);
  const cachedNote = noteCache.fresh(id, NOTE_TTL);
  const [profile, note] = await Promise.all([
    cachedProfile ??
      fetchProfile(id).then(p => {
        const stable = stableProfile(p);
        profileCache.set(id, stable);
        return stable;
      }),
    // フレンド以外だと取れないことがあるので、失敗しても本体は出す
    cachedNote ??
      fetchNote(id).then(
        n => {
          noteCache.set(id, n);
          return n;
        },
        () => '',
      ),
  ]);
  return { profile, note };
}

// 自己紹介のリンクは http(s) のものだけリンクにする
const safeUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : undefined;
  } catch {
    return undefined;
  }
};

export function ProfilePanel() {
  const [data] = createResource(profileId, loadProfile);
  const friend = () => friendsById().get(profileId() ?? '');
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  onMount(() => document.addEventListener('keydown', onKey));
  onCleanup(() => document.removeEventListener('keydown', onKey));

  return (
    <Show when={profileId()}>
      {id => (
        <div class="profile-backdrop" onClick={close}>
          <aside class="profile" onClick={e => e.stopPropagation()}>
            <button class="profile-close" title="閉じる" onClick={close}>
              ×
            </button>
            <Show when={!data.error} fallback={<p class="meta">取得できませんでした（{String(data.error)}）</p>}>
              {/* 読み込み中は前に開いた人の結果が残るので出さない */}
              <Show when={!data.loading && data()} fallback={<p class="meta">読み込み中…</p>}>
                {d => (
                  <>
                    <div class="profile-head">
                      <Img src={img(friend()?.currentAvatarImageUrl ?? d().profile.iconUrl, 256)} />
                      <div>
                        <div class="name">
                          <Show when={friend()}>{f => <Dot f={f()} />}</Show>
                          {d().profile.displayName}
                        </div>
                        <Show when={d().profile.pronouns}>
                          <div class="meta">{d().profile.pronouns}</div>
                        </Show>
                        <div class="meta">
                          <span class={`trust ${trustRank(d().profile.trustTags)[1]}`}>
                            {trustRank(d().profile.trustTags)[0]}
                          </span>
                          <For each={d().profile.languages}>{l => <span class="lang">{l.toUpperCase()}</span>}</For>
                        </div>
                        <Show when={friend()?.statusDescription}>{desc => <div class="meta">{desc()}</div>}</Show>
                      </div>
                    </div>
                    <Show when={d().note}>
                      <section class="profile-section note">
                        <h3>メモ</h3>
                        <p>{d().note}</p>
                      </section>
                    </Show>
                    <Show when={d().profile.bio}>
                      <section class="profile-section">
                        <h3>自己紹介</h3>
                        <p>{d().profile.bio}</p>
                      </section>
                    </Show>
                    <Show when={d().profile.bioLinks.length}>
                      <section class="profile-section">
                        <h3>リンク</h3>
                        <For each={d().profile.bioLinks}>
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
                    <Show when={d().profile.badges.some(b => b.showcased)}>
                      <section class="profile-section">
                        <h3>バッジ</h3>
                        <div class="badges">
                          <For each={d().profile.badges.filter(b => b.showcased)}>
                            {b => <img src={b.badgeImageUrl} title={`${b.badgeName}\n${b.badgeDescription}`} />}
                          </For>
                        </div>
                      </section>
                    </Show>
                    <Show when={d().profile.representedGroup}>
                      {g => (
                        <section class="profile-section">
                          <h3>所属グループ</h3>
                          <span class="member owner owner-group">
                            <Img src={img(g().iconUrl, 64)} />
                            {g().name}
                          </span>
                        </section>
                      )}
                    </Show>
                  </>
                )}
              </Show>
            </Show>
            <p>
              <a href={`https://vrchat.com/home/user/${id()}`} target="_blank" rel="noopener noreferrer">
                vrchat.com でプロフィールを開く
              </a>
            </p>
          </aside>
        </div>
      )}
    </Show>
  );
}
