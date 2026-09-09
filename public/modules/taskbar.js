// public/modules/taskbar.js — the furniture along the bottom of the screen.
//
// The clock and the task label say nothing a reader needs and stay hidden from
// assistive tech. The Start button is the exception: it opens a real menu, so
// it is a button, it takes focus, and Escape closes it.

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

/**
 * Start menu.
 *
 * Closes on Escape, on a click anywhere outside, and on choosing an item — a
 * menu that stays open after you pick something is what people mean when they
 * say a page feels broken.
 */
export function startMenu() {
  const button = document.getElementById("start-button");
  const menu = document.getElementById("start-menu");
  if (!button || !menu) return;

  const setOpen = (open) => {
    menu.classList.toggle("hidden", !open);
    button.setAttribute("aria-expanded", String(open));
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(menu.classList.contains("hidden"));
  });

  // Outside click and Escape both close. Listening on document rather than on
  // the menu is what makes "click anywhere else" work.
  document.addEventListener("click", (event) => {
    if (!menu.contains(event.target)) setOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    const pressed = event.code === "Escape" || event.keyCode === 27;
    if (pressed && !menu.classList.contains("hidden")) {
      setOpen(false);
      button.focus();
    }
  });

  // Picking anything closes the menu — except a click on the coffee button,
  // which opens its own window and should not also collapse the menu behind it.
  menu.addEventListener("click", (event) => {
    if (event.target.closest(".start-coffee")) return;
    setOpen(false);
  });
}
