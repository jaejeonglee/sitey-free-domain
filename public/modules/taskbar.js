// public/modules/taskbar.js — the furniture along the bottom of the screen.
//
// None of it is a control: the Start button opens no menu and the tray clock
// is the reader's own clock. The markup is aria-hidden for that reason, and
// nothing in here takes focus or listens for a click.

/** Tray clock. Coarse on purpose — a wall clock, not a stopwatch. */
export function startClock() {
  const tray = document.getElementById("taskbar-clock");
  if (!tray) return;

  const tick = () => {
    tray.textContent = new Date().toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  };

  tick();
  setInterval(tick, 15000);
}

/** The task button carries the same title as the window's title bar. */
export function setWindowTitle(title) {
  const label = document.getElementById("taskbar-window");
  if (label) label.textContent = title;
}
