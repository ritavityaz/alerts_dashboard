import tailwindcss from "@tailwindcss/vite";

/**
 * Multi-locale build.
 *
 * Set VITE_LOCALE=he to build the Hebrew version.
 * The build script runs Vite twice: once for EN, once for HE.
 * Each build outputs to dist/<locale>/ with the correct <html lang dir>.
 *
 * In dev, defaults to EN.
 */

const locale = process.env.VITE_LOCALE || "en";
const dir = locale === "he" ? "rtl" : "ltr";

function localeHtmlPlugin() {
  return {
    name: "locale-html",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        // In dev, detect locale from the request URL (e.g. /he/ → "he")
        let activeLocale = locale;
        if (ctx.server && ctx.originalUrl) {
          const match = ctx.originalUrl.match(/^\/(en|he)(\/|$)/);
          if (match) activeLocale = match[1];
        }
        const activeDir = activeLocale === "he" ? "rtl" : "ltr";
        return html
          .replace(/<html\s+lang="[^"]*"/, `<html lang="${activeLocale}"`)
          .replace(/<html([^>]*?)>/, `<html$1 dir="${activeDir}">`);
      },
    },
    configureServer(server) {
      // Rewrite /en/* and /he/* to serve root index.html in dev
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/(en|he)(\/|$)/.test(req.url)) {
          req.url = req.url.replace(/^\/(en|he)/, "") || "/";
        }
        next();
      });
    },
  };
}

const isBuild = process.argv.includes("build");

export default {
  plugins: [localeHtmlPlugin(), tailwindcss()],
  base: isBuild ? `/${locale}/` : "/",
  build: {
    target: "es2022",
    outDir: `dist/${locale}`,
  },
  esbuild: {
    target: "es2022",
  },
  optimizeDeps: {
    exclude: ["@duckdb/duckdb-wasm"],
  },
};
