const fs = require("fs").promises;
const path = require("path");
const matter = require("gray-matter");
const { marked } = require("marked");

const BLOG_DIR = path.join(__dirname, "..", "content", "blog");
const SUPPORTED_LANGS = ["en", "ko"];
const DEFAULT_LANG = "en";

// In-memory cache
const cache = new Map();

function normalizeLang(lang) {
  return SUPPORTED_LANGS.includes(lang) ? lang : DEFAULT_LANG;
}

function isValidSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*$/i.test(slug);
}

async function loadPost(slug, lang) {
  const normalized = normalizeLang(lang);
  const cacheKey = `${slug}.${normalized}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  if (!isValidSlug(slug)) {
    throw Object.assign(new Error("Invalid slug"), { statusCode: 400 });
  }

  const filePath = path.join(BLOG_DIR, `${slug}.${normalized}.md`);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(BLOG_DIR))) {
    throw Object.assign(new Error("Invalid path"), { statusCode: 400 });
  }

  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      // Fallback to default lang
      if (normalized !== DEFAULT_LANG) {
        return loadPost(slug, DEFAULT_LANG);
      }
      throw Object.assign(new Error("Post not found"), { statusCode: 404 });
    }
    throw err;
  }

  const { data, content } = matter(raw);
  const html = marked.parse(content);

  const post = {
    slug: data.slug || slug,
    title: data.title || slug,
    description: data.description || "",
    date: data.date || null,
    html,
  };

  cache.set(cacheKey, post);
  return post;
}

async function listPosts(lang) {
  const normalized = normalizeLang(lang);
  const cacheKey = `__list.${normalized}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  let files;
  try {
    files = await fs.readdir(BLOG_DIR);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  // Find unique slugs across all supported languages
  const slugs = new Set();
  const langPattern = new RegExp(`^(.+)\\.(${SUPPORTED_LANGS.join("|")})\\.md$`);
  for (const file of files) {
    const match = file.match(langPattern);
    if (match && isValidSlug(match[1])) {
      slugs.add(match[1]);
    }
  }

  const posts = [];
  for (const slug of slugs) {
    try {
      const post = await loadPost(slug, normalized);
      posts.push({
        slug: post.slug,
        title: post.title,
        description: post.description,
        date: post.date,
      });
    } catch {
      // Skip broken posts
    }
  }

  posts.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });

  cache.set(cacheKey, posts);
  return posts;
}

function clearCache() {
  cache.clear();
}

module.exports = {
  loadPost,
  listPosts,
  clearCache,
};
