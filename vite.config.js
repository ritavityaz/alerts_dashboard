import tailwindcss from "@tailwindcss/vite";

export default {
  plugins: [tailwindcss()],
  optimizeDeps: {
    include: ["maplibre-gl"],
    esbuildOptions: {
      target: "es2022",
    },
  },
};
