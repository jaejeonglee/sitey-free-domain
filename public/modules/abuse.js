// The report form on /abuse. The page and the form are rendered by the server
// (routes/pages.js, content/pages/abuse.*.md) — this only sends it without a
// page change. With JavaScript off, the browser posts the form itself and
// routes/abuse.js answers with a line of text.
//
// The messages come from the form's data-* attributes, so they are in the
// same language as the page the server chose.

export function initializeAbuseForm() {
    const form = document.getElementById("abuse-form");
    if (!form) return;
    const status = form.querySelector(".abuse-status");
    const button = form.querySelector('button[type="submit"]');

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());

        button.disabled = true;
        status.textContent = "";
        status.classList.remove("is-error");
        try {
            const res = await fetch("/api/abuse-reports", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data),
            });
            if (res.ok) {
                form.reset();
                status.textContent = form.dataset.sent;
                return;
            }
            const body = await res.json().catch(() => ({}));
            status.classList.add("is-error");
            status.textContent =
                res.status === 429 ? form.dataset.limited : body.error || form.dataset.failed;
        } catch {
            status.classList.add("is-error");
            status.textContent = form.dataset.failed;
        } finally {
            button.disabled = false;
        }
    });
}
