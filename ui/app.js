/* 主题切换：默认跟随系统，手动选择后记住 */
(function(){
  var root = document.documentElement;
  var btn = document.getElementById('themeBtn');
  if (!btn) return;

  function paint(){
    var dark = root.getAttribute('data-theme') === 'dark';
    btn.innerHTML = dark
      ? '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
      : '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    btn.title = dark ? '切换到浅色' : '切换到深色';
    btn.setAttribute('aria-label', btn.title);
  }

  btn.addEventListener('click', function(){
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('pocket-theme', next); } catch (e) {}
    paint();
  });

  paint();

  try {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    var onChange = function(e){
      if (localStorage.getItem('pocket-theme')) return;   // 用户手动选过就不跟随
      root.setAttribute('data-theme', e.matches ? 'dark' : 'light');
      paint();
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (e) {}
})();
