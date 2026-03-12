import tailwindcss from "@tailwindcss/vite";

export default {
  plugins: [tailwindcss()],
  build: {
    target: "es2022",
  },
  optimizeDeps: {
    exclude: ["@duckdb/duckdb-wasm"],
  },
};
