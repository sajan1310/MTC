// Lightweight console guard for silencing non-error logs in production.
// Enable verbose logs by setting `window.__UPF_DEBUG__ = true` before page load.
(function(){
  try {
    if (!window.__UPF_DEBUG__) {
      ['log','info'].forEach(function(fn){
        try { console[fn] = function(){}; } catch (e) {}
      });
    } else {
      try { console.debug && console.debug('[UPF DEBUG ENABLED]'); } catch (e) {}
    }
  } catch (e) {}
})();
