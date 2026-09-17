const loginPanel = document.querySelector('#loginPanel');
const appPanel = document.querySelector('#appPanel');
const logoutButton = document.querySelector('#logoutButton');
const reloadButton = document.querySelector('#reloadButton');
const loadMoreButton = document.querySelector('#loadMoreButton');
const postsEl = document.querySelector('#posts');
const statusEl = document.querySelector('#status');

let nextToken = null;

function showStatus(message, type = '') {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function formatDate(value) {
  if (!value) return '日時不明';
  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

function renderPost(post) {
  const article = document.createElement('article');
  article.className = 'post';
  article.dataset.id = post.id;

  const meta = document.createElement('div');
  meta.className = 'postMeta';
  meta.textContent = `${formatDate(post.created_at)} · ID: ${post.id}`;

  const text = document.createElement('div');
  text.className = 'postText';
  text.textContent = post.text || '(本文なし)';

  const actions = document.createElement('div');
  actions.className = 'postActions';

  const deleteButton = document.createElement('button');
  deleteButton.className = 'danger';
  deleteButton.textContent = 'この投稿を削除';
  deleteButton.addEventListener('click', async () => {
    if (!confirm('この投稿をXから削除します。よろしいですか？')) return;

    deleteButton.disabled = true;
    deleteButton.textContent = '削除中…';

    try {
      await api(`/api/posts/${encodeURIComponent(post.id)}`, { method: 'DELETE' });
      article.remove();
      showStatus(`投稿 ${post.id} を削除しました。`, 'success');
    } catch (error) {
      deleteButton.disabled = false;
      deleteButton.textContent = 'この投稿を削除';
      showStatus(`削除に失敗しました: ${error.message}`, 'error');
    }
  });

  actions.appendChild(deleteButton);
  article.append(meta, text, actions);
  return article;
}

async function loadProfile() {
  const response = await api('/api/me');
  const user = response.data;
  document.querySelector('#profileName').textContent = user.name || '名前なし';
  document.querySelector('#profileUsername').textContent = user.username ? `@${user.username}` : '';
  document.querySelector('#profileDescription').textContent = user.description || '';
  if (user.profile_image_url) {
    const image = document.querySelector('#profileImage');
    image.src = user.profile_image_url;
    image.classList.remove('hidden');
  }
}

async function loadPosts({ append = false, token = null } = {}) {
  if (!append) {
    postsEl.innerHTML = '';
    nextToken = null;
  }

  showStatus('Xから投稿を取得中…');
  reloadButton.disabled = true;
  loadMoreButton.disabled = true;

  try {
    const query = token ? `?pagination_token=${encodeURIComponent(token)}` : '';
    const response = await api(`/api/posts${query}`);
    const posts = response.data || [];

    if (!posts.length && !append) {
      showStatus('取得できる投稿がありません。', 'success');
    } else {
      showStatus(`${posts.length}件を取得しました。`, 'success');
    }

    for (const post of posts) postsEl.appendChild(renderPost(post));

    nextToken = response.meta?.next_token || null;
    loadMoreButton.classList.toggle('hidden', !nextToken);
  } catch (error) {
    showStatus(`投稿取得に失敗しました: ${error.message}`, 'error');
  } finally {
    reloadButton.disabled = false;
    loadMoreButton.disabled = false;
  }
}

async function start() {
  try {
    const session = await api('/api/session');
    if (!session.authenticated) return;

    loginPanel.classList.add('hidden');
    appPanel.classList.remove('hidden');
    logoutButton.classList.remove('hidden');

    await loadProfile();
    await loadPosts();
  } catch (error) {
    showStatus(`初期化に失敗しました: ${error.message}`, 'error');
  }
}

reloadButton.addEventListener('click', () => loadPosts());
loadMoreButton.addEventListener('click', () => loadPosts({ append: true, token: nextToken }));

logoutButton.addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  location.href = '/';
});

start();
