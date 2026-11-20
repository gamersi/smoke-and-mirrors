// The output window has no logic of its own: the controller drives it directly.
// Tell the controller we are ready to be attached.
(function () {
  try {
    if (window.opener && typeof window.opener.__smOutputReady === 'function') {
      window.opener.__smOutputReady(window);
    }
  } catch (e) { /* controller gone: we stay transparent, the desktop shows through */ }
})();
