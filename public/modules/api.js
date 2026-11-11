import { navigateTo } from "./router.js";

// Cached user info from /api/auth/me
let currentUser = null;

export function getCurrentUser() {
  return currentUser;
}

export async function fetchCurrentUser() {
  try {
    const data = await apiFetch("/api/auth/me");
    currentUser = data;
    return data;
  } catch {
    currentUser = null;
    return null;
  }
}

export async function apiFetch(url, options = {}) {
  const config = { ...options };
  config.credentials = "same-origin"; // Send cookies
  config.headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };

  if (config.body && typeof config.body !== "string") {
    config.headers["Content-Type"] =
      config.headers["Content-Type"] || "application/json";
    config.body = JSON.stringify(config.body);
  }

  // Remove manual Authorization headers (cookie handles auth now)
  delete config.headers.Authorization;

  try {
    const response = await fetch(url, config);
    const contentType = response.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const data = isJson ? await response.json() : null;

    if (!response.ok) {
      const message =
        data?.error ||
        data?.message ||
        `Request failed with status ${response.status}`;
      // The status and the body travel with the message: a screen that has to
      // tell «signed out» (401) from «too fast» (429) from a refusal with a
      // code cannot do it from English text.
      throw Object.assign(new Error(message), {
        status: response.status,
        code: data?.code || null,
        data,
      });
    }

    return data ?? {};
  } catch (error) {
    console.error("API request failed:", error);
    if (error.status) throw error;
    throw new Error(error.message || "Network error, please try again.");
  }
}

export async function logoutAndRedirect(target = "/") {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Ignore logout errors
  }
  currentUser = null;
  navigateTo(target);
}
