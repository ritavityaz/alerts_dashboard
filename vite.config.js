import tailwindcss from "@tailwindcss/vite";

export default {
  plugins: [tailwindcss()],
  build: {
    target: "es2022",
  },
  optimizeDeps: {
    include: ["maplibre-gl"],
    esbuildOptions: {
      target: "es2022",
    },
  },
};
