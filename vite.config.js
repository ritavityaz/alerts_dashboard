import tailwindcss from "@tailwindcss/vite";

export default {
  plugins: [tailwindcss()],
  build: {
    target: "es2022",
    rollupOptions: {
      external: ["maplibre-gl"],
      output: {
        globals: {
          "maplibre-gl": "maplibregl",
        },
      },
    },
  },
};
