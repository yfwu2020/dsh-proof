/* PROOF 数据层：读 data.json（插件每次发送后重写） */
var KINDS = {
  web:   { label: '网页',   icon: '<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/>' },
  image: { label: '图片',   icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-4 4-2-2-4 4"/>' },
  video: { label: '视频',   icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/>' },
  doc:   { label: '文档',   icon: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>' },
  asset: { label: '产物',   icon: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 12l9 5 9-5M3 16l9 5 9-5"/>' },
  file:  { label: '文件',   icon: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>' }
};

async function loadData() {
  try {
    var r = await fetch('/data.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    return { projects: [], totals: {}, updated: null, error: String((e && e.message) || e) };
  }
}

function fmtBytes(n) {
  if (!n) return '0 KB';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function fmtAgo(ts) {
  if (!ts) return '—';
  var d = Math.floor(Date.now() / 1000) - ts;
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  return Math.floor(d / 86400) + ' 天前';
}

function icon(kind, size) {
  var k = KINDS[kind] || KINDS.file;
  return '<svg class="ico" viewBox="0 0 24 24" style="width:' + (size || 18) + 'px;height:' + (size || 18) + 'px" aria-hidden="true">' + k.icon + '</svg>';
}

function kindLabel(kind) { return (KINDS[kind] || KINDS.file).label; }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function title(s) {
  var t = String(s || '');
  return /^[a-z]/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function entryHref(project, relPath) {
  return '/' + project.dir + '/' + relPath.split('/').map(encodeURIComponent).join('/');
}
