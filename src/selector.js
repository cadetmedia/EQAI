// Drag a rectangle over the frozen screenshot; report it back in CSS pixels.
const bg = document.getElementById('bg');
const sel = document.getElementById('sel');
const dim = document.getElementById('dim');

(async () => {
  bg.src = await window.api.getSelectorImage();
})();

let startX = 0;
let startY = 0;
let dragging = false;

function rectFromEvent(e) {
  const x = Math.min(startX, e.clientX);
  const y = Math.min(startY, e.clientY);
  const width = Math.abs(e.clientX - startX);
  const height = Math.abs(e.clientY - startY);
  return { x, y, width, height };
}

window.addEventListener('mousedown', (e) => {
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  dim.style.display = 'none'; // #sel's box-shadow now provides the dimming
  sel.style.display = 'block';
  Object.assign(sel.style, { left: startX + 'px', top: startY + 'px', width: '0px', height: '0px' });
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const r = rectFromEvent(e);
  Object.assign(sel.style, {
    left: r.x + 'px',
    top: r.y + 'px',
    width: r.width + 'px',
    height: r.height + 'px',
  });
});

window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  window.api.submitSelection(rectFromEvent(e));
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.submitSelection(null);
});
