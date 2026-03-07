import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default {
  root: "dashboard",
  plugins: [tailwindcss()],
  optimizeDeps: {
    include: ["maplibre-gl"],
    esbuildOptions: {
      target: "es2022",
    },
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname)],
    },
  },
};
