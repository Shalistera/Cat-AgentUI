// Puts a "●" in the tab title when long-running work (chat reply, image
// generation) finishes while the tab is hidden or unfocused, and clears it
// the moment the user comes back. No-op when the tab is already active.
const BASE_TITLE = document.title;
let marked = false;

function clear() {
  if (!marked) return;
  marked = false;
  document.title = BASE_TITLE;
}

window.addEventListener('focus', clear);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') clear();
});

export function tabAlert() {
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  marked = true;
  document.title = `● ${BASE_TITLE}`;
}
