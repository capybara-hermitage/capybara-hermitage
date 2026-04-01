let posts = [];
let selectedIdx = null;
const API_BASE = 'https://capybara-hermitage-backend.onrender.com';

let ADMIN_PASSWORD = localStorage.getItem('capy_admin_pwd') || '';
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = prompt('管理パスワードを入力してください');
  if(ADMIN_PASSWORD) localStorage.setItem('capy_admin_pwd', ADMIN_PASSWORD);
}

async function loadPosts() {
    try {
        const resp = await fetch(API_BASE + '/api/admin/posts', {
            headers: { 'x-admin-password': ADMIN_PASSWORD }
        });
        if(!resp.ok) {
            if(resp.status === 401) {
                alert("パスワードが間違っています。");
                localStorage.removeItem('capy_admin_pwd');
                location.reload();
            }
            throw new Error("Failed to load");
        }
        posts = await resp.json();
        renderInbox();
    } catch (e) {
        console.error('投稿取得エラー:', e);
        showToast('投稿の取得に失敗しました');
    }
}

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function() { t.classList.remove('show'); }, 2400);
}

/* --- TABS --- */
document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'stats-panel') renderStats();
    });
});

/* --- INBOX RENDER --- */
function renderInbox() {
    var inbox = document.getElementById('inbox');
    if (posts.length === 0) {
        inbox.innerHTML = '<div class="empty-state">まだ声は届いていない。<br>川は静かに、待っている。</div>';
        return;
    }
    inbox.innerHTML = posts.map(function(p, i) {
        var d = new Date(p.created_at);
        var timeStr = d.toLocaleString('ja-JP', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
        var replied = p.human_reply ? '✓返信済' : '未返信';
        return '<div class="post-card" data-idx="' + i + '">' +
            '<div class="meta"><span>' + timeStr + ' — ' + replied + '</span></div>' +
            '<div class="excerpt">' + escHtml(p.message) + '</div>' +
            '</div>';
    }).join('');

    document.querySelectorAll('.post-card').forEach(function(card) {
        card.addEventListener('click', function() { openReply(+card.dataset.idx); });
    });
}

function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* --- OPEN REPLY --- */
function openReply(idx) {
    selectedIdx = idx;
    var p = posts[idx];

    document.getElementById('selected-msg-text').textContent = p.message;
    document.getElementById('selected-msg-meta').textContent =
        new Date(p.created_at).toLocaleString('ja-JP') + '  受信';
    document.getElementById('selected-scores').innerHTML = '';

    document.getElementById('reply-editor').value = p.human_reply || '';
    
    // reset reply toggle
    var btn = document.getElementById('reply-from-toggle');
    btn.dataset.current = 'capy';
    btn.textContent = '🌿 カピバラより';
    btn.style.background = 'rgba(40,80,45,0.4)';

    // switch to reply view
    document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
    document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
    document.getElementById('reply-panel-wrap').classList.add('active');
}

/* --- SAVE REPLY --- */
document.getElementById('reply-from-toggle').addEventListener('click', function(e) {
    var btn = e.currentTarget;
    if (btn.dataset.current === 'capy') {
        btn.dataset.current = 'host';
        btn.textContent = '🏯 庵の主より';
        btn.style.background = 'rgba(60,40,20,0.4)';
    } else {
        btn.dataset.current = 'capy';
        btn.textContent = '🌿 カピバラより';
        btn.style.background = 'rgba(40,80,45,0.4)';
    }
});

document.getElementById('save-reply-btn').addEventListener('click', async function() {
    if (selectedIdx === null) return;
    var text = document.getElementById('reply-editor').value.trim();
    var replyFrom = document.getElementById('reply-from-toggle').dataset.current || 'capy';
    
    if (!text) { showToast('言葉が紡がれていません'); return; }
    
    var sendBtn = document.getElementById('save-reply-btn');
    sendBtn.disabled = true;

    try {
        var postId = posts[selectedIdx].id;
        await fetch(API_BASE + '/api/admin/posts/' + postId + '/reply', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-password': ADMIN_PASSWORD
            },
            body: JSON.stringify({ reply: text, replyFrom: replyFrom })
        });
        showToast(replyFrom === 'host' ? '庵の主より — 言葉を流しました' : 'カピバラより — 言葉を流しました');
        await loadPosts();
        goBack();
    } catch (err) {
        showToast('送信に失敗しました');
    } finally {
        sendBtn.disabled = false;
    }
});

/* --- BACK --- */
document.getElementById('back-btn').addEventListener('click', goBack);
function goBack() {
    selectedIdx = null;
    document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
    document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
    document.getElementById('inbox-panel').classList.add('active');
    document.querySelector('[data-tab="inbox-panel"]').classList.add('active');
}

/* --- STATS --- */
async function renderStats() {
    await loadPosts();
    document.getElementById('stat-total').textContent = posts.length;
    document.getElementById('stat-unreplied').textContent = posts.filter(function(p) { return !p.human_reply; }).length;
}

document.getElementById('save-slack-btn').addEventListener('click', async function() {
    var enabled = document.getElementById('slack-toggle').checked;
    var webhookUrl = document.getElementById('slack-webhook-url').value.trim();
    
    document.getElementById('save-slack-btn').disabled = true;
    try {
        await fetch(API_BASE + '/api/admin/settings/slack', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-password': ADMIN_PASSWORD
            },
            body: JSON.stringify({ enabled: enabled, webhookUrl: webhookUrl })
        });
        showToast(enabled ? 'Slack通知をオンにしました' : 'Slack通知をオフにしました');
    } catch(e) {
        showToast('設定の保存に失敗しました');
    } finally {
        document.getElementById('save-slack-btn').disabled = false;
    }
});

/* --- INIT --- */
loadPosts();
setInterval(loadPosts, 30000);
